// Connectors (Bambu Studio style) and the 9 g servo pocket: solid add / cut-away between triangle meshes,
// with three-bvh-csg (MIT, by the author of three-mesh-bvh). Dalton, 2026-10-09.
//
// Everything here is in millimetres, in one shared frame (the caller bakes the model's scale in first,
// so a 5 mm peg really is 5 mm). Inputs and outputs are triangle soups: 9 numbers per triangle.
// No DOM, so Node tests load it.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ADDITION, Brush, CDTTriangleSplitter, Evaluator, SUBTRACTION } from 'three-bvh-csg';

const evaluator = new Evaluator();
evaluator.attributes = ['position'];
evaluator.useGroups = false;
// The CDT splitter cuts triangles so their edges still pair up; the default one leaves T-junctions
// (measured: box minus a hole, 258 unpaired edges vs 0).
evaluator.triangleSplitter = new CDTTriangleSplitter();

function brush(positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const b = new Brush(mergeVertices(g, 1e-5));
  b.updateMatrixWorld();
  return b;
}

function soup(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  return Float32Array.from(g.attributes.position.array);
}

/** `base` with every shape in `adds` joined on and every shape in `cuts` cut away. Closed in, closed out. */
export function combine(base, { adds = [], cuts = [] } = {}) {
  let b = brush(base);
  for (const a of adds) b = evaluator.evaluate(b, brush(a), ADDITION);
  for (const c of cuts) b = evaluator.evaluate(b, brush(c), SUBTRACTION);
  return watertight(soup(b.geometry));
}

/**
 * Make a triangle soup share its edges again. The add/cut leaves T-junctions (a corner sitting on the
 * middle of another triangle's edge) where the two shapes met: the solid is right, but its edges don't
 * pair up, and the health check (and some slicers) call that a hole. Corners that coincide are welded,
 * then every triangle with a stray corner on one of its unpaired edges is split there, until nothing
 * changes.
 */
