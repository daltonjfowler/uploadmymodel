// Close holes in a triangle soup (Dalton, 2026-10-28: "auto close the model if you accidentally cut
// through a wall and break geometry"). Every hole's rim (edges used by one triangle only) is followed
// round into a loop, and the loop is filled: flattened onto its own best plane and triangulated with
// three's earcut (a smaller rim inside it in the same plane is the hole in a ring), or, when that
// fails (a twisted rim), fanned from its middle. The new triangles face
// the same way as the ones round them, so the model is solid again.
//
// No DOM, so Node tests load it. Never trust it blindly: closeHoles says how many open edges are left,
// and callers keep the old shape when the repair did not help.

import { ShapeUtils, Vector2 } from 'three';
import { meshHealth } from './mesh-health.js';

/**
 * @param {Float32Array} positions 9 numbers per triangle
 * @param {{ tol?: number, maxLoop?: number }} [opts] tol: corners closer than this are one corner (mm);
 *   maxLoop: rims with more corners than this are left (a missing half of a model is not a hole)
 * @returns {{ positions: Float32Array, filled: number, openBefore: number, openAfter: number }}
 */
export function closeHoles(positions, { tol = 1e-4, maxLoop = 20000 } = {}) {
  const openBefore = meshHealth(positions).openEdges;
  if (!openBefore) return { positions, filled: 0, openBefore, openAfter: 0 };
  // weld corners
  const verts = [];
  const index = new Map();
  const vid = (x, y, z) => {
    const k = `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(x, y, z);
      index.set(k, i);
    }
    return i;
  };
  const tris = [];
  for (let i = 0; i < positions.length; i += 9) {
    const a = vid(positions[i], positions[i + 1], positions[i + 2]);
    const b = vid(positions[i + 3], positions[i + 4], positions[i + 5]);
    const c = vid(positions[i + 6], positions[i + 7], positions[i + 8]);
    if (a !== b && b !== c && c !== a) tris.push(a, b, c);
  }
  // rim edges: used by one triangle only, kept in the direction that triangle runs them
  const uses = new Map();
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
      const k = ek(a, b);
      const u = uses.get(k);
      if (u) u.n++;
      else uses.set(k, { n: 1, a, b });
    }
  }
  const next = new Map(); // corner -> rim edges leaving it
  for (const u of uses.values()) {
    if (u.n !== 1) continue;
    if (!next.has(u.a)) next.set(u.a, []);
    next.get(u.a).push(u.b);
  }
  // follow the rims round into loops
  const loops = [];
  for (const [start, outs] of next) {
    while (outs.length) {
      const loop = [start];
      let at = outs.pop();
      let closed = false;
      for (let guard = 0; guard < maxLoop + 1; guard++) {
        if (at === start) {
          closed = true;
          break;
        }
        loop.push(at);
        const o = next.get(at);
        if (!o || !o.length) break;
        at = o.pop();
      }
      if (closed && loop.length >= 3 && loop.length <= maxLoop) loops.push(loop);
    }
  }
  const P = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  // each rim, the way the patch must run it (against its triangles), with its plane (Newell's normal)
  const rims = loops.map((loop) => {
    const ring = loop.slice().reverse();
    const n = [0, 0, 0];
    for (let i = 0; i < ring.length; i++) {
      const p = P(ring[i]), q = P(ring[(i + 1) % ring.length]);
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    }
    const len = Math.hypot(...n);
    return { ring, n, area: len / 2, unit: len > 1e-12 ? n.map((v) => v / len) : null, used: false };
  }).sort((a, b) => b.area - a.area);
  const added = [];
  for (const outer of rims) {
    if (outer.used) continue;
    outer.used = true;
    let faces = null;
    if (outer.unit) {
      const z = outer.unit;
      const h = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const x = unit(cross(h, z)), y = cross(z, x);
      const flat = (ring) => ring.map((i) => { const p = P(i); return new Vector2(dot(p, x), dot(p, y)); });
      const contour = flat(outer.ring);
      const at = dot(P(outer.ring[0]), z);
      // a smaller rim in the same plane, running the other way, inside this one: the hole in a ring
      const holes = [];
      for (const r of rims) {
        if (r.used || !r.unit || dot(r.unit, z) > -0.999) continue;
        if (Math.abs(dot(P(r.ring[0]), z) - at) > 1e-3 * Math.max(1, Math.sqrt(outer.area))) continue;
        const f = flat(r.ring);
        if (!inside(f[0], contour)) continue;
        r.used = true;
        holes.push({ r, f });
      }
      const corner = new Map();
      contour.forEach((v, i) => corner.set(v, outer.ring[i]));
      for (const { r, f } of holes) f.forEach((v, i) => corner.set(v, r.ring[i]));
      const c = contour.slice();
      const hs = holes.map((h) => h.f.slice());
      // it may turn the lists round in place, so map back through the points themselves
      const f = ShapeUtils.triangulateShape(c, hs);
      const all = c.concat(...hs);
      const want = all.length + 2 * holes.length - 2;
      if (f.length === want) {
        faces = f.map((t) => t.map((k) => corner.get(all[k])));
        faces = faces.map((t) => (dot(normal(P(t[0]), P(t[1]), P(t[2])), z) < 0 ? [t[0], t[2], t[1]] : t));
      } else {
        for (const { r } of holes) r.used = false; // fill them on their own
      }
    }
    if (!faces) { // twisted rim: fan from the middle
      const ring = outer.ring;
      const m = [0, 0, 0];
      for (const i of ring) { const p = P(i); m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
      const mid = verts.length / 3;
      verts.push(m[0] / ring.length, m[1] / ring.length, m[2] / ring.length);
      faces = ring.map((v, i) => [mid, v, ring[(i + 1) % ring.length]]);
    }
    for (const t of faces) added.push(...t);
  }
  const all = tris.concat(added);
  const out = new Float32Array(all.length * 3);
  for (let i = 0; i < all.length; i++) {
    out[i * 3] = verts[all[i] * 3];
    out[i * 3 + 1] = verts[all[i] * 3 + 1];
    out[i * 3 + 2] = verts[all[i] * 3 + 2];
  }
  const openAfter = meshHealth(out).openEdges;
  return { positions: out, filled: loops.length, openBefore, openAfter };
}

/** closeHoles, but only when it really helps: otherwise `positions` back unchanged. */
export function closeHolesIfBetter(positions, opts) {
  const r = closeHoles(positions, opts);
  return r.openAfter < r.openBefore ? r : { positions, filled: 0, openBefore: r.openBefore, openAfter: r.openBefore };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
function inside(p, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
const normal = (p, q, r) => cross([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
