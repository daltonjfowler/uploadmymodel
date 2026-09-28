// Wrong-guess lockout for the class phrase and the teacher key (Dalton: "x attempts, lock 5
// seconds"). Per client address (CF-Connecting-IP) and per secret kind ('phrase', 'teacher'):
//   - 5 wrong tries in a row lock that address for 5 s.
//   - While locked, every try is refused WITHOUT comparing the secret.
//   - Each further wrong try after a lock ends doubles the lock: 5, 10, 20, 40, 80, 160, then 300 s.
//   - A right answer from that address clears its counter.
// The counter lives in the Cache API (caches.default, per data centre), not KV: it is free and has
// no write quota. Every storage call is wrapped: if the cache fails (or does not exist, as in the
// node unit tests), the lockout falls open to the old behaviour. It never replaces the rate limits.

export const LOCK_AFTER = 5; // wrong tries in a row before the first lock
export const FIRST_LOCK_S = 5;
export const MAX_LOCK_S = 300;
const KEEP_S = 900; // how long the cache keeps a counter after its last write

/** Length of the n-th lock (n = 1, 2, 3, ...): 5, 10, 20, ... capped at MAX_LOCK_S. */
export function lockSeconds(n) {
  return Math.min(MAX_LOCK_S, FIRST_LOCK_S * 2 ** Math.max(0, n - 1));
}

/** Whole seconds still locked (0 = not locked). */
export function lockedFor(state, now) {
  if (!state || !(state.until > now)) return 0;
  return Math.ceil((state.until - now) / 1000);
}

/** The counter after one more wrong try (only called when not locked). */
export function afterWrong(state, now) {
  const fails = (state?.fails ?? 0) + 1;
  const locks = state?.locks ?? 0;
  if (fails < LOCK_AFTER) return { fails, locks, until: 0 };
  // The 5th wrong try locks; after that every wrong try locks again, twice as long.
  const next = locks + 1;
  return { fails, locks: next, until: now + lockSeconds(next) * 1000 };
}

/** Storage backed by the Workers Cache API. */
export function cacheStore(cache) {
  const url = (key) => `https://lockout.internal/${key}`;
  return {
    async get(key) {
      const hit = await cache.match(url(key));
      return hit ? await hit.json() : null;
    },
    async put(key, state) {
      await cache.put(url(key), new Response(JSON.stringify(state), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${KEEP_S}` },
      }));
    },
    async delete(key) {
      await cache.delete(url(key));
    },
  };
}

/** A plain in-memory store (unit tests). `fail: true` makes every call throw. */
export function memoryStore({ fail = false } = {}) {
  const map = new Map();
  const check = () => { if (fail) throw new Error('storage down'); };
  return {
    map,
    async get(key) { check(); return map.get(key) ?? null; },
    async put(key, state) { check(); map.set(key, structuredClone(state)); },
    async delete(key) { check(); map.delete(key); },
  };
}

// env.lockoutStore wins (tests); otherwise the Cache API; none = no lockout (fall open).
function storeFor(env) {
  if (env?.lockoutStore) return env.lockoutStore;
  try {
    if (typeof caches !== 'undefined' && caches.default) return cacheStore(caches.default);
  } catch { /* no cache here */ }
  return null;
}

function keyFor(kind, request) {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return `${kind}/${encodeURIComponent(ip)}`;
}

/**
 * One lockout for one secret kind. Use:
 *   const lock = await lockout(env, 'phrase', request);
 *   if (lock.locked) return lock.response(json);
 *   ...compare...;  right ? await lock.right() : await lock.wrong();
 */
export async function lockout(env, kind, request, now = Date.now()) {
  const store = storeFor(env);
  const key = keyFor(kind, request);
  let state = null;
  if (store) {
    try {
      state = await store.get(key);
    } catch (e) {
      console.error(JSON.stringify({ message: 'lockout read failed; falling open', error: String(e) }));
    }
  }
  const seconds = lockedFor(state, now);
  return {
    locked: seconds > 0,
    retryAfter: seconds,
    /** The 429 answer, made with the site's json(status, body) helper. */
    response(json) {
      const res = json(429, {
        error: 'locked',
        retryAfter: seconds,
        message: `Too many wrong tries. Wait ${seconds} seconds and try again.`,
      });
      res.headers.set('retry-after', String(seconds));
      return res;
    },
    async wrong() {
      if (!store) return;
      try {
        await store.put(key, afterWrong(state, now));
      } catch (e) {
        console.error(JSON.stringify({ message: 'lockout write failed; falling open', error: String(e) }));
      }
    },
    async right() {
      if (!store || !state) return; // nothing to clear: no cache call on the normal path
      try {
        await store.delete(key);
      } catch (e) {
        console.error(JSON.stringify({ message: 'lockout clear failed', error: String(e) }));
      }
    },
  };
}
