// uploadmymodel.com. Every request comes through here first (`run_worker_first`), like
// uploadmylaser's src/headers.ts:
//   1. http → https (301), and www.uploadmymodel.com → uploadmymodel.com.
//   2. /api/* is answered here. Everything else is the built student page in public/.
//   3. Every response gets the security headers below; HTML also gets the CSP.
//
// POST /api/slice does every check the real slicer will need (settings on the allowed lists, a
// sane STL that fits the bed, size limits, a safe file name) and then answers 501 until the
// slicing container exists (PLAN.md Phase 1). The page already handles the real answer: G-code
// bytes with a content-disposition file name.

import { LIMITS, PRINTER, safeNamePart, summarize, toCuraOverrides, validateSettings } from '../shared/settings.js';

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

async function handleSlice(request) {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > LIMITS.maxUploadBytes + 64 * 1024) {
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

async function handleApi(request, url) {
  if (url.pathname === '/api/health') return json(200, { ok: true, engine: false });
  if (url.pathname === '/api/slice') {
    if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use POST.' });
    return handleSlice(request);
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
    if (url.pathname.startsWith('/api/')) return withSecurityHeaders(await handleApi(request, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
