// uploadmymodel.com. Every request comes through here first (`run_worker_first`), like
// uploadmylaser's src/headers.ts:
//   1. http → https (301), and www.uploadmymodel.com → uploadmymodel.com.
//   2. /api/* is answered here. Everything else is the built student page in public/.
//   3. Every response gets the security headers below; HTML also gets the CSP.
//
// POST /api/slice does every check the real slicer will need (settings on the allowed lists and
// inside the teacher's locks, a sane STL that fits the bed, size limits, a safe file name) and then
// answers 501 until the slicing container exists (PLAN.md Phase 1). The page already handles the
// real answer: G-code bytes with a content-disposition file name.
//
// The teacher's class setup (which settings students may change, the class defaults, a note) lives
// in this app's own KV namespace under "class". GET /api/class is public; /api/teacher/* needs the
// TEACHER_KEY secret (npx wrangler secret put TEACHER_KEY). No secret set = no teacher access.

import {
  DEFAULT_CLASS_CONFIG, LIMITS, PRINTER, checkAgainstClass, formatMinutes, gcodeFileName, safeNamePart, summarize,
  toCuraOverrides, validateClassConfig, validateSettings,
} from '../shared/settings.js';
import { generatePhrase, normalizePhrase, validateOpenRequest } from '../shared/slicing.js';

const KV_CLASS = 'class';
const KV_SLICING = 'slicing'; // { phrase, until } while the teacher has slicing open
const MAX_TEACHER_BYTES = 4 * 1024;
const TEACHER_REJECT_DELAY_MS = 300;

