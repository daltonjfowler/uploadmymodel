// Split by plane: cut a model's triangles with flat planes (X, Y or Z) and close each cut, so every
// piece is a solid that slices. Dalton, 2026-10-09: big models printed in parts, glued after.
//
// Works on the model's own triangle corners (9 numbers per triangle). The viewer bakes turns into the
// corners, so a flat cut on the bed is a flat cut here too; only the position along the axis differs.
// No DOM, so Node tests load it. The cut faces are filled with three.js's own triangulation (earcut).

import { ShapeUtils, Vector2 } from 'three';

const AXES = { x: 0, y: 1, z: 2 };
// The two other axes, in the order that makes "counter-clockwise" mean "facing +axis".
const PLANE = [[1, 2], [2, 0], [0, 1]];

/**
 * Cut triangles with the plane `axis = at`.
 * @param {Float32Array} positions
 * @param {'x'|'y'|'z'} axisName
 * @param {number} at
 * @returns {{ below: Float32Array, above: Float32Array, open: boolean }} each side closed with a
 *   cap; `open` when part of the cut could not be closed (the model has holes there)
 */
export function cutMesh(positions, axisName, at) {
  const a = AXES[axisName];
  const [u, v] = PLANE[a];
  const below = [];
  const above = [];
  const segs = []; // cut lines, 4 numbers each (u0, v0, u1, v1)
  const tris = positions.length / 9;
  // How far from the plane counts as on it: a corner there would make zero-length cut lines.
  let span = 0;
  for (let i = a; i < positions.length; i += 3) span = Math.max(span, Math.abs(positions[i] - at));
  const eps = Math.max(1e-6, span * 1e-7);
  // Where an edge crosses the plane, always worked out from the same end first, so the two
  // triangles that share the edge get exactly the same point.
  const cross = (p, q) => {
    if (p[0] > q[0] || (p[0] === q[0] && (p[1] > q[1] || (p[1] === q[1] && p[2] > q[2])))) [p, q] = [q, p];
    const t = (at - p[a]) / (q[a] - p[a]);
    const r = [0, 0, 0];
    for (let k = 0; k < 3; k++) r[k] = k === a ? at : p[k] + (q[k] - p[k]) * t;
    return r;
  };
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const P = [
      [positions[o], positions[o + 1], positions[o + 2]],
      [positions[o + 3], positions[o + 4], positions[o + 5]],
      [positions[o + 6], positions[o + 7], positions[o + 8]],
    ];
    const d = P.map((p) => p[a] - at);
    const on = d.map((x) => Math.abs(x) < eps);
    const off = [0, 1, 2].filter((k) => !on[k]);
    const whole = (to) => to.push(...P[0], ...P[1], ...P[2]);
    if (!off.length) { // lying in the plane: it belongs to the piece it faces out of
      const e1 = [0, 1, 2].map((k) => P[1][k] - P[0][k]), e2 = [0, 1, 2].map((k) => P[2][k] - P[0][k]);
      const n = e1[u] * e2[v] - e1[v] * e2[u]; // normal along the axis
      whole(n > 0 ? below : above);
      continue;
    }
    if (off.every((k) => d[k] < 0) || off.every((k) => d[k] > 0)) { // corners on the plane go with the rest
      whole(d[off[0]] < 0 ? below : above);
      continue;
    }
    if (off.length === 2) { // one corner on the plane, one on each side: split through that corner
      const k = on.indexOf(true);
      const A = P[k], B = P[(k + 1) % 3], C = P[(k + 2) % 3];
      const M = cross(B, C);
      (d[(k + 1) % 3] < 0 ? below : above).push(...A, ...B, ...M);
      (d[(k + 2) % 3] < 0 ? below : above).push(...A, ...M, ...C);
      segs.push(A[u], A[v], M[u], M[v]);
      continue;
    }
    const s = d.map((x) => (x < 0 ? -1 : 1));
    // the corner alone on its side goes first, keeping the triangle's turn
    const lone = s[0] !== s[1] && s[0] !== s[2] ? 0 : s[1] !== s[0] && s[1] !== s[2] ? 1 : 2;
    const A = P[lone], B = P[(lone + 1) % 3], C = P[(lone + 2) % 3];
    const pAB = cross(A, B), pAC = cross(A, C);
    const mine = s[lone] < 0 ? below : above;
    const rest = s[lone] < 0 ? above : below;
    mine.push(...A, ...pAB, ...pAC);
    rest.push(...pAB, ...B, ...C, ...pAB, ...C, ...pAC);
    segs.push(pAB[u], pAB[v], pAC[u], pAC[v]);
  }
  const { loops, open } = chain(segs);
  const caps = capTriangles(loops); // 2D triangles, counter-clockwise
  const to3 = (pu, pv) => {
    const r = [0, 0, 0];
    r[a] = at;
    r[u] = pu;
    r[v] = pv;
    return r;
  };
  for (const [p, q, r] of caps) {
    below.push(...to3(...p), ...to3(...q), ...to3(...r)); // faces +axis: out of the piece below
    above.push(...to3(...p), ...to3(...r), ...to3(...q)); // faces -axis
  }
  return { below: Float32Array.from(below), above: Float32Array.from(above), open };
}

