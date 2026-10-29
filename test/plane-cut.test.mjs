// Split by plane (web/src/plane-cut.js): every piece must be a closed solid, so it slices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShapeUtils, Vector2 } from 'three';
import { cutByPlanes, cutMesh, cutTilted, planeCovers, planeFrame } from '../web/src/plane-cut.js';
import { meshHealth } from '../web/src/mesh-health.js';

function box(x, y, z, sx, sy = sx, sz = sx) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    .map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return t.flatMap((f) => f.flatMap((i) => v[i]));
}

/** A square tube along Z: outer 20, hole 10, height 30 (a model with a hole through the cut). */
function tube() {
  const q = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  const ring = (z) => [[0, 0, z], [20, 0, z], [20, 20, z], [0, 20, z]];
  const hole = (z) => [[5, 5, z], [15, 5, z], [15, 15, z], [5, 15, z]];
  const out = [];
  const [o0, o1, h0, h1] = [ring(0), ring(30), hole(0), hole(30)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    out.push(...q(o0[i], o0[j], o1[j], o1[i])); // outer wall, facing out
    out.push(...q(h0[j], h0[i], h1[i], h1[j])); // hole wall, facing into the hole
    out.push(...q(o0[j], o0[i], h0[i], h0[j])); // bottom
    out.push(...q(o1[i], o1[j], h1[j], h1[i])); // top
  }
  return new Float32Array(out);
}

const volume = (p) => {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6])
      + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return v / 6; // > 0 when the faces point out
};
const closed = (p, msg) => {
  const h = meshHealth(p);
  assert.equal(h.openEdges, 0, `${msg}: open edges`);
  assert.equal(h.badEdges, 0, `${msg}: over-shared edges`);
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);

test('a box cut flat in the middle makes two closed halves', () => {
  const r = cutMesh(new Float32Array(box(0, 0, 0, 20)), 'z', 8);
  closed(r.below, 'below');
  closed(r.above, 'above');
  near(volume(r.below), 20 * 20 * 8, 'below volume (and facing out)');
  near(volume(r.above), 20 * 20 * 12, 'above volume');
  assert.equal(r.open, false);
});

test('a hole through the cut stays a hole in both cut faces', () => {
  for (const [axis, at] of [['z', 11], ['x', 3], ['y', 17]]) {
    const r = cutMesh(tube(), axis, at);
    closed(r.below, `${axis} below`);
    closed(r.above, `${axis} above`);
    near(volume(r.below) + volume(r.above), (400 - 100) * 30, `${axis}: nothing lost or added`);
  }
  near(volume(cutMesh(tube(), 'z', 11).below), 300 * 11, 'tube bottom part');
});

test('two planes make four closed pieces, with which side each is on', () => {
  const { pieces, open } = cutByPlanes(new Float32Array(box(0, 0, 0, 20)), [{ axis: 'x', at: 10 }, { axis: 'y', at: 5 }]);
  assert.equal(pieces.length, 4);
  assert.equal(open, false);
  for (const p of pieces) closed(p.positions, p.side.join());
  assert.deepEqual(pieces.map((p) => p.side.join()).sort(), ['-1,-1', '-1,1', '1,-1', '1,1']);
  near(pieces.reduce((n, p) => n + volume(p.positions), 0), 8000, 'total volume');
});

test('a plane that misses the model leaves it whole', () => {
  const { pieces } = cutByPlanes(new Float32Array(box(0, 0, 0, 20)), [{ axis: 'z', at: 50 }]);
  assert.equal(pieces.length, 1);
});

test('a cut through a corner point and along faces still closes', () => {
  const r = cutMesh(new Float32Array(box(0, 0, 0, 20)), 'x', 0.0000001);
  assert.ok(r.below.length === 0 || meshHealth(r.below).openEdges === 0);
  const s = cutMesh(new Float32Array(box(0, 0, 0, 20)), 'z', 20); // along the top face
  assert.equal(s.above.length, 0, 'nothing above the top');
});