const CANONICAL_HOST = 'uploadmymodel.com';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const COMMON_HEADERS = [
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  // serial=(self): the printer USB test page (and later "print from USB"); nothing else gets it.
  ['permissions-policy', 'serial=(self), usb=(), camera=(), microphone=(), geolocation=(), payment=()'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['x-robots-tag', 'noindex, nofollow'],
];

function isLocal(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

// Asset responses have immutable headers, so copy into a new Response first.
function withSecurityHeaders(response) {
  const copy = new Response(response.body, response);
  for (const [name, value] of COMMON_HEADERS) copy.headers.set(name, value);
  const type = (copy.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html') copy.headers.set('content-security-policy', CONTENT_SECURITY_POLICY);
  return copy;
}

// Where to send this request instead, or null to answer it. The port is dropped: Cloudflare's
// alternate http ports do not speak https.
function redirectTarget(requestUrl) {
  const url = new URL(requestUrl);
  const host = url.hostname.toLowerCase();
  const isWww = host === 'www.' + CANONICAL_HOST;
  if (!isWww && (url.protocol !== 'http:' || isLocal(host))) return null;
  url.protocol = 'https:';
  if (isWww) url.hostname = CANONICAL_HOST;
  url.port = '';
  return url.toString();
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Messages are shown to students as-is, so they are written for them.
function refuse(status, message, extra = {}) {
  return json(status, { error: 'refused', message, ...extra });
}

const encoder = new TextEncoder();

// Secret comparison that leaks nothing through timing: both sides hashed to 32 bytes, then
// Cloudflare's timingSafeEqual (same as uploadmylaser's src/constant-time.ts).
async function constantTimeEquals(a, b) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

// The saved class setup, or the open defaults if none is saved (or it no longer passes the
// checks, e.g. after a setting was removed from shared/settings.js).
async function readClassConfig(env) {
  try {
    const saved = await env.CLASS_KV?.get(KV_CLASS, 'json');
    if (saved) {
      const v = validateClassConfig(saved);
      if (v.ok) return v.config;
      console.error(JSON.stringify({ message: 'saved class setup no longer valid; using defaults', errors: v.errors }));
    }
  } catch (e) {
    console.error(JSON.stringify({ message: 'class setup read failed', error: String(e) }));
  }
  return DEFAULT_CLASS_CONFIG;
}

// The teacher's open slicing window, or null when closed (or run out).
async function readSlicing(env) {
  try {
    const rec = await env.CLASS_KV?.get(KV_SLICING, 'json');
    if (rec && typeof rec.phrase === 'string' && Number(rec.until) > Date.now()) return rec;
  } catch (e) {
    console.error(JSON.stringify({ message: 'slicing window read failed', error: String(e) }));
  }
  return null;
}

// Key compared first; a wrong key waits a moment (slows guessing). No secret uploaded means no
// teacher endpoint at all: never fall open. The key is long and random, so there is no lockout:
// a school shares one IP, and a lockout would let one student lock out the teacher.
async function teacherOk(request, env) {
  const expected = env.TEACHER_KEY ?? '';
  if (expected === '') {
    console.error(JSON.stringify({ message: 'TEACHER_KEY is not set; teacher endpoint refused' }));
  } else if (await constantTimeEquals(request.headers.get('x-teacher-key') ?? '', expected)) {
    return true;
  }
  await new Promise((r) => setTimeout(r, TEACHER_REJECT_DELAY_MS));
  return false;
}

async function handleTeacher(request, env, url, ctx) {
  if (!(await teacherOk(request, env))) return json(401, { error: 'key', message: 'Wrong teacher key.' });
  if (url.pathname === '/api/teacher/slicing') {
    if (request.method === 'GET') {
      const rec = await readSlicing(env);
      return json(200, { engine: !!slicerSender(env), open: !!rec, phrase: rec?.phrase ?? null, until: rec?.until ?? null, suggestion: generatePhrase() });
    }
    if (request.method === 'DELETE') {
      await env.CLASS_KV?.delete(KV_SLICING);
      return json(200, { open: false });
    }
    if (request.method !== 'PUT') return json(405, { error: 'method', message: 'Use GET, PUT or DELETE.' });
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(await request.arrayBuffer()).slice(0, MAX_TEACHER_BYTES));
    } catch {
      return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
    }
    const v = validateOpenRequest(body);
    if (!v.ok) return json(400, { error: 'invalid', message: 'Pick how long, and a phrase of 4 to 40 letters.', details: [v.error] });
    if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
    const until = Date.now() + v.minutes * 60_000;
    // KV forgets it by itself a minute after it runs out.
    await env.CLASS_KV.put(KV_SLICING, JSON.stringify({ phrase: v.phrase, until }), { expirationTtl: v.minutes * 60 + 60 });
    // Wake the slicer now, so the first student does not wait for it.
    const send = slicerSender(env);
    if (send) ctx?.waitUntil?.(send('/health', { method: 'GET' }).catch(() => {}));
    return json(200, { open: true, phrase: v.phrase, until, engine: !!send });
  }
  if (url.pathname === '/api/teacher/warmup') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    const send = slicerSender(env);
    if (!send) return json(501, { error: 'engine_not_ready', message: 'This site has no slicer connected yet.' });
    const t0 = Date.now();
    try {
      const r = await send('/health', { method: 'GET' });
      const body = await r.json();
      return json(r.ok ? 200 : 502, { ok: r.ok, engine: body.engine ?? null, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    } catch {
      return json(503, { error: 'slicer', message: 'The slicer did not answer. Try again in a minute.' });
    }
  }
  if (url.pathname !== '/api/teacher/class') return json(404, { error: 'not_found', message: 'No such API.' });
  if (request.method === 'GET') return json(200, await readClassConfig(env));
  if (request.method !== 'PUT') return json(405, { error: 'method', message: 'Use GET or PUT.' });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_TEACHER_BYTES) return json(413, { error: 'size', message: 'That is too much to save.' });
  const text = new TextDecoder().decode(bytes);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'json', message: 'The page sent something the server could not read.' });
  }
  const v = validateClassConfig(body);
  if (!v.ok) return json(400, { error: 'invalid', message: 'Some of those values are not allowed.', details: v.errors });
  if (!env.CLASS_KV) return json(503, { error: 'storage', message: 'Storage is not set up on this server.' });
  await env.CLASS_KV.put(KV_CLASS, JSON.stringify(v.config));
  return json(200, v.config);
}

/**
 * Check a binary STL made by the page (web/src/viewer.js exportPlateSTL): the length matches the
 * triangle count, every number is real, and every corner is inside the printer. The page checks
 * all of this too; the server does not trust it.
 */
