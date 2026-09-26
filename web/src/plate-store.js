// Keeps the plate in this browser (IndexedDB), so a reloaded or crashed Chromebook tab gets the
// student's models back. Nothing leaves the Chromebook. Every call fails quietly: with site data
// blocked or a private window the page simply starts empty, as before.

const DB = 'uploadmymodel';
const STORE = 'plate';
const KEY = 'current';
// Big plates are not worth saving: the copy would take long and fill the student's storage.
const MAX_BYTES = 80 * 1024 * 1024;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** items: [{ name, positions, original, scale: [x,y,z], position: [x,y] }] (typed arrays). */
export async function savePlate(items) {
  try {
    const bytes = items.reduce((n, m) => n + m.positions.byteLength + m.original.byteLength, 0);
    if (!items.length || bytes > MAX_BYTES) {
      await run('readwrite', (s) => s.delete(KEY));
      return false;
    }
    await run('readwrite', (s) => s.put({ version: 1, savedAt: Date.now(), items }, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function loadPlate() {
  try {
    const saved = await run('readonly', (s) => s.get(KEY));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.items)) return null;
    const ok = saved.items.every((m) => typeof m.name === 'string' && m.positions instanceof Float32Array
      && m.original instanceof Float32Array && m.positions.length % 9 === 0 && m.positions.length > 0
      && Array.isArray(m.scale) && m.scale.length === 3 && Array.isArray(m.position) && m.position.length === 2
      && [...m.scale, ...m.position].every(Number.isFinite));
    return ok ? saved : null;
  } catch {
    return null;
  }
}

export async function clearPlate() {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch { /* nothing to clear */ }
}
