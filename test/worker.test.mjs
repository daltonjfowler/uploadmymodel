// The Worker's /api/slice with a fake slicer (fetch stubbed), so the server path is tested without
// Docker: G-code passes through with the right file name and summary, the teacher's limits and
// locks are enforced, slicer trouble becomes a friendly refusal, and the class gate and the
// per-address limits hold.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import worker, { constantTimeEquals } from '../src/worker.js';
import { LineError } from '../src/line.js';
import { PRINTER } from '../shared/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function plateSTL() {
  const buf = new ArrayBuffer(84 + 50);
  const v = new DataView(buf);
  v.setUint32(80, 1, true);
  const mid = PRINTER.bed.x / 2;
  [[mid, mid, 0], [mid + 10, mid, 0], [mid, mid + 10, 10]].flat().forEach((n, i) => v.setFloat32(96 + i * 4, n, true));
  return buf;
}

const PHRASE = 'orange-walrus-taco';
const OPEN = { phrase: PHRASE, until: Date.now() + 3_600_000 };

// KV stand-in: the class setup under "class", the teacher's open window under "slicing".
function env({ config, slicer = 'http://slicer.test', slicing = OPEN } = {}) {
  const store = { class: config ?? null, slicing };
  return {
    SLICER_URL: slicer ?? undefined,
    CLASS_KV: { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = JSON.parse(v); }, delete: async (k) => { store[k] = null; } },
    ASSETS: { fetch: async () => new Response('asset') },
  };
}

const TICKET = 'abcdef12-3456-7890';

function sliceRequest(settings = {}, name = 'Jordan', modelName = 'Rocket Ship', phrase = 'Orange Walrus  Taco', ticket = TICKET) {
  const form = new FormData();
  form.append('model', new Blob([plateSTL()]), 'plate.stl');
  form.append('settings', JSON.stringify(settings));
  form.append('name', name);
  form.append('modelName', modelName);
  const body = new Request('https://uploadmymodel.com/api/slice', { method: 'POST', body: form });
  return body.arrayBuffer().then((bytes) => new Request('https://uploadmymodel.com/api/slice', {
    method: 'POST', body: bytes,
    headers: {
      'content-type': body.headers.get('content-type'), 'content-length': String(bytes.byteLength),
      ...(phrase ? { 'x-class-phrase': phrase } : {}),
      ...(ticket ? { 'x-slice-ticket': ticket } : {}),
      'cf-connecting-ip': '203.0.113.9',
    },
  }));
}

function fakeSlicer({ status = 200, timeS = 3600, grams = 12.3, layers = 200, gcode = ';FLAVOR:Marlin\nG28\n' } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status === 'down') throw new TypeError('connection refused');
    return new Response(status === 200 ? gcode : '{"error":"x"}', {
      status,
      headers: { 'x-print-time-s': String(timeS), 'x-filament-g': String(grams), 'x-layers': String(layers) },
    });
  };
  return calls;
}

test('G-code comes back as a download with a safe name and a summary', async () => {
  const calls = fakeSlicer({ timeS: 6420, grams: 12.14, layers: 221 });
  const res = await worker.fetch(await sliceRequest({ infillDensity: 25 }), env());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ';FLAVOR:Marlin\nG28\n');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="jordan-rocket-ship.gcode"');
  assert.equal(decodeURIComponent(res.headers.get('x-print-summary')), '1 h 47 min · 12 g of plastic · 221 layers');
  // The slicer got the checked settings as Cura keys, and the STL untouched.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://slicer.test/slice');
  const cura = JSON.parse(calls[0].init.headers['x-cura-settings']);
  assert.equal(cura.infill_sparse_density, 25);
  assert.equal(cura.support_infill_rate, 0);
  assert.equal(calls[0].init.body.byteLength, 134);
});