export function checkPlateSTL(buf) {
  if (buf.byteLength < 84 + 50) return { ok: false, message: 'The model file is empty.' };
  const view = new DataView(buf);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== buf.byteLength) return { ok: false, message: 'The model file is damaged. Reload the page and try again.' };
  if (count > LIMITS.maxTriangles) return { ok: false, message: `The model has too much detail (${count} triangles, the most is ${LIMITS.maxTriangles}).` };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0, off = 84; t < count; t++, off += 50) {
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const n = view.getFloat32(off + 12 + v * 12 + a * 4, true);
        if (!Number.isFinite(n)) return { ok: false, message: 'The model file has broken numbers in it.' };
        if (n < min[a]) min[a] = n;
        if (n > max[a]) max[a] = n;
      }
    }
  }
  const m = PRINTER.edgeMarginMm - 0.01; // the page places to the margin; allow float rounding
  const tol = 0.01;
  const inside = min[0] >= m && min[1] >= m && max[0] <= PRINTER.bed.x - m && max[1] <= PRINTER.bed.y - m
    && min[2] >= -tol && max[2] <= PRINTER.bed.z + tol;
  if (!inside) return { ok: false, message: 'Part of the model is outside the printer. Move it back onto the bed.' };
  if (min[2] > 0.05) return { ok: false, message: 'The model is floating above the bed. Reload the page and try again.' };
  const size = [0, 1, 2].map((a) => Math.round((max[a] - min[a]) * 10) / 10);
  return { ok: true, triangles: count, size };
}

// How to reach the slicer: the Cloudflare Container (src/index.js puts slicerSend on env when the
// SLICER binding exists), or SLICER_URL for local dev (container running in Docker). null = none.
function slicerSender(env) {
  if (env.slicerSend) return env.slicerSend;
  if (env.SLICER_URL) return (path, init) => fetch(new URL(path, env.SLICER_URL), init);
  return null;
}

// Bill fuse for the slicer (Cloudflare rate-limit bindings, wrangler.jsonc): per browser, then for
// everyone. Keyed by the page's x-client-id, not the IP: a school shares one public IP. Only
// checked for requests that passed every other check, so mistakes never spend the budget.
async function slicerBudget(request, env) {
  const id = request.headers.get('x-client-id') ?? '';
  const key = /^[A-Za-z0-9-]{8,64}$/.test(id) ? `client ${id}` : `ip ${request.headers.get('cf-connecting-ip') ?? ''}`;
  if (env.SLICE_RATE && !(await env.SLICE_RATE.limit({ key })).success) {
    return refuse(429, 'You are slicing very fast. Wait a minute and try again.');
  }
  if (env.SLICE_RATE_ALL && !(await env.SLICE_RATE_ALL.limit({ key: 'everyone' })).success) {
    return refuse(429, 'The slicer is very busy right now. Wait a minute and try again.');
  }
  return null;
}

async function handleSlice(request, env) {
  // Browsers always send the length for a form upload; without it the whole body would be read
  // before any size check.
  if (!request.headers.has('content-length')) return refuse(411, 'The upload did not say how big it is. Reload and try again.');
  const length = Number(request.headers.get('content-length'));
  if (!(length >= 0) || length > LIMITS.maxUploadBytes + 64 * 1024) {
    return refuse(413, `That plate is too big to send (the most is ${LIMITS.maxUploadBytes / 1048576} MB).`);
  }
  // The class gate, only when a slicer is connected (without one there is nothing to open). It
  // comes before reading the upload, so a closed site does no work at all.
  if (slicerSender(env)) {
    const open = await readSlicing(env);
    if (!open) {
      return json(403, { error: 'closed', message: 'Slicing is closed right now. Your teacher opens it during class.' });
    }
    if (normalizePhrase(request.headers.get('x-class-phrase')) !== open.phrase) {
      return json(403, { error: 'phrase', message: "That class phrase is not right. Check the board and type it again." });
    }
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return refuse(400, 'The page sent something the server could not read. Reload and try again.');
  }

  let settingsInput;
  try {
    settingsInput = JSON.parse(String(form.get('settings') ?? '{}'));
  } catch {
    return refuse(400, 'The print settings could not be read. Reload and try again.');
  }
  const checked = validateSettings(settingsInput);
  if (!checked.ok) return refuse(400, 'Those print settings are not allowed. Press "Back to class settings" and try again.', { details: checked.errors });
  const classConfig = await readClassConfig(env);
  const locked = checkAgainstClass(checked.settings, classConfig);
  if (locked.length) {
    return refuse(400, `Your teacher has locked ${locked.join(', ')}. Reload the page to get the class settings.`, { locked });
  }

  const model = form.get('model');
  if (!model || typeof model === 'string') return refuse(400, 'No model was sent.');
  if (model.size > LIMITS.maxUploadBytes) return refuse(413, `That plate is too big (the most is ${LIMITS.maxUploadBytes / 1048576} MB).`);
  const stlBytes = await model.arrayBuffer();
  const stl = checkPlateSTL(stlBytes);
  if (!stl.ok) return refuse(400, stl.message);

  const fileName = gcodeFileName(form.get('fileName'), form.get('name'), form.get('modelName'));

  // The slicer (container/), if this deployment has one (see slicerSender).
  const send = slicerSender(env);
  if (send) {
    const tooFast = await slicerBudget(request, env);
    if (tooFast) return tooFast;
    const meshName = safeNamePart(form.get('modelName'), 'plate', LIMITS.maxFileNameLength);
    return sliceWithEngine(send, stlBytes, checked.settings, fileName, classConfig.maxPrintMinutes, meshName);
  }

  return json(501, {
    error: 'engine_not_ready',
    message: 'Your settings and model passed every check. The slicing engine is not connected yet.',
    fileName,
    summary: summarize(checked.settings),
    settings: checked.settings,
    cura: toCuraOverrides(checked.settings),
    model: { triangles: stl.triangles, sizeMm: stl.size },
  });
}

