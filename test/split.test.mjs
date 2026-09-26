// Splitting one model into the separate things in it (split.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitParts } from '../web/src/split.js';

// A closed box as a triangle soup (12 triangles, corners repeated like an STL).
function box(x, y, z, sx, sy = sx, sz = sx) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    .map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return t.flatMap((f) => f.flatMap((i) => v[i]));
}
const soup = (...boxes) => new Float32Array(boxes.flat());
const tris = (parts) => parts.map((p) => p.positions.length / 9);

test('one box is one part', () => {
  assert.equal(splitParts(soup(box(0, 0, 0, 10))), null);
});

test('boxes with space between them come apart, numbered left to right', () => {
  const parts = splitParts(soup(box(40, 0, 0, 10), box(0, 0, 0, 10), box(20, 5, 0, 4)));
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.cx), [5, 22, 45]);
  assert.deepEqual(parts.map((p) => p.cy), [5, 7, 5]);
  assert.deepEqual(tris(parts), [12, 12, 12]);
});

test('overlapping shapes (a Tinkercad design never merged) stay together', () => {
  assert.equal(splitParts(soup(box(0, 0, 0, 10), box(5, 5, 5, 10))), null);
});

test('a part inside another (hollow wall, print-in-place) stays with it', () => {
  assert.equal(splitParts(soup(box(0, 0, 0, 20), box(5, 5, 5, 4))), null);
});

test('touching boxes stay together', () => {
  assert.equal(splitParts(soup(box(0, 0, 0, 10), box(10, 0, 0, 10))), null);
});

test('a chain of overlaps joins into one part; a loose one comes apart', () => {
  const parts = splitParts(soup(box(0, 0, 0, 10), box(8, 0, 0, 10), box(16, 0, 0, 10), box(60, 0, 0, 5)));
  assert.equal(parts.length, 2);
  assert.deepEqual(tris(parts), [36, 12]);
});

test('every triangle ends up in exactly one part, unchanged', () => {
  const src = soup(box(0, 0, 0, 10), box(30, 30, 0, 5, 8, 2), box(0, 50, 20, 3));
  const parts = splitParts(src);
  const seen = new Set();
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 9) seen.add(p.positions.slice(i, i + 9).join(','));
  for (let i = 0; i < src.length; i += 9) assert.ok(seen.has(src.slice(i, i + 9).join(',')));
  assert.equal(tris(parts).reduce((a, b) => a + b), src.length / 9);
});