test('an open model: the gap is closed after the cut, and the pieces are solid (Dalton, 2026-10-28)', () => {
  const p = box(0, 0, 0, 20).slice(9); // one triangle missing from the bottom
  const { open, mended, pieces } = cutByPlanes(new Float32Array(p), [{ axis: 'x', at: 10 }]);
  assert.equal(open, false);
  assert.ok(mended >= 1, 'gap closed');
  for (const pc of pieces) closed(pc.positions, `side ${pc.side}`);
  near(pieces.reduce((n, pc) => n + volume(pc.positions), 0), 8000, 'total volume');
});

/** A closed n-sided prism (a "cylinder" as CAD exports it), axis Z, corners at angles 0, 360/n, ... */
function prism(n, r, h) {
  const out = [];
  const pt = (i, z) => [r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2), z];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push(...pt(i, 0), ...pt(j, 0), ...pt(j, h), ...pt(i, 0), ...pt(j, h), ...pt(i, h)); // side
    out.push(0, 0, 0, ...pt(j, 0), ...pt(i, 0)); // bottom, facing down
    out.push(0, 0, h, ...pt(i, h), ...pt(j, h)); // top
  }
  return new Float32Array(out);
}

test('a cut through a ring of the model\'s own corners still fills the cut face (review 2026-10-09)', () => {
  for (const axis of ['x', 'y']) {
    const r = cutMesh(prism(20, 10, 15), axis, 0); // through the corners at 90 and 270 degrees
    closed(r.below, `${axis} below`);
    closed(r.above, `${axis} above`);
    assert.equal(r.open, false);
  }
  // a box whose sides have a ring of corners at z = 10, cut there
  const q = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  const ring = (z) => [[0, 0, z], [20, 0, z], [20, 20, z], [0, 20, z]];
  const [r0, r1, r2] = [ring(0), ring(10), ring(20)];
  const out = [...q(r0[0], r0[3], r0[2], r0[1]), ...q(r2[0], r2[1], r2[2], r2[3])];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    out.push(...q(r0[i], r0[j], r1[j], r1[i]), ...q(r1[i], r1[j], r2[j], r2[i]));
  }
  const s = cutMesh(new Float32Array(out), 'z', 10);
  closed(s.below, 'ring box below');
  closed(s.above, 'ring box above');
  near(volume(s.below), 4000, 'ring box below volume');
});

test('the cut never claims to be closed when a piece is still open', () => {
  const { open } = cutByPlanes(prism(20, 10, 15), [{ axis: 'x', at: 0 }]);
  assert.equal(open, false);
});

// ---- Tilted and smaller planes (Dalton's coworker, 2026-10-28) ----------------------------------------

/** A flat outline (counter-clockwise, [x, y] corners) pulled up from z = 0 to `h`: one closed mesh. */
function extrude(outline, h) {
  const out = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i], [bx, by] = outline[(i + 1) % n];
    out.push(ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, 0, bx, by, h, ax, ay, h);
  }
  for (const [i, j, k] of ShapeUtils.triangulateShape(outline.map(([x, y]) => new Vector2(x, y)), [])) {
    const [a, b, c] = [outline[i], outline[j], outline[k]];
    out.push(...a, h, ...b, h, ...c, h); // top, facing up
    out.push(...a, 0, ...c, 0, ...b, 0); // bottom, facing down
  }
  return new Float32Array(out);
}
const U = [[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]]; // a U, arms up +Y

test('a tilted plane cuts a box into two closed pieces', () => {
  const n = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const r = cutTilted(new Float32Array(box(0, 0, 0, 20)), n, (10 + 10) * Math.SQRT1_2); // through the middle
  closed(r.below, 'below');
  closed(r.above, 'above');
  near(volume(r.below), 4000, 'below half');
  near(volume(r.above), 4000, 'above half');
  const { pieces, open } = cutByPlanes(new Float32Array(box(0, 0, 0, 20)), [{ normal: n, at: 5 * Math.SQRT1_2 }]);
  assert.equal(pieces.length, 2);
  assert.equal(open, false);
  near(volume(pieces[0].positions), 5 * 5 / 2 * 20, 'small corner wedge'); // x + z < 5
});

