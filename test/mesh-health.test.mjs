// The "does this model have holes?" check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshHealth } from '../web/src/mesh-health.js';

function box(out, x0, y0, z0, x1, y1, z1, skip = -1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]].forEach(([a, b, c, d], i) => {
    if (i !== skip) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  });
  return out;
}

test('a closed box is healthy', () => {
  assert.deepEqual(meshHealth(new Float32Array(box([], 0, 0, 0, 10, 20, 30))), { triangles: 12, openEdges: 0, badEdges: 0 });
});

test('a box with its top missing has a 4-edge hole', () => {
  const r = meshHealth(new Float32Array(box([], 0, 0, 0, 10, 10, 10, 1)));
  assert.equal(r.openEdges, 4);
  assert.equal(r.badEdges, 0);
});

test('two separate closed boxes are fine; -0 and 0 are the same corner', () => {
  const t = box([], -1, -1, -1, 0, 0, 0);
  box(t, 5, 5, 5, 6, 6, 6);
  const f = new Float32Array(t).map((v) => (v === 0 ? -0 : v));
  for (let i = 0; i < 9; i++) f[i] = Object.is(f[i], -0) ? 0 : f[i]; // mix -0 and 0 on shared corners
  assert.deepEqual(meshHealth(f), { triangles: 24, openEdges: 0, badEdges: 0 });
});

test('three triangles on one edge count as a bad edge', () => {
  const t = box([], 0, 0, 0, 1, 1, 1);
  t.push(0, 0, 0, 1, 0, 0, 0.5, -1, 0.5); // a fin sharing the bottom-front edge
  const r = meshHealth(new Float32Array(t));
  assert.equal(r.badEdges, 1);
  assert.equal(r.openEdges, 2); // the fin's own two free edges
});