test("a print longer than the teacher's limit is refused with a hint", async () => {
  fakeSlicer({ timeS: 3 * 3600 + 600 });
  const res = await worker.fetch(await sliceRequest(), env({ config: { maxPrintMinutes: 120 } }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.tooLong, true);
  assert.equal(body.message, "This print would take about 3 h 10 min. Your teacher's limit is 2 h. Try Fast quality, less infill, or make the model smaller.");
});

test('under the limit is fine', async () => {
  fakeSlicer({ timeS: 100 * 60 });
  const res = await worker.fetch(await sliceRequest(), env({ config: { maxPrintMinutes: 120 } }));
  assert.equal(res.status, 200);
});

test('a slicer that stops mid-file is a refusal, not a broken download', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(';FLAVOR')); c.error(new Error('connection lost')); },
  }), { headers: { 'x-print-time-s': '60' } });
  const res = await worker.fetch(await sliceRequest(), env());
  assert.equal(res.status, 502);
  assert.match((await res.json()).message, /stopped halfway/);
});

test('slicer failures become friendly refusals', async () => {
  fakeSlicer({ status: 500 });
  let res = await worker.fetch(await sliceRequest(), env());
  assert.equal(res.status, 502);
  assert.match((await res.json()).message, /could not slice this model/);
  fakeSlicer({ status: 'down' });
  res = await worker.fetch(await sliceRequest(), env());
  assert.equal(res.status, 503);
  assert.match((await res.json()).message, /not answering/);
});

test("locked settings are refused before the slicer is ever asked", async () => {
  const calls = fakeSlicer();
  const res = await worker.fetch(await sliceRequest({ walls: 4 }), env({ config: { open: { walls: false }, defaults: { walls: 2 } } }));
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).locked, ['Wall count']);
  assert.equal(calls.length, 0);
});

test('fair-use limits: per browser first, then for everyone', async () => {
  fakeSlicer();
  const seen = [];
  const limiter = (ok) => ({ limit: async ({ key }) => { seen.push(key); return { success: ok }; } });
  let e = { ...env(), SLICE_RATE: limiter(false), SLICE_RATE_ALL: limiter(true) };
  let req = await sliceRequest();
  req.headers.set('x-client-id', 'abcdef12-3456');
  let res = await worker.fetch(req, e);
  assert.equal(res.status, 429);
  assert.match((await res.json()).message, /slicing very fast/);
  assert.deepEqual(seen, ['client abcdef12-3456']);
  e = { ...env(), SLICE_RATE: limiter(true), SLICE_RATE_ALL: limiter(false) };
  res = await worker.fetch(await sliceRequest(), e);
  assert.equal(res.status, 429);
  assert.match((await res.json()).message, /very busy/);
});

test('the container path (slicerSend) is used when present', async () => {
  const calls = [];
  const e = { ...env({ slicer: null }), slicerSend: async (path, init) => { calls.push(path); return new Response('G1', { headers: { 'x-print-time-s': '60' } }); } };
  const res = await worker.fetch(await sliceRequest(), e);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['/slice']);
});

test('class gate: closed, wrong phrase, and run-out windows never reach the slicer', async () => {
  const calls = fakeSlicer();
  let res = await worker.fetch(await sliceRequest(), env({ slicing: null }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'closed');
  res = await worker.fetch(await sliceRequest({}, 'J', 'M', 'purple-walrus-taco'), env());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'phrase');
  res = await worker.fetch(await sliceRequest({}, 'J', 'M', ''), env());
  assert.equal(res.status, 403);
  res = await worker.fetch(await sliceRequest(), env({ slicing: { phrase: PHRASE, until: Date.now() - 1000 } }));
  assert.equal((await res.json()).error, 'closed');
  assert.equal(calls.length, 0);
});

test('public status says open or closed, never the phrase', async () => {
  let res = await worker.fetch(new Request('https://uploadmymodel.com/api/slicing'), env());
  let body = await res.json();
  assert.equal(body.open, true);
  assert.equal(body.engine, true);
  assert.equal('phrase' in body, false);
  assert.equal(JSON.stringify(body).includes(PHRASE), false);
  res = await worker.fetch(new Request('https://uploadmymodel.com/api/slicing'), env({ slicing: null }));
  assert.equal((await res.json()).open, false);
});