/** Join cut lines end to end into closed loops. */
function chain(segs) {
  const key = (x, y) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;
  const n = segs.length / 4;
  const ends = new Map(); // point key -> segment numbers
  const add = (k, i) => {
    const l = ends.get(k);
    if (l) l.push(i);
    else ends.set(k, [i]);
  };
  for (let i = 0; i < n; i++) {
    add(key(segs[i * 4], segs[i * 4 + 1]), i);
    add(key(segs[i * 4 + 2], segs[i * 4 + 3]), i);
  }
  const used = new Uint8Array(n);
  const loops = [];
  let open = false;
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [[segs[i * 4], segs[i * 4 + 1]]];
    let at = [segs[i * 4 + 2], segs[i * 4 + 3]];
    const start = key(...loop[0]);
    let closed = false;
    for (let guard = 0; guard <= n; guard++) {
      const k = key(...at);
      if (k === start) {
        closed = true;
        break;
      }
      loop.push(at);
      const next = (ends.get(k) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const o = next * 4;
      at = key(segs[o], segs[o + 1]) === k ? [segs[o + 2], segs[o + 3]] : [segs[o], segs[o + 1]];
    }
    if (closed && loop.length >= 3) loops.push(loop);
    else if (loop.length > 1 || !closed) open = true;
  }
  return { loops, open };
}

const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return s / 2; // > 0: counter-clockwise
};

function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Fill the loops: a loop inside an odd number of others is a hole in the smallest one around it. */
function capTriangles(loops) {
  const info = loops.map((ring) => ({ ring, size: Math.abs(area(ring)), parent: -1, depth: 0 }));
  info.forEach((me, i) => {
    let best = -1;
    info.forEach((other, j) => {
      if (j === i || other.size <= me.size || !inside(me.ring[0], other.ring)) return;
      me.depth++;
      if (best < 0 || other.size < info[best].size) best = j;
    });
    me.parent = best;
  });
  const out = [];
  info.forEach((outer, i) => {
    if (outer.depth % 2) return;
    const xy = (r) => r.map(([x, y]) => new Vector2(x, y));
    const contour = xy(outer.ring);
    const holes = info.filter((h) => h.parent === i && h.depth % 2).map((h) => xy(h.ring));
    // it may turn the rings round in place, so read the points back after
    const faces = ShapeUtils.triangulateShape(contour, holes);
    const pts = contour.concat(...holes);
    for (const [k0, k1, k2] of faces) {
      const tri = [pts[k0], pts[k1], pts[k2]].map((p) => [p.x, p.y]);
      if (area(tri) < 0) tri.reverse();
      out.push(tri);
    }
  });
  return out;
}

/**
 * Cut with every plane in turn. Planes are {axis, at} in the model's own coordinates.
 * @returns {{ pieces: { positions: Float32Array, side: number[] }[], open: boolean }} `side` is -1 or
 *   +1 per plane (which side of it the piece is on), for moving the pieces apart
 */
export function cutByPlanes(positions, planes) {
  let pieces = [{ positions, side: [] }];
  let open = false;
  for (const pl of planes) {
    const next = [];
    for (const p of pieces) {
      const r = cutMesh(p.positions, pl.axis, pl.at);
      open ||= r.open && r.below.length > 0 && r.above.length > 0;
      if (r.below.length) next.push({ positions: r.below, side: [...p.side, -1] });
      if (r.above.length) next.push({ positions: r.above, side: [...p.side, 1] });
    }
    pieces = next;
  }
  return { pieces, open };
}
