// The Worker's /api/slice with a fake slicer (fetch stubbed), so the server path is tested without
// Docker: G-code passes through with the right file name and summary, the teacher's limits and
// locks are enforced, and slicer trouble becomes a friendly refusal.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import worker from '../src/worker.js';
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

function sliceRequest(settings = {}, name = 'Jordan', modelName = 'Rocket Ship', phrase = 'Orange Walrus  Taco') {
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
