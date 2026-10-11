// Per-ADDRESS limit on WRONG teacher keys and WRONG "Assistant to the Regional Manager" passwords.
// The per-device lockout (lockout.js) counts by the page's own x-client-id, which a script can
// make up fresh for every guess, and the 300 ms wait after a wrong key does not slow guesses sent
// side by side. So every wrong key also counts against WRONG_KEY_RATE_IP (a Cloudflare rate-limit
// binding, wrangler.jsonc: 20 a minute per address). Only WRONG keys are counted: the binding is
// called after the compare has failed, never for a right key, so normal use never spends it.
//
// Over the limit, WRONG keys from that address get a 429 (countWrongKey). Every key is still compared,
// so the RIGHT key always works: a whole school shares one address, and a student must never be able
// to lock the teacher out (Dalton, 2026-09-28). The cost, accepted: a script can still tell right from
// wrong; the teacher keys are long random strings, so guessing them is not practical anyway.
// addressBlocked() is kept for a site that wants a hard block, but the Worker does not call it.

import { cacheStore } from './lockout.js';

export const BLOCK_S = 60;
const blockedHere = new Map(); // `${kind} ${address}` -> until (ms), this isolate only

function addressOf(request) {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

function storeFor(env) {
  if (env?.lockoutStore) return env.lockoutStore; // tests
  try {
    if (typeof caches !== 'undefined' && caches.default) return cacheStore(caches.default);
  } catch { /* no cache here */ }
  return null;
}

const cacheKey = (key) => `wrongkey/${encodeURIComponent(key)}`;

/** Whole seconds this address is still blocked for `kind` ('teacher' | 'arm'); 0 = not blocked. */
export async function addressBlocked(env, kind, request, now = Date.now()) {
  const key = `${kind} ${addressOf(request)}`;
  let until = blockedHere.get(key) ?? 0;
  if (!(until > now)) {
    blockedHere.delete(key);
    const store = storeFor(env);
    if (store) {
      try {
        until = Number((await store.get(cacheKey(key)))?.until) || 0;
      } catch (e) {
        console.error(JSON.stringify({ message: 'wrong-key block read failed; falling open', error: String(e) }));
      }
    }
  }
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/**
 * Count one WRONG key from this address. Returns the seconds the address is now blocked for (0 =
 * still under the limit). No binding (unit tests without one, local dev) = never blocks.
 */
export async function countWrongKey(env, kind, request, now = Date.now()) {
  const limiter = env?.WRONG_KEY_RATE_IP;
  if (!limiter) return 0;
  const key = `${kind} ${addressOf(request)}`;
  let over = false;
  try {
    over = !(await limiter.limit({ key })).success;
  } catch (e) {
    console.error(JSON.stringify({ message: 'wrong-key limit failed', error: String(e) }));
  }
  if (!over) return 0;
  const until = now + BLOCK_S * 1000;
  if (blockedHere.size > 10000) blockedHere.clear(); // many addresses: keep memory small
  blockedHere.set(key, until);
  const store = storeFor(env);
  if (store) {
    try {
      await store.put(cacheKey(key), { until });
    } catch (e) {
      console.error(JSON.stringify({ message: 'wrong-key block write failed', error: String(e) }));
    }
  }
  return BLOCK_S;
}

/** The 429 answer while an address is blocked, made with the site's json(status, body) helper. */
export function blockedResponse(json, seconds) {
  const res = json(429, {
    error: 'locked',
    retryAfter: seconds,
    message: `Too many wrong keys from your network. Wait ${seconds} seconds and try again.`,
  });
  res.headers.set('retry-after', String(seconds));
  return res;
}

/** Tests only: forget the in-memory blocks. */
export function resetKeyguard() {
  blockedHere.clear();
}
