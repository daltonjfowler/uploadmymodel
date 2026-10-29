// Split by plane: cut a model's triangles with flat planes (X, Y or Z) and close each cut, so every
// piece is a solid that slices. Dalton, 2026-10-09: big models printed in parts, glued after.
//
// Works on the model's own triangle corners (9 numbers per triangle). The viewer bakes turns into the
// corners, so a flat cut on the bed is a flat cut here too; only the position along the axis differs.
// No DOM, so Node tests load it. The cut faces are filled with three.js's own triangulation (earcut).
//
// 2026-10-28 (Dalton's coworker): a plane can be tilted, and made smaller so it only cuts the parts it
// covers. A tilted plane is cut by turning the corners so the plane is flat, cutting, and turning back.
// A smaller plane cuts every cut face it covers whole; the rest stay joined (see `keep`).

import { ShapeUtils, Vector2 } from 'three';
import { meshHealth } from './mesh-health.js';

const AXES = { x: 0, y: 1, z: 2 };
// The two other axes, in the order that makes "counter-clockwise" mean "facing +axis".
const PLANE = [[1, 2], [2, 0], [0, 1]];

/**
 * Cut triangles with the plane `axis = at`.
 * @param {Float32Array} positions
 * @param {'x'|'y'|'z'} axisName
 * @param {number} at
 * @param {((outline: number[][]) => boolean) | null} keep when given, each cut face (its outline as 3D
 *   points on the plane) is cut only if `keep` says so; where it is not, the two sides stay one piece
 * @returns {{ below: Float32Array, above: Float32Array, mixed: Float32Array[], missed: number, open: boolean,
 *   loops: number[][][] }} each side closed with a cap (`loops`: the cut face's outlines and holes, 2D, in
 *   the plane's two other axes); `mixed`: pieces on both sides, joined where `keep` said no (`missed`
 *   cut faces); `open` when part of the cut could not be closed (the model has holes there)
 */
export function cutMesh(positions, axisName, at, keep = null) {
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
  // Edges that lie exactly in the plane (a ring of the model's own corners): which sides they have
  // triangles on. With triangles on both sides, the surface crosses there and the edge bounds the cut face.
  const inPlane = new Map();
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const P = [
      [positions[o], positions[o + 1], positions[o + 2]],
      [positions[o + 3], positions[o + 4], positions[o + 5]],
      [positions[o + 6], positions[o + 7], positions[o + 8]],
    ];
    const d = P.map((p) => p[a] - at);
    const on = d.map((x) => Math.abs(x) < eps);
    // corners on the plane go exactly onto it, so they meet the cut face's corners bit for bit
    for (let k = 0; k < 3; k++) if (on[k]) P[k][a] = at;
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
      if (off.length === 1) { // an edge lying in the plane: part of the cut outline if the surface goes on past it
        const k = off[0];
        const p = P[(k + 1) % 3], q = P[(k + 2) % 3];
        const kp = `${Math.round(p[u] * 1e5)},${Math.round(p[v] * 1e5)}`, kq = `${Math.round(q[u] * 1e5)},${Math.round(q[v] * 1e5)}`;
        const ek = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
        const e = inPlane.get(ek) ?? { below: 0, above: 0, seg: [p[u], p[v], q[u], q[v]] };
        e[d[k] < 0 ? 'below' : 'above']++;
        inPlane.set(ek, e);
      }
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
  for (const e of inPlane.values()) if (e.below && e.above) segs.push(...e.seg);
  const { loops, open } = chain(segs);
  const faces = capFaces(loops); // each cut face: its outline, holes and 2D triangles (counter-clockwise)
  const to3 = (pu, pv) => {
    const r = [0, 0, 0];
    r[a] = at;
    r[u] = pu;
    r[v] = pv;
    return r;
  };
  const skip = keep ? faces.filter((f) => !keep(f.outer.map((p) => to3(...p)))) : [];
  if (!skip.length) {
    for (const f of faces) capOnto(f, to3, below, above);
    return { below: Float32Array.from(below), above: Float32Array.from(above), mixed: [], missed: 0, open, loops };
  }
  if (skip.length === faces.length) { // nothing is cut: the model stays as it was, triangles and all
    return { below: new Float32Array(0), above: new Float32Array(0), mixed: [Float32Array.from(positions)], missed: skip.length, open: false, loops: [] };
  }
  return rejoin(below, above, faces, new Set(skip), to3, open);
}