export function watertight(positions, tol = 1e-3) {
  const key = (x, y, z) => `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
  const verts = [];
  const index = new Map();
  const vid = (x, y, z) => {
    const k = key(x, y, z);
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length;
      verts.push([x, y, z]);
      index.set(k, i);
    }
    return i;
  };
  let tris = [];
  for (let i = 0; i < positions.length; i += 9) {
    const a = vid(positions[i], positions[i + 1], positions[i + 2]);
    const b = vid(positions[i + 3], positions[i + 4], positions[i + 5]);
    const c = vid(positions[i + 6], positions[i + 7], positions[i + 8]);
    if (a !== b && b !== c && c !== a) tris.push([a, b, c]);
  }
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  // a triangle with its corners in a line has no area; it only makes edges look shared three times
  const flat = ([a, b, c]) => {
    const A = verts[a], B = verts[b], C = verts[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return Math.hypot(...n) < tol * tol;
  };
  // the same triangle twice: keep one; a pair facing opposite ways is a wall with nothing in it: drop both
  const dedupe = (list) => {
    const seen = new Map();
    for (const t of list) {
      const k = [...t].sort((x, y) => x - y).join(',');
      const turn = (t[0] < t[1]) + (t[1] < t[2]) + (t[2] < t[0]) === 2 ? 1 : -1; // which way round
      const had = seen.get(k);
      if (!had) seen.set(k, { t, turn, n: 1 });
      else if (had.turn === turn) had.n = Math.max(had.n, 1);
      else seen.delete(k);
    }
    return [...seen.values()].map((e) => e.t);
  };
  for (let round = 0; round < 8; round++) {
    tris = dedupe(tris.filter((t) => !flat(t)));
    const uses = new Map();
    for (const t of tris) for (let e = 0; e < 3; e++) { const k = ek(t[e], t[(e + 1) % 3]); uses.set(k, (uses.get(k) ?? 0) + 1); }
    const open = [];
    for (const [k, n] of uses) if (n === 1) open.push(k.split(',').map(Number));
    if (!open.length) break;
    // corners on unpaired edges, in a grid, so each edge only looks at corners near it
    const onOpen = new Set(open.flat());
    let span = 0;
    for (const [a, b] of open) span = Math.max(span, Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1], verts[a][2] - verts[b][2]));
    const cell = Math.max(span / 4, tol * 100);
    const grid = new Map();
    const gk = (x, y, z) => `${x},${y},${z}`;
    for (const v of onOpen) {
      const k = gk(...verts[v].map((c) => Math.floor(c / cell)));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(v);
    }
    const splitAt = new Map(); // "a,b" (as the open edge runs) -> corners on it, in order from a
    for (const [a, b] of open) {
      const A = verts[a], B = verts[b];
      const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (!len2) continue;
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(A[k], B[k]) - tol) / cell));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(A[k], B[k]) + tol) / cell));
      const found = [];
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        for (const v of grid.get(gk(x, y, z)) ?? []) {
          if (v === a || v === b) continue;
          const P = verts[v];
          const t = ((P[0] - A[0]) * d[0] + (P[1] - A[1]) * d[1] + (P[2] - A[2]) * d[2]) / len2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          if (Math.hypot(A[0] + t * d[0] - P[0], A[1] + t * d[1] - P[1], A[2] + t * d[2] - P[2]) < tol * 10) found.push([t, v]);
        }
      }
      if (found.length) splitAt.set(`${a},${b}`, found.sort((p, q) => p[0] - q[0]).map((f) => f[1]));
    }
    if (!splitAt.size) break;
    const next = [];
    for (const t of tris) {
      // the triangle's outline with the found corners put in, in order
      const ring = [];
      const onEdge = [false, false, false];
      for (let e = 0; e < 3; e++) {
        const a = t[e], b = t[(e + 1) % 3];
        ring.push(a);
        const fwd = splitAt.get(`${a},${b}`);
        const back = splitAt.get(`${b},${a}`);
        if (fwd) { ring.push(...fwd); onEdge[e] = true; }
        else if (back) { ring.push(...[...back].reverse()); onEdge[e] = true; }
      }
      if (ring.length === 3) {
        next.push(t);
        continue;
      }
      // fan from the corner facing a split edge (the corner not touching it), so no thin slivers cross it
      let c = 0;
      for (let e = 0; e < 3; e++) if (onEdge[e]) c = (e + 2) % 3;
      const start = ring.indexOf(t[c]);
      for (let k = 1; k + 1 < ring.length; k++) {
        const tri = [ring[start], ring[(start + k) % ring.length], ring[(start + k + 1) % ring.length]];
        if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[2] !== tri[0]) next.push(tri);
      }
    }
    tris = next;
  }
  tris = dedupe(tris.filter((t) => !flat(t)));
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => out.set(verts[v], i * 9 + j * 3)));
  return out;
}

// ---- shapes -----------------------------------------------------------------------------------

/**
 * A solid of revolution round +Y from a profile of [radius, y] points (radius 0 = on the axis), with
 * exactly shared seam corners: three's own Lathe/Cylinder leave seams that do not quite meet.
 */
function revolve(profile, segs) {
  const cos = [], sin = [];
  for (let j = 0; j < segs; j++) {
    cos.push(Math.cos((j / segs) * Math.PI * 2));
    sin.push(Math.sin((j / segs) * Math.PI * 2));
  }
  const at = (r, y, j) => (r === 0 ? [0, y, 0] : [r * cos[j % segs], y, -r * sin[j % segs]]);
  const out = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    for (let j = 0; j < segs; j++) {
      const a = at(r0, y0, j), b = at(r0, y0, j + 1), c = at(r1, y1, j + 1), d = at(r1, y1, j);
      if (r0 !== 0) out.push(...a, ...b, ...c);
      if (r1 !== 0) out.push(...a, ...c, ...d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(out), 3));
  return g;
}

/** A solid made from a three.js geometry, moved/turned by `matrix`. */
function solid(geometry, matrix) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  g.applyMatrix4(matrix);
  return Float32Array.from(g.attributes.position.array);
}

/** The turn that takes +Y (three's cylinder axis) onto `dir` (a unit vector). */
function turnFromY(dir) {
  return new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
}

/**
 * A round peg standing on `at`, pointing along `dir`, `length` long, with a 0.5 mm chamfer on its tip
 * so it finds its hole. `sink` mm of it reach back into the piece it stands on, so it joins solidly.
 */
export function peg(at, dir, radius, length, sink = 0.6) {
  const c = Math.min(0.5, radius / 3);
  const m = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z).multiply(turnFromY(dir));
  return solid(revolve([[0, -sink], [radius, -sink], [radius, length - c], [radius - c, length], [0, length]], 40), m);
}

/** A round hole (as a solid to cut away) from `at` along `dir`, `depth` deep, starting `lead` mm outside. */
export function hole(at, dir, radius, depth, lead = 0.6) {
  const m = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z).multiply(turnFromY(dir));
  return solid(revolve([[0, -lead], [radius, -lead], [radius, depth], [0, depth]], 40), m);
}

/** A loose dowel pin, lying on the bed (Z up from 0), centred on (x, y). */
export function dowelPin(radius, length, x = 0, y = 0) {
  const c = Math.min(0.4, radius / 3);
  const m = new THREE.Matrix4().makeTranslation(x, y, radius).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(0, -length / 2, 0));
  return solid(revolve([[0, 0], [radius - c, 0], [radius, c], [radius, length - c], [radius - c, length], [0, length]], 32), m);
}

// ---- connector places on a cut face ---------------------------------------------------------

/**
 * Where connectors fit on a flat cut face: the points deepest inside the face (farthest from its edge
 * and its holes), at least `need` mm from any edge. One point, or two for a long face.
 * @param {number[][][]} loops the face's outlines and holes, 2D points
 * @returns {number[][]} 2D points
 */
export function connectorSpots(loops, need, { max = 2 } = {}) {
  const pts = loops.flat();
  if (!pts.length) return [];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const inside = ([x, y]) => {
    let n = 0;
    for (const ring of loops) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n++;
      }
    }
    return n % 2 === 1;
  };
  const edgeDist = ([x, y]) => {
    let best = Infinity;
    for (const ring of loops) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j], [bx, by] = ring[i];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
      }
    }
    return best;
  };
  // a grid over the face, then the best cells
  const n = 48;
  const cells = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const p = [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n];
      if (!inside(p)) continue;
      const d = edgeDist(p);
      if (d >= need) cells.push({ p, d });
    }
  }
  if (!cells.length) return [];
  cells.sort((a, b) => b.d - a.d);
  const first = cells[0].p;
  const long = Math.max(x1 - x0, y1 - y0) > 2.5 * Math.min(x1 - x0, y1 - y0) || Math.max(x1 - x0, y1 - y0) > 60;
  if (max < 2 || !long) return [first];
  // two: the deepest point in each half of the face, along its long side
  const alongX = x1 - x0 >= y1 - y0;
  const mid = alongX ? (x0 + x1) / 2 : (y0 + y1) / 2;
  const half = (lo) => cells.find((c) => (alongX ? c.p[0] : c.p[1]) < mid === lo)?.p;
  const a = half(true), b = half(false);
  return a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) >= need * 3 ? [a, b] : [first];
}

// ---- 9 g servo pocket (SG90 / MG90S) -----------------------------------------------------------

/**
 * Sizes in mm, from the TowerPro SG90 data sheet; MG90S is the same within 0.3 mm. Clearance is
 * added on every side so the servo pushes in by hand (see FITS for the student's choice).
 */
export const SERVO_9G = {
  body: [22.8, 12.2], // length x width
  bodyDepth: 16.2, // bottom of the servo up to the underside of its mounting tabs
  tabs: [32.6, 12.2],
  tabDepth: 2.6, // the tabs sit flush in a shallow recess
  screwSpacing: 27.8,
  screwHole: 1.8, // pilot hole for the self-tapping screws
  screwDepth: 8,
  cable: [4.2, 2.4], // a slot down one end wall, so the wire comes out of the top
  clearance: 0.4,
};

/**
 * Gap added on every side of a servo or horn cut, mm (Dalton, 2026-10-28: "ensure tolerances are
 * appropriate"). The class printer has a 0.50 mm nozzle, and holes come out about 0.2 mm small, so
 * Normal leaves about 0.2 mm of real play per side; Snug is a firm push; Loose is for a stiff servo or
 * a rough print. Clone SG90s run up to 23.0 x 12.5 mm: Normal still takes those.
 */
export const FITS = { snug: 0.25, normal: 0.4, loose: 0.55 };

/**
 * The solid to cut away for a 9 g servo, its opening centred on `at`, going into the model along
 * `-normal`, turned `spinDeg` round the normal. Returns the solids (cut each one away).
 */
export function servoPocket(at, normal, spinDeg = 0, s = SERVO_9G) {
  const c = s.clearance;
  const n = normal.clone().normalize();
  // build it with its opening at y = 0 and going down to -depth, then turn -Y onto -normal
  const parts = [];
  const lead = 0.6; // start just outside the surface, so the cut is clean
  const box = (w, d, h, cx, cy, cz) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    return g;
  };
  const [bl, bw] = [s.body[0] + 2 * c, s.body[1] + 2 * c];
  const [tl, tw] = [s.tabs[0] + 2 * c, s.tabs[1] + 2 * c];
  const bodyDepth = s.bodyDepth + s.tabDepth + c; // room at the bottom too, so the tabs always seat flush
  parts.push(box(bl, bw, bodyDepth + lead, 0, (lead - bodyDepth) / 2, 0));
  parts.push(box(tl, tw, s.tabDepth + lead, 0, (lead - s.tabDepth) / 2, 0));
  for (const sx of [-1, 1]) {
    const g = revolve([[0, -s.screwDepth - s.tabDepth], [s.screwHole / 2, -s.screwDepth - s.tabDepth], [s.screwHole / 2, lead], [0, lead]], 20); // bottom up: faces outward
    g.translate((sx * s.screwSpacing) / 2, 0, 0);
    parts.push(g);
  }
  parts.push(box(s.cable[1] + c, s.cable[0] + c, bodyDepth + lead, bl / 2 + (s.cable[1] + c) / 2 - 0.01, (lead - bodyDepth) / 2, 0));
  const turn = new THREE.Matrix4()
    .makeTranslation(at.x, at.y, at.z)
    .multiply(turnFromY(n))
    .multiply(new THREE.Matrix4().makeRotationY((spinDeg * Math.PI) / 180));
  return parts.map((g) => solid(g, turn));
}

/** How deep a servo pocket goes into the model, mm (body + tabs, or the screw holes if deeper). */
export function servoDepth(s = SERVO_9G) {
  return Math.max(s.bodyDepth + s.tabDepth + s.clearance, s.tabDepth + s.screwDepth);
}

/**
 * A servo mount for a thin part (Dalton, 2026-10-28): a block standing on the surface at `at` (sunk
 * `sink` mm into it, so it joins on a curved face too) with the servo pocket in its top, `floor` mm of
 * block left under the servo. Returns { adds: [block], cuts: pocket solids, height }.
 */
export function servoMount(at, normal, spinDeg = 0, s = SERVO_9G, { wall = 2, floor = 2, sink = 2 } = {}) {
  const n = normal.clone().normalize();
  const c = s.clearance;
  const height = servoDepth(s) + floor;
  const [l, w] = [s.tabs[0] + 2 * c + 2 * wall, s.tabs[1] + 2 * c + 2 * wall];
  const g = new THREE.BoxGeometry(l, height + sink, w);
  g.translate(0, (height - sink) / 2, 0);
  const turn = new THREE.Matrix4()
    .makeTranslation(at.x, at.y, at.z)
    .multiply(turnFromY(n))
    .multiply(new THREE.Matrix4().makeRotationY((spinDeg * Math.PI) / 180));
  const top = at.clone().addScaledVector(n, height);
  return { adds: [solid(g, turn)], cuts: servoPocket(top, n, spinDeg, s), height };
}

// ---- servo horns ----------------------------------------------------------------------------------
// Dalton, 2026-10-28: a pocket for the horn (the plastic arm that goes on the servo's gear), so a
// printed part fixes onto the servo. Typical SG90 / MG90S kit horns; brands differ by a millimetre or
// two, so the arm length is the student's to change and a test print is worth it.

export const HORN_9G = {
  hub: 7.2, // round middle of the horn, across
  armRoot: 5.6, // arm width next to the hub
  armTip: 4.0, // arm width at its rounded end
  arm: { single: [16], double: [16, 16], cross: [16, 16, 10, 10] }, // middle to tip, per arm
  round: 20.5, // the round disc horn, across
  thick: 1.8, // the flat plate that sits in the pocket
  screwHole: 5.0, // through the part, middle: room for the horn screw's head and a screwdriver
  pilot: 1.5, // at each arm's outer hole, for the small screws that come with the horn
  pilotDepth: 6,
  pilotIn: 2.0, // outer hole, this far in from the arm's tip
};

/** A flat outline (x, z points, counter-clockwise seen from +y) pulled from y0 up to y1. */
function slab(points, y0, y1) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: 12 });
  g.rotateX(-Math.PI / 2); // extruded along +z, which becomes +y; the shape's y becomes -z
  g.translate(0, y0, 0);
  return g;
}

/**
 * The solids to cut away for a servo horn, centred on `at`, going in along -normal, turned `spinDeg`.
 * `kind`: single | double | cross | round. `armLength` overrides the longest arm (mm, middle to tip);
 * `through` makes the middle screw hole `throughDepth` mm long (the model's thickness there, so it comes
 * out the far side, for a screwdriver). Each solid is cut away.
 */
export function hornPocket(at, normal, spinDeg = 0, { kind = 'double', armLength = null, through = true, throughDepth = 400, clearance = FITS.normal } = {}, h = HORN_9G) {
  const c = clearance;
  const n = normal.clone().normalize();
  const lead = 0.6;
  const depth = h.thick + c; // a little deeper than the plate, so it sits flush or just under
  const parts = [];
  const cyl = (d, y0, y1, x = 0, z = 0) => {
    const g = revolve([[0, y0], [d / 2, y0], [d / 2, y1], [0, y1]], 32);
    g.translate(x, 0, z);
    return g;
  };
  if (kind === 'round') parts.push(cyl(h.round + 2 * c, -depth, lead));
  else {
    parts.push(cyl(h.hub + 2 * c, -depth, lead));
    const arms = h.arm[kind] ?? h.arm.double;
    const scale = armLength ? armLength / Math.max(...arms) : 1;
    arms.forEach((len0, i) => {
      const len = len0 * scale;
      // arms in the order long, long, short, short: long ones opposite, short ones across them
      const a = [0, Math.PI, Math.PI / 2, -Math.PI / 2][i];
      const r0 = h.armRoot / 2 + c, r1 = h.armTip / 2 + c;
      const tip = len - h.armTip / 2; // centre of the rounded end
      const pts = [[0, -r0], [tip, -r1]];
      for (let k = 1; k < 12; k++) {
        const t = -Math.PI / 2 + (k * Math.PI) / 12;
        pts.push([tip + r1 * Math.cos(t), r1 * Math.sin(t)]);
      }
      pts.push([tip, r1], [0, r0]);
      const g = slab(pts, -depth, lead);
      g.rotateY(a);
      parts.push(g);
      // pilot for the small screw through the arm's outer hole
      const px = (len - h.pilotIn) * Math.cos(a), pz = -(len - h.pilotIn) * Math.sin(a);
      parts.push(cyl(h.pilot, -depth - h.pilotDepth, lead, px, pz));
    });
  }
  // the middle: the horn's own screw goes in from this side, so a hole for its head and a screwdriver
  parts.push(cyl(h.screwHole + 2 * c, through ? -Math.max(throughDepth, depth + 6) : -depth - 6, lead));
  const turn = new THREE.Matrix4()
    .makeTranslation(at.x, at.y, at.z)
    .multiply(turnFromY(n))
    .multiply(new THREE.Matrix4().makeRotationY((spinDeg * Math.PI) / 180));
  return parts.map((g) => solid(g, turn));
}

/** How deep a horn pocket goes before the middle hole: the plate, plus the arm pilots. */
export function hornDepth(clearance = FITS.normal, h = HORN_9G) {
  return h.thick + clearance;
}

// ---- connectors on a plane cut ------------------------------------------------------------------

const PLANE_AXES = { x: [1, 2], y: [2, 0], z: [0, 1] }; // the cut face's two axes, as plane-cut.js uses
const WALL = 1.6; // mm of material kept round a connector

/** How far a piece reaches past the cut plane along +axis (side 1) or -axis (side -1), mm. */
function reach(positions, k, at, side) {
  let r = 0;
  for (let i = k; i < positions.length; i += 3) r = Math.max(r, (positions[i] - at) * side);
  return r;
}

/**
 * Connectors for one cut, everything in mm. `kind`: 'peg' (a peg on the piece below the plane, a
 * matching hole in the piece above) or 'dowel' (holes in both, plus loose pins to print).
 * @returns {{ below: Float32Array, above: Float32Array, extras: Float32Array[], placed: number, skipped: string|null }}
 */
export function addConnectors(below, above, plane, loops, { kind = 'peg', diameter = 6, length = 10, clearance = 0.2 } = {}) {
  const r = diameter / 2;
  const k = { x: 0, y: 1, z: 2 }[plane.axis];
  const [u, v] = PLANE_AXES[plane.axis];
  const spots = connectorSpots(loops, r + clearance + WALL);
  if (!spots.length) return { below, above, extras: [], placed: 0, skipped: 'The cut face is too small or thin for connectors.' };
  // keep the holes inside each piece: no deeper than the piece reaches, less a floor
  const room = (side) => reach(side > 0 ? above : below, k, plane.at, side) - WALL;
  const len = kind === 'peg' ? Math.min(length, room(1)) : Math.min(length, 2 * Math.min(room(1), room(-1)));
  if (len < 3) return { below, above, extras: [], placed: 0, skipped: 'The pieces are too thin here for connectors.' };
  const dir = new THREE.Vector3().setComponent(k, 1);
  const at3 = ([pu, pv]) => new THREE.Vector3().setComponent(k, plane.at).setComponent(u, pu).setComponent(v, pv);
  const extras = [];
  let b = below, a = above;
  if (kind === 'peg') {
    b = combine(b, { adds: spots.map((p) => peg(at3(p), dir, r, len)) });
    a = combine(a, { cuts: spots.map((p) => hole(at3(p), dir, r + clearance, len + 0.4)) });
  } else {
    const half = len / 2 + 0.3;
    b = combine(b, { cuts: spots.map((p) => hole(at3(p), dir.clone().negate(), r + clearance, half)) });
    a = combine(a, { cuts: spots.map((p) => hole(at3(p), dir, r + clearance, half)) });
    for (let i = 0; i < spots.length; i++) extras.push(dowelPin(r, len));
  }
  return { below: b, above: a, extras, placed: spots.length, skipped: len < length ? `Connectors made ${len.toFixed(1)} mm long to fit inside the pieces.` : null };
}
