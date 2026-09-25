// Holding page for uploadmymodel.com. Every request comes through here first
// (`run_worker_first`), like uploadmylaser's src/headers.ts:
//   1. http → https (301), and www.uploadmymodel.com → uploadmymodel.com.
//   2. Every response gets the security headers below; HTML also gets the CSP.

const CANONICAL_HOST = 'uploadmymodel.com';

// No scripts at all on the holding page, so script-src is 'none'.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
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

export default {
  async fetch(request, env) {
    const target = redirectTarget(request.url);
    if (target !== null) {
      return withSecurityHeaders(new Response(null, { status: 301, headers: { location: target } }));
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