test('without SLICER_URL the answer is still 501 (the live site today)', async () => {
  const calls = fakeSlicer();
  const res = await worker.fetch(await sliceRequest(), env({ slicer: null }));
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, 'engine_not_ready');
  assert.equal(calls.length, 0);
});

// ---- The class gate and the per-address limits -----------------------------------------------

// A Cloudflare rate-limit binding stand-in: `limit` tries per key, then no.
function limiter(limit) {
  const counts = new Map();
  const seen = [];
  return {
    seen,
    limit: async ({ key }) => {
      seen.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= limit };
    },
  };
}

test('phrase compare: constant time, and still right', async () => {
  assert.equal(await constantTimeEquals('orange-walrus-taco', 'orange-walrus-taco'), true);
  assert.equal(await constantTimeEquals('orange-walrus-tacp', 'orange-walrus-taco'), false);
  assert.equal(await constantTimeEquals('', 'orange-walrus-taco'), false);
  assert.equal(await constantTimeEquals('orange-walrus-taco-and-more', 'orange-walrus-taco'), false);
});

test('every phrase try counts against the address BEFORE the phrase is checked', async () => {
  const calls = fakeSlicer();
  const perIp = limiter(2);
  const e = { ...env(), SLICE_RATE_IP: perIp };
  // Two wrong guesses are counted (and refused as wrong)...
  for (const guess of ['purple-walrus-taco', 'green-walrus-taco']) {
    const res = await worker.fetch(await sliceRequest({}, 'J', 'M', guess), e);
    assert.equal((await res.json()).error, 'phrase');
  }
  // ...so the third try is refused without being compared at all, even the right phrase.
  const res = await worker.fetch(await sliceRequest(), e);
  assert.equal(res.status, 429);
  assert.match((await res.json()).message, /A lot of slicing is coming from your school/);
  assert.deepEqual(perIp.seen, ['ip 203.0.113.9', 'ip 203.0.113.9', 'ip 203.0.113.9']);
  assert.equal(calls.length, 0);
});