/** A cut face's triangles onto both sides: facing +axis (out of the piece below) and -axis. */
function capOnto(face, to3, below, above) {
  for (const [p, q, r] of face.tris) {
    below.push(...to3(...p), ...to3(...q), ...to3(...r));
    above.push(...to3(...p), ...to3(...r), ...to3(...q));
  }
}

const key3 = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;

/**
 * Put the two sides back together across the cut faces in `skip`: triangles that touch are one piece
 * (union-find over corners), and the sides touch only along a skipped face's outline. Each cut face that
 * is kept gets its caps on the pieces next to it. Pieces only below (or only above) stay one piece each.
 */
function rejoin(below, above, faces, skip, to3, open) {
  const nb = below.length / 9;
  const all = below.concat(above);
  const n = all.length / 9;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (i, j) => { parent[find(i)] = find(j); };
  const corners = [new Map(), new Map()]; // corner -> a triangle using it, below and above apart
  for (let t = 0; t < n; t++) {
    const seen = corners[t < nb ? 0 : 1];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const k = key3(all[o], all[o + 1], all[o + 2]);
      const other = seen.get(k);
      if (other === undefined) seen.set(k, t);
      else join(t, other);
    }
  }
  for (const f of skip) {
    for (const ring of [f.outer, ...f.holes]) {
      for (const p of ring) {
        const k = key3(...to3(...p));
        const b = corners[0].get(k), t = corners[1].get(k);
        if (b !== undefined && t !== undefined) join(b, t);
      }
    }
  }
  const groups = new Map(); // root triangle -> { tris, sides: 1 below, 2 above, 3 both }
  const group = (t) => {
    const r = find(t);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { tris: [], sides: 0 }));
    return g;
  };
  for (let t = 0; t < n; t++) {
    const g = group(t);
    g.sides |= t < nb ? 1 : 2;
    for (let k = t * 9; k < t * 9 + 9; k++) g.tris.push(all[k]);
  }
  for (const f of faces) {
    if (skip.has(f)) continue;
    const k = key3(...to3(...f.outer[0]));
    const b = corners[0].get(k), t = corners[1].get(k);
    // both sides already one piece (joined round the far side): the cut parts nothing, so leave it
    // shut rather than make a slit with two faces touching
    if (b !== undefined && t !== undefined && find(b) === find(t)) {
      skip.add(f);
      continue;
    }
    capOnto(f, to3, b === undefined ? [] : group(b).tris, t === undefined ? [] : group(t).tris);
  }
  const side = { 1: [], 2: [] };
  const mixed = [];
  for (const g of groups.values()) {
    if (g.sides === 3) mixed.push(Float32Array.from(g.tris));
    else side[g.sides].push(g.tris);
  }
  const flat = (lists) => {
    const out = new Float32Array(lists.reduce((s, l) => s + l.length, 0));
    let o = 0;
    for (const l of lists) {
      out.set(l, o);
      o += l.length;
    }
    return out;
  };
  const loops = faces.filter((f) => !skip.has(f)).flatMap((f) => [f.outer, ...f.holes]);
  return { below: flat(side[1]), above: flat(side[2]), mixed, missed: skip.size, open, loops };
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

/**
 * Fill the loops: a loop inside an odd number of others is a hole in the smallest one around it.
 * One entry per cut face: { outer, holes, tris } (2D triangles, counter-clockwise).
 */
