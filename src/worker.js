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
  DEFAULT_CLASS_CONFIG, LIMITS, PRINTER, checkAgainstClass, safeNamePart, summarize, toCuraOverrides,
  validateClassConfig, validateSettings,
} from '../shared/settings.js';

const KV_CLASS = 'class';
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
  ['permissions-policy', 'serial=(), usb=(), camera=(), microphone=(), geolocation=(), payment=()'],
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

async function handleTeacher(request, env, url) {
  if (!(await teacherOk(request, env))) return json(401, { error: 'key', message: 'Wrong teacher key.' });
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

async function handleSlice(request, env) {
  // Browsers always send the length for a form upload; without it the whole body would be read
  // before any size check.
  if (!request.headers.has('content-length')) return refuse(411, 'The upload did not say how big it is. Reload and try again.');
  const length = Number(request.headers.get('content-length'));
  if (!(length >= 0) || length > LIMITS.maxUploadBytes + 64 * 1024) {
    return refuse(413, `That plate is too big to send (the most is ${LIMITS.maxUploadBytes / 1048576} MB).`);
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
  const locked = checkAgainstClass(checked.settings, await readClassConfig(env));
  if (locked.length) {
    return refuse(400, `Your teacher has locked ${locked.join(', ')}. Reload the page to get the class settings.`, { locked });
  }

  const model = form.get('model');
  if (!model || typeof model === 'string') return refuse(400, 'No model was sent.');
  if (model.size > LIMITS.maxUploadBytes) return refuse(413, `That plate is too big (the most is ${LIMITS.maxUploadBytes / 1048576} MB).`);
  const stl = checkPlateSTL(await model.arrayBuffer());
  if (!stl.ok) return refuse(400, stl.message);

  const who = safeNamePart(form.get('name'), '');
  const what = safeNamePart(form.get('modelName'), 'model');
  const fileName = `${who ? `${who}-` : ''}${what}`.slice(0, 40).replace(/-$/, '') + '.gcode';

  // Phase 1: hand stl + toCuraOverrides(settings) + the frozen class profile to the slicing
  // container, check the estimates against the teacher's limits, stamp the header comment and
  // M117 name, and stream the G-code back as an attachment named fileName.
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

async function handleApi(request, env, url) {
  if (url.pathname === '/api/health') return json(200, { ok: true, engine: false });
  if (url.pathname === '/api/class') {
    if (request.method !== 'GET') return json(405, { error: 'method', message: 'Use GET.' });
    return json(200, await readClassConfig(env));
  }
  // Everything under /api/teacher/ needs the key, even paths that do not exist.
  if (url.pathname.startsWith('/api/teacher/')) return handleTeacher(request, env, url);
  if (url.pathname === '/api/slice') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return handleSlice(request, env);
  }
  return json(404, { error: 'not_found', message: 'No such API.' });
}

export default {
  async fetch(request, env) {
    const target = redirectTarget(request.url);
    if (target !== null) {
      return withSecurityHeaders(new Response(null, { status: 301, headers: { location: target } }));
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await handleApi(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
