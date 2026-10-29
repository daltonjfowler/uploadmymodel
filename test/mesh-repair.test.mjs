// Close holes (web/src/mesh-repair.js): a model with holes comes back closed, facing out, nothing lost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeHoles, closeHolesIfBetter } from '../web/src/mesh-repair.js';
import { meshHealth } from '../web/src/mesh-health.js';

function box(x, y, z, sx, sy = sx, sz = sx) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return t.flatMap((f) => f.flatMap((i) => v[i]));
}
const volume = (p) => {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return v / 6;
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3 * Math.max(1, Math.abs(b)), `${msg}: ${a} vs ${b}`);
const closed = (p, msg) => {
  const h = meshHealth(p);
  assert.equal(h.openEdges, 0, `${msg}: open edges`);
  assert.equal(h.badEdges, 0, `${msg}: over-shared edges`);
};

test('a box with one triangle missing is closed again, facing out', () => {
  const r = closeHoles(new Float32Array(box(0, 0, 0, 20).slice(9)));
  assert.equal(r.filled, 1);
  assert.equal(r.openAfter, 0);
  closed(r.positions, 'box');
  near(volume(r.positions), 8000, 'volume (positive: faces out)');
});

test('a box with a whole side and a top corner missing: every hole filled', () => {
  const b = box(0, 0, 0, 20);
  const cut = b.slice(0, 9 * 2).concat(b.slice(9 * 3, 9 * 8), b.slice(9 * 10)); // lose a top and both on one side
  const r = closeHoles(new Float32Array(cut));
  closed(r.positions, 'box');
  near(volume(r.positions), 8000, 'volume');
});

test('a tube with its top ring missing: the ring (with the hole in it) is filled as a whole', () => {
  const q = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  const ring = (z) => [[0, 0, z], [20, 0, z], [20, 20, z], [0, 20, z]];
  const hole = (z) => [[5, 5, z], [15, 5, z], [15, 15, z], [5, 15, z]];
  const out = [];
  const [o0, o1, h0, h1] = [ring(0), ring(30), hole(0), hole(30)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    out.push(...q(o0[i], o0[j], o1[j], o1[i]), ...q(h0[j], h0[i], h1[i], h1[j]), ...q(o0[j], o0[i], h0[i], h0[j]));
  }
  const r = closeHoles(new Float32Array(out));
  assert.equal(r.filled, 2);
  closed(r.positions, 'tube');
  near(volume(r.positions), (400 - 100) * 30, 'volume: the hole stays a hole');
});

test('a closed model is left exactly as it was', () => {
  const b = new Float32Array(box(0, 0, 0, 20));
  const r = closeHolesIfBetter(b);
  assert.equal(r.positions, b);
  assert.equal(r.filled, 0);
});