test('made-up browser ids do not get round the per-address limit', async () => {
  fakeSlicer();
  const e = { ...env(), SLICE_RATE: limiter(6), SLICE_RATE_ALL: limiter(1000), SLICE_RATE_IP: limiter(3) };
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const req = await sliceRequest();
    req.headers.set('x-client-id', `made-up-id-${i}`);
    statuses.push((await worker.fetch(req, e)).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test("the per-address slice limit is the site's limit, never tighter (a school shares one address)", () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const limitOf = (name) => Number(new RegExp(`"name": "${name}".*?"limit": (\\d+), "period": 60`).exec(text)?.[1]);
  assert.equal(limitOf('SLICE_RATE_ALL'), 60);
  assert.equal(limitOf('SLICE_RATE_IP'), limitOf('SLICE_RATE_ALL'));
  // The polled endpoints: a whole line (80 waiting + 2 slicing) asking every 2 s, and then some.
  assert.ok(limitOf('API_RATE_IP') >= 82 * 30, 'API_RATE_IP covers a full line polling');
  const ids = [...text.matchAll(/"namespace_id": "(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'rate-limit namespace ids are unique');
  assert.match(text, /"compatibility_flags": \["enable_request_signal"\]/);
});

test('a page without a ticket (an old cached page) is told to reload', async () => {
  const calls = fakeSlicer();
  for (const ticket of [null, 'x']) {
    const res = await worker.fetch(await sliceRequest({}, 'J', 'M', 'Orange Walrus Taco', ticket), env());
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.reload, true);
    assert.equal(body.message, 'This page is out of date. Reload the page, then press Slice again.');
  }
  assert.equal(calls.length, 0);
});

test('slicing closed while the student waited in line says so', async () => {
  const e = { ...env({ slicer: null }) };
  e.slicerSend = async () => { await e.CLASS_KV.delete('slicing'); throw new LineError('left'); };
  const res = await worker.fetch(await sliceRequest(), e);
  assert.equal(res.status, 403);
  assert.match((await res.json()).message, /Slicing closed while you were in line/);
  const open = { ...env({ slicer: null }), slicerSend: async () => { throw new LineError('left'); } };
  assert.equal((await worker.fetch(await sliceRequest(), open)).status, 409);
});

test("a plate that runs out the slicer's time gets advice, not a shrug", async () => {
  globalThis.fetch = async () => new Response('{"error": "slicing took too long"}', { status: 500 });
  const res = await worker.fetch(await sliceRequest(), env());
  assert.equal(res.status, 502);
  assert.match((await res.json()).message, /takes too long to slice. Try fewer models/);
});

function lineEnv(slicing = OPEN) {
  const asked = [];
  return {
    asked,
    env: {
      ...env({ slicing }),
      sliceLineStatus: async (t) => { asked.push(['status', t]); return { state: 'waiting', ahead: 0 }; },
      sliceLineCancel: async (t) => { asked.push(['cancel', t]); },
    },
  };
}
const lineUrl = `https://uploadmymodel.com/api/slice/line?ticket=${TICKET}`;

test('place in line: never reaches the line while slicing is closed', async () => {
  const closed = lineEnv(null);
  let res = await worker.fetch(new Request(lineUrl), closed.env);
  assert.deepEqual(await res.json(), { state: 'none' });
  res = await worker.fetch(new Request(lineUrl, { method: 'DELETE' }), closed.env);
  assert.deepEqual(await res.json(), { state: 'none' });
  assert.deepEqual(closed.asked, []);
  const open = lineEnv();
  res = await worker.fetch(new Request(lineUrl), open.env);
  assert.equal((await res.json()).state, 'waiting');
  await worker.fetch(new Request(lineUrl, { method: 'DELETE' }), open.env);
  assert.deepEqual(open.asked, [['status', TICKET], ['cancel', TICKET]]);
  // No ticket, no line.
  res = await worker.fetch(new Request('https://uploadmymodel.com/api/slice/line'), open.env);
  assert.equal(res.status, 400);
  assert.equal(open.asked.length, 2);
});

test('the polled endpoints share one per-address limit; health does not', async () => {
  const perIp = limiter(3);
  const { env: e, asked } = lineEnv();
  e.API_RATE_IP = perIp;
  const get = (path) => worker.fetch(new Request(`https://uploadmymodel.com${path}`, { headers: { 'cf-connecting-ip': '198.51.100.7' } }), e);
  assert.equal((await get('/api/class')).status, 200);
  assert.equal((await get('/api/slicing')).status, 200);
  assert.equal((await get(`/api/slice/line?ticket=${TICKET}`)).status, 200);
  for (const path of ['/api/class', '/api/slicing', `/api/slice/line?ticket=${TICKET}`]) {
    const res = await get(path);
    assert.equal(res.status, 429, path);
    assert.match((await res.json()).message, /Too many requests/);
  }
  assert.equal(asked.length, 1); // the refused line request never reached the line
  assert.equal((await get('/api/health')).status, 200);
  assert.deepEqual(new Set(perIp.seen), new Set(['ip 198.51.100.7']));
});

test('teacher: a short phrase is refused with a clear message; suggestions are long enough', async () => {
  const e = { ...env(), TEACHER_KEY: 'test-teacher-key-123' };
  const teacher = (method, body) => worker.fetch(new Request('https://uploadmymodel.com/api/teacher/slicing', {
    method,
    headers: { 'x-teacher-key': 'test-teacher-key-123', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), e);
  let res = await teacher('PUT', { phrase: 'blue robot', minutes: 50 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /needs 12 to 40 letters or numbers, so students cannot guess it\. Press "New phrase"/);
  res = await teacher('GET');
  const { suggestion } = await res.json();
  assert.match(suggestion, /^[a-z]+-[a-z]+-[a-z]+-[1-9][0-9]$/);
  res = await teacher('PUT', { phrase: suggestion, minutes: 50 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).phrase, suggestion);
});