function capFaces(loops) {
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
    const holeRings = info.filter((h) => h.parent === i && h.depth % 2).map((h) => h.ring);
    const contour = xy(outer.ring);
    const holes = holeRings.map(xy);
    // it may turn the rings round in place, so read the points back after
    const faces = ShapeUtils.triangulateShape(contour, holes);
    const pts = contour.concat(...holes);
    const tris = [];
    for (const [k0, k1, k2] of faces) {
      const tri = [pts[k0], pts[k1], pts[k2]].map((p) => [p.x, p.y]);
      if (area(tri) < 0) tri.reverse();
      tris.push(tri);
    }
    out.push({ outer: outer.ring, holes: holeRings, tris });
  });
  return out;
}

/**
 * Cut with a plane at any tilt: `normal` (length 1) and `at` (normal · any point on it), in the model's
 * own coordinates. The corners are turned so the plane is flat, cut there, and turned back.
 */
export function cutTilted(positions, normal, at, keep = null) {
  const n = normal;
  const h = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(crossV(h, n));
  const e2 = crossV(n, e1); // e1, e2, n: a right-handed frame, so the triangles keep their turn
  const into = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    into[i] = x * e1[0] + y * e1[1] + z * e1[2];
    into[i + 1] = x * e2[0] + y * e2[1] + z * e2[2];
    into[i + 2] = x * n[0] + y * n[1] + z * n[2];
  }
  const back = (q) => {
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i += 3) {
      for (let k = 0; k < 3; k++) out[i + k] = q[i] * e1[k] + q[i + 1] * e2[k] + q[i + 2] * n[k];
    }
    return out;
  };
  const backPoint = (p) => [0, 1, 2].map((k) => p[0] * e1[k] + p[1] * e2[k] + p[2] * n[k]);
  const r = cutMesh(into, 'z', at, keep && ((outline) => keep(outline.map(backPoint))));
  return { ...r, below: back(r.below), above: back(r.above), mixed: r.mixed.map(back) };
}

const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
};

/**
 * Cut with every plane in turn. Planes are {axis, at} or {normal, at} (tilted, see cutTilted) in the
 * model's own coordinates, with an optional `keep` (see cutMesh) for a plane that only covers part.
 * `join(below, above, plane, loops)`, when given, may change the two sides of each flat cut (connectors)
 * and return `{ below, above, extras }`; extras (loose dowel pins) come back in `extras`.
 * @returns {{ pieces: { positions: Float32Array, side: number[] }[], open: boolean, missed: number,
 *   extras: Float32Array[] }} `side` is -1, 0 or +1 per plane (which side of it the piece is on; 0 when
 *   it is on both, joined where the plane did not reach), for moving the pieces apart
 */
export function cutByPlanes(positions, planes, join = null) {
  let pieces = [{ positions, side: [] }];
  let open = false;
  let missed = 0;
  const extras = [];
  for (const pl of planes) {
    const next = [];
    for (const p of pieces) {
      const r = pl.normal ? cutTilted(p.positions, pl.normal, pl.at, pl.keep) : cutMesh(p.positions, pl.axis, pl.at, pl.keep);
      const made = (r.below.length > 0) + (r.above.length > 0) + r.mixed.length;
      open ||= r.open && made > 1;
      missed += r.missed;
      let { below, above } = r;
      if (join && !pl.normal && !r.mixed.length && below.length && above.length && r.loops.length) {
        const j = join(below, above, pl, r.loops);
        ({ below, above } = j);
        extras.push(...(j.extras ?? []));
      }
      if (below.length) next.push({ positions: below, side: [...p.side, -1] });
      if (above.length) next.push({ positions: above, side: [...p.side, 1] });
      for (const m of r.mixed) next.push({ positions: m, side: [...p.side, 0] });
    }
    pieces = next;
  }
  // Never say "filled" when it is not: compare the pieces' open edges with the model's own.
  if (pieces.length > 1 && !open) {
    const before = meshHealth(positions).openEdges;
    const after = pieces.reduce((n, p) => n + meshHealth(p.positions).openEdges, 0);
    if (after > before) open = true;
  }
  return { pieces, open, missed, extras };
}