test('a smaller plane cuts only the arm it covers; the rest stays one piece', () => {
  const u = extrude(U, 10);
  closed(u, 'the U itself');
  // y = 20 crosses both arms; the plane covers only the left arm (x < 15)
  const keep = (pts) => pts.every((p) => p[0] < 15);
  const r = cutMesh(u, 'y', 20, keep);
  assert.equal(r.missed, 1);
  assert.equal(r.below.length, 0, 'nothing is only below: the base joins the right arm');
  assert.equal(r.mixed.length, 1);
  closed(r.mixed[0], 'U with the left arm tip off');
  closed(r.above, 'left arm tip');
  near(volume(r.above), 1000, 'left arm tip volume');
  near(volume(r.mixed[0]), 6000, 'the rest');
  const { pieces } = cutByPlanes(u, [{ axis: 'y', at: 20, keep }]);
  assert.deepEqual(pieces.map((p) => p.side.join()).sort(), ['0', '1']);
});

test('a plane that covers no cut face whole leaves the model as it was', () => {
  const b = new Float32Array(box(0, 0, 0, 20));
  const { pieces, missed } = cutByPlanes(b, [{ axis: 'z', at: 10, keep: () => false }]);
  assert.equal(pieces.length, 1);
  assert.equal(missed, 1);
  assert.deepEqual([...pieces[0].positions], [...b], 'triangles untouched');
});

test('covering one wall of a tube does not cut a slit in it', () => {
  // x = 10 crosses the tube's two walls (y 0-5 and y 15-20); the plane covers only the first
  const r = cutMesh(tube(), 'x', 10, (pts) => pts.every((p) => p[1] < 10));
  assert.equal(r.mixed.length, 1);
  assert.equal(r.below.length + r.above.length, 0);
  closed(r.mixed[0], 'tube');
  near(volume(r.mixed[0]), 300 * 30, 'tube volume');
});

test('planeFrame: tilt, slide and size, and which points it covers', () => {
  const box20 = [0, 0, 0, 20, 20, 20];
  const flat = planeFrame({ axis: 'z', at: 5 }, box20);
  assert.deepEqual(flat.n, [0, 0, 1]);
  assert.deepEqual(flat.c, [10, 10, 5]);
  assert.equal(flat.half, null);
  assert.equal(flat.tilted, false);
  near(flat.draw.w, 32, 'drawn 6 mm past the model');
  const t = planeFrame({ axis: 'z', at: 5, tiltU: 90 }, box20); // round X: now upright, facing -Y
  near(t.n[1], -1, 'normal');
  near(Math.abs(t.n[2]), 0, 'normal z');
  const s = planeFrame({ axis: 'z', at: 5, du: 4, w: 6, h: 6 }, box20);
  assert.deepEqual(s.c, [14, 10, 5]);
  assert.equal(planeCovers(s, [[12, 8, 5], [16.9, 12.9, 5]]), true);
  assert.equal(planeCovers(s, [[12, 8, 5], [10, 10, 5]]), false);
  assert.equal(planeCovers(flat, [[-100, 0, 5]]), true, 'a whole plane covers everything');
});

test('a plane much bigger than the model is drawn that big and cuts all of it (Dalton, 2026-10-28)', () => {
  const box20 = [0, 0, 0, 20, 20, 20];
  const big = planeFrame({ axis: 'z', at: 10, w: 200, h: 150 }, box20);
  near(big.draw.w, 200, 'drawn width');
  near(big.draw.h, 150, 'drawn height');
  const keep = (pts) => planeCovers(big, pts);
  const { pieces, missed } = cutByPlanes(new Float32Array(box(0, 0, 0, 20)), [{ axis: 'z', at: 10, keep }]);
  assert.equal(pieces.length, 2);
  assert.equal(missed, 0);
});
