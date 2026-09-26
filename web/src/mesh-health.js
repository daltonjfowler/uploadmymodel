// Is the model a closed, solid shape? In a clean mesh every edge is shared by exactly two
// triangles. An edge used once is the rim of a hole; an edge used three or more times is where
// surfaces cross or touch badly. Slicers often still manage, but such models can print with gaps,
// so the page warns (Cura calls these "model errors").
//
// Corners are matched by their exact float bits (files share corners exactly; -0 counts as 0),
// with a typed-array hash table: a Map of strings would be far too slow for big models.

/** @returns {{ triangles: number, openEdges: number, badEdges: number }} */
export function meshHealth(positions) {
  const n = positions.length / 3;
  const f = new Float32Array(n * 3);
  for (let i = 0; i < f.length; i++) f[i] = positions[i] + 0; // + 0 turns -0 into 0
  const bits = new Uint32Array(f.buffer);

  // Weld corners: id per distinct position.
  let cap = 1;
  while (cap < n * 2) cap <<= 1;
  const slot = new Int32Array(cap).fill(-1); // -> index of the first corner with that position
  const id = new Int32Array(n);
  let unique = 0;
  const uniqueOf = new Int32Array(n); // corner index -> weld id, for the first corner of each id
  for (let i = 0; i < n; i++) {
    const x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (cap - 1);
    for (;;) {
      const s = slot[h];
      if (s < 0) {
        slot[h] = i;
        uniqueOf[i] = unique;
        id[i] = unique++;
        break;
      }
      if (bits[s * 3] === x && bits[s * 3 + 1] === y && bits[s * 3 + 2] === z) {
        id[i] = uniqueOf[s];
        break;
      }
      h = (h + 1) & (cap - 1);
    }
  }

  // Count how many triangles use each edge.
  const uses = new Map();
  const add = (a, b) => {
    if (a === b) return; // a squashed triangle's zero-length edge
    const key = a < b ? a * unique + b : b * unique + a;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < n; t += 3) {
    const a = id[t], b = id[t + 1], c = id[t + 2];
    add(a, b); add(b, c); add(c, a);
  }
  let openEdges = 0, badEdges = 0;
  for (const count of uses.values()) {
    if (count === 1) openEdges++;
    else if (count > 2) badEdges++;
  }
  return { triangles: n / 3, openEdges, badEdges };
}