// ---- A cut plane on the bed (shared by the viewer and the panel) -----------------------------------
// A plane starts flat across one axis at `at`, through the model's middle. It can tilt round its own two
// directions (degrees), slide along them (du, dv mm) and shrink to w x h mm (null: covers the whole model).

const BASE = {
  x: { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  y: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  z: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
};
/** Bed axis names of a plane's two own directions (u, v), by its axis. */
export const PLANE_DIRS = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };

/** Turn `p` round the line `axis` (length 1) by `deg` (Rodrigues). */
function turn(p, axis, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const kx = crossV(axis, p), kd = dot(axis, p) * (1 - c);
  return [0, 1, 2].map((i) => p[i] * c + kx[i] * s + axis[i] * kd);
}

/**
 * Where a plane is on the bed: unit normal `n`, its own directions `u`, `v`, middle `c`, half size `half`
 * ([w/2, h/2], or null when it covers the whole model), `tilted`, and `draw` (middle and size to show it).
 * @param {{ axis: 'x'|'y'|'z', at: number, tiltU?: number, tiltV?: number, du?: number, dv?: number, w?: number|null, h?: number|null }} pl
 * @param {number[]} box the model's box on the bed [x0, y0, z0, x1, y1, z1]
 */
export function planeFrame(pl, box) {
  const b = BASE[pl.axis];
  const k = AXES[pl.axis];
  let { n, u, v } = b;
  const tu = pl.tiltU ?? 0, tv = pl.tiltV ?? 0;
  for (const [ax, deg] of [[b.u, tu], [b.v, tv]]) {
    if (!deg) continue;
    [n, u, v] = [n, u, v].map((p) => turn(p, ax, deg));
  }
  const mid = [0, 1, 2].map((i) => (box[i] + box[i + 3]) / 2);
  mid[k] = pl.at;
  const du = pl.du ?? 0, dv = pl.dv ?? 0;
  const c = [0, 1, 2].map((i) => mid[i] + du * u[i] + dv * v[i]);
  const half = pl.w == null && pl.h == null ? null : [(pl.w ?? Infinity) / 2, (pl.h ?? Infinity) / 2];
  // the model's box corners seen along the plane: how big the plane must be to cover it
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [box[i & 1 ? 3 : 0] - c[0], box[i & 2 ? 4 : 1] - c[1], box[i & 4 ? 5 : 2] - c[2]];
    const pu = dot(p, u), pv = dot(p, v);
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); v0 = Math.min(v0, pv); v1 = Math.max(v1, pv);
  }
  const M = 6; // mm past the model on every side
  const full = [u1 - u0 + 2 * M, v1 - v0 + 2 * M];
  let draw;
  if (half) {
    const [w, h] = [Math.min(2 * half[0], full[0]), Math.min(2 * half[1], full[1])];
    // an endless side is drawn as far as the model goes, centred on it that way
    const ou = pl.w == null ? (u0 + u1) / 2 : 0, ov = pl.h == null ? (v0 + v1) / 2 : 0;
    draw = { c: [0, 1, 2].map((i) => c[i] + ou * u[i] + ov * v[i]), w, h };
  } else {
    const ou = (u0 + u1) / 2, ov = (v0 + v1) / 2;
    draw = { c: [0, 1, 2].map((i) => c[i] + ou * u[i] + ov * v[i]), w: full[0], h: full[1] };
  }
  return { n, u, v, c, half, tilted: Boolean(tu || tv), draw, full };
}

/** Does the plane cover these bed points (all inside its edges)? */
export function planeCovers(frame, points) {
  if (!frame.half) return true;
  const tol = 1e-4;
  return points.every((p) => {
    const d = [p[0] - frame.c[0], p[1] - frame.c[1], p[2] - frame.c[2]];
    return Math.abs(dot(d, frame.u)) <= frame.half[0] + tol && Math.abs(dot(d, frame.v)) <= frame.half[1] + tol;
  });
}
