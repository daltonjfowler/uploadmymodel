// Picture to plate (web/src/image-plate.js): every plate must be one closed, outward-facing shell
// (or, standing up, a panel plus two feet), the size the dialog promises, and under the triangle limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, MAX_CELLS, gridFor, heightField, inkOf, picturePlate, plateSize } from '../web/src/image-plate.js';
import { meshHealth, weld } from '../web/src/mesh-health.js';
import { LIMITS } from '../shared/settings.js';

function volume(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7])
      - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
      + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return v / 6;
}

/** Every edge is walked once each way: closed, and the triangles agree on which side is out. */
function windingAgrees(p) {
  const { id, unique } = weld(p);
  const seen = new Map();
  for (let t = 0; t < id.length; t += 3) {
    for (const [a, b] of [[id[t], id[t + 1]], [id[t + 1], id[t + 2]], [id[t + 2], id[t]]]) {
      const key = a * unique + b;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of seen) {
    const a = Math.floor(key / unique), b = key % unique;
    if (n !== 1 || seen.get(b * unique + a) !== 1) return false;
  }
  return true;
}

function bounds(p) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2], lo };
}

/** A test picture: a dark disc on white, pc × pr. */
function disc(pc, pr) {
  const g = new Float32Array(pc * pr).fill(1);
  for (let r = 0; r < pr; r++) {
    for (let c = 0; c < pc; c++) if ((c - pc / 2) ** 2 + (r - pr / 2) ** 2 < (Math.min(pc, pr) / 3) ** 2) g[r * pc + c] = 0.1;
  }
  return g;
}

const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('heightField: a flat 10 × 5 × 2 slab is a closed box of the right volume, facing out', () => {
  const p = heightField([0, 2.5, 5, 7.5, 10], [0, 1, 2, 3, 4, 5], new Float32Array(30).fill(2));
  assert.deepEqual(meshHealth(p), { triangles: p.length / 9, openEdges: 0, badEdges: 0 });
  assert.ok(windingAgrees(p));
  close(volume(p), 100);
});

test('heightField: bumps and a 2-column grid stay closed', () => {
  const h = Float32Array.from({ length: 2 * 7 }, (_, i) => 1 + (i % 3));
  const p = heightField([0, 4], [0, 1, 2, 3, 4, 5, 6], h);
  assert.equal(meshHealth(p).openEdges + meshHealth(p).badEdges, 0);
  assert.ok(windingAgrees(p));
  assert.ok(volume(p) > 0);
});

for (const kind of ['raised', 'engraved', 'lithophane']) {
  for (const stand of kind === 'lithophane' ? [false, true] : [false]) {
    test(`${kind}${stand ? ' standing' : ''}: closed, facing out, the promised size`, () => {
      const o = { ...DEFAULTS[kind], ...(kind === 'lithophane' ? { stand } : {}) };
      const aspect = 4 / 3;
      const { pc, pr } = gridFor(aspect, o);
      const p = picturePlate(disc(pc, pr), pc, pr, o, aspect);
      const health = meshHealth(p);
      assert.equal(health.openEdges, 0);
      assert.equal(health.badEdges, 0);
      assert.ok(volume(p) > 0);
      // Standing, the panel and its two feet are three shells; each one still agrees with itself.
      if (!stand) assert.ok(windingAgrees(p));
      const b = bounds(p);
      const want = plateSize(aspect, o);
      close(b.x, want.x);
      close(b.y, want.y);
      close(b.z, want.z, 0.01);
      assert.ok(p.length / 9 < LIMITS.maxTriangles / 2, `${p.length / 9} triangles`);
    });
  }
}

test('raised: the disc stands up by the depth; the background stays at the plate', () => {
  const o = DEFAULTS.raised;
  const { pc, pr } = gridFor(1, o);
  const p = picturePlate(disc(pc, pr), pc, pr, o, 1);
  close(bounds(p).z, o.base + o.depth);
  const blank = picturePlate(new Float32Array(pc * pr).fill(1), pc, pr, o, 1);
  close(bounds(blank).z, o.base);
});

test('engraved: never thinner than 0.4 mm, even when the cut is deeper than the plate', () => {
  const o = { ...DEFAULTS.engraved, base: 1, depth: 5 };
  const { pc, pr } = gridFor(1, o);
  const p = picturePlate(new Float32Array(pc * pr).fill(0), pc, pr, o, 1);
  // all black: the whole picture area is cut down to 0.4 mm; the border keeps the full plate
  let lowestTop = Infinity;
  for (let i = 2; i < p.length; i += 3) if (p[i] > 0) lowestTop = Math.min(lowestTop, p[i]);
  close(lowestTop, 0.4);
});

test('lithophane: darker is thicker, from thinnest to thickest', () => {
  const o = { ...DEFAULTS.lithophane, stand: false, border: 0 };
  assert.equal(inkOf(0, o), 1);
  assert.equal(inkOf(1, o), 0);
  const { pc, pr } = gridFor(1, o);
  const ramp = Float32Array.from({ length: pc * pr }, (_, i) => (i % pc) / (pc - 1));
  const p = picturePlate(ramp, pc, pr, o, 1);
  let lo = Infinity, hi = 0;
  for (let i = 2; i < p.length; i += 3) if (p[i] > 0) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  close(lo, o.thin);
  close(hi, o.thick);
});

test('standing lithophane: nothing hangs out more than 40° from upright, so it never gets supports', () => {
  const o = DEFAULTS.lithophane;
  const { pc, pr } = gridFor(1, o);
  const p = picturePlate(disc(pc, pr), pc, pr, o, 1); // a hard-edged dark disc: the worst case
  const limit = Math.sin((40.5 * Math.PI) / 180);
  let worst = 0;
  for (let i = 0; i < p.length; i += 9) {
    if (Math.max(p[i + 2], p[i + 5], p[i + 8]) < 0.01) continue; // on the bed
    const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
    const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) worst = Math.max(worst, -nz / len);
  }
  assert.ok(worst <= limit, `steepest overhang ${(Math.asin(worst) * 180 / Math.PI).toFixed(1)}°`);
  // the frame and the darkest part still reach full thickness
  close(bounds(p).y, o.thick + 16);
});

test('shape vs shades, and swapping dark and light', () => {
  const shape = { ...DEFAULTS.raised, threshold: 0.5 };
  assert.deepEqual([0.2, 0.7].map((g) => inkOf(g, shape)), [1, 0]);
  assert.deepEqual([0.2, 0.7].map((g) => inkOf(g, { ...shape, swap: true })), [0, 1]);
  close(inkOf(0.25, { ...shape, style: 'shades' }), 0.75);
});

test('a big plate gets bigger cells, not more triangles', () => {
  const { pc, pr } = gridFor(1, { ...DEFAULTS.raised, width: 250 });
  assert.ok(pc * pr <= MAX_CELLS * 1.02, `${pc} × ${pr}`);
  const small = gridFor(1, { ...DEFAULTS.raised, width: 30 });
  close((30 - 6) / (small.pc - 1), 0.4, 0.01); // small plates keep the 0.4 mm cell
});
