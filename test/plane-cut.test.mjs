// Split by plane (web/src/plane-cut.js): every piece must be a closed solid, so it slices.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutByPlanes, cutMesh } from '../web/src/plane-cut.js';
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

test('an open model says its cut could not be closed everywhere', () => {
  const p = box(0, 0, 0, 20).slice(9); // one triangle missing from the bottom
  const { open } = cutByPlanes(new Float32Array(p), [{ axis: 'x', at: 10 }]);
  assert.equal(open, true);
});