async function sliceWithEngine(send, stlBytes, settings, fileName, maxPrintMinutes = 0, meshName = 'plate') {
  let res;
  try {
    res = await send('/slice', {
      method: 'POST',
      body: stlBytes,
      headers: {
        'content-type': 'model/stl',
        'x-cura-settings': JSON.stringify(toCuraOverrides(settings)),
        'x-model-name': meshName, // written into the G-code as ";MESH:<name>.stl", like Cura
      },
    });
  } catch {
    return refuse(503, 'The slicer is not answering. Try again in a minute.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(JSON.stringify({ message: 'slicer refused', status: res.status, detail: detail.slice(0, 300) }));
    return refuse(502, 'The slicer could not slice this model. Check it in the 3D view, or ask your teacher.');
  }
  const time = Number(res.headers.get('x-print-time-s'));
  const grams = Number(res.headers.get('x-filament-g'));
  const layers = res.headers.get('x-layers');
  // The teacher's longest-print limit, checked against the slicer's own estimate.
  if (maxPrintMinutes && time > maxPrintMinutes * 60) {
    await res.body?.cancel();
    return refuse(400, `This print would take about ${formatMinutes(time / 60)}. Your teacher's limit is ${formatMinutes(maxPrintMinutes)}. `
      + 'Try Fast quality, less infill, or make the model smaller.', { tooLong: true, printMinutes: Math.round(time / 60) });
  }
  const summary = [time ? formatMinutes(time / 60) : null, grams ? `${Math.round(grams)} g of plastic` : null, layers ? `${layers} layers` : null]
    .filter(Boolean).join(' · ');
  // Read the whole file before answering: if the student closes the tab mid-download, the slicer
  // connection is already finished, not cut off. (A few MB; well inside Worker memory.)
  let gcode;
  try {
    gcode = await res.arrayBuffer();
  } catch {
    return refuse(502, 'The slicer stopped halfway. Try again.');
  }
  return new Response(gcode, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
      // Headers are Latin-1 only; "·" and friends go URL-encoded (the page decodes them).
      'x-print-summary': encodeURIComponent(summary),
    },
  });
}

async function handleApi(request, env, url, ctx) {
  if (url.pathname === '/api/health') return json(200, { ok: true, engine: !!slicerSender(env) });
  if (url.pathname === '/api/slicing') {
    // Public: is slicing open, and until when. Never the phrase.
    const rec = await readSlicing(env);
    return json(200, { engine: !!slicerSender(env), open: !!rec, until: rec?.until ?? null });
  }
  if (url.pathname === '/api/class') {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    return json(200, await readClassConfig(env));
  }
  // Everything under /api/teacher/ needs the key, even paths that do not exist.
  if (url.pathname.startsWith('/api/teacher/')) return handleTeacher(request, env, url, ctx);
  if (url.pathname === '/api/slice') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return handleSlice(request, env);
  }
  return json(404, { error: 'not_found', message: 'No such API.' });
}

export default {
  async fetch(request, env, ctx) {
    const target = redirectTarget(request.url);
    if (target !== null) {
      return withSecurityHeaders(new Response(null, { status: 301, headers: { location: target } }));
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await handleApi(request, env, url, ctx));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
