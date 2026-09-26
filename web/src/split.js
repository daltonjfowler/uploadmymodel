// Split one model into the separate things in it (a class set of keychains exported as one STL).
//
// Triangles that share a corner belong to the same piece. Pieces whose boxes overlap then stay
// together: a Tinkercad design is often several shapes pushed into each other that were never
// merged, a hollow part has an inner wall that is its own piece, and a print-in-place toy has
// parts inside each other. Only pieces with clear space between them come apart.

import { weld } from './mesh-health.js';

// Boxes this close (mm, before scale) count as touching.
const TOUCH = 0.01;

/**
 * @param {Float32Array} positions triangle corners, 9 numbers per triangle
 * @returns {{ positions: Float32Array, cx: number, cy: number }[] | null} one entry per part, with
 *   the middle of its box in the model's own coordinates; null when it is all one part
 */
export function splitParts(positions) {
  const tris = positions.length / 9;
  if (tris < 2) return null;
  const { id, unique } = weld(positions);

  // Corners joined by a triangle are in the same piece.
  const parent = new Int32Array(unique);
  for (let i = 0; i < unique; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const join = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (let t = 0; t < tris; t++) {
    join(id[t * 3], id[t * 3 + 1]);
    join(id[t * 3], id[t * 3 + 2]);
  }

  // Piece number per triangle, and each piece's box.
  const pieceOf = new Int32Array(tris);
  const pieceIndex = new Map();
  const box = []; // [x0, y0, z0, x1, y1, z1] per piece
  for (let t = 0; t < tris; t++) {
    const root = find(id[t * 3]);
    let k = pieceIndex.get(root);
    if (k === undefined) {
      k = box.length;
      pieceIndex.set(root, k);
      box.push([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    }
    pieceOf[t] = k;
    const b = box[k];
    for (let c = 0; c < 9; c += 3) {
      const i = t * 9 + c;
      for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < b[a]) b[a] = v;
        if (v > b[a + 3]) b[a + 3] = v;
      }
    }
  }
  const pieces = box.length;
  if (pieces < 2) return null;

  // Pieces whose boxes overlap become one part. Sweep along X so this stays fast with many pieces.
  const group = new Int32Array(pieces);
  for (let i = 0; i < pieces; i++) group[i] = i;
  const findG = (a) => {
    while (group[a] !== a) a = group[a] = group[group[a]];
    return a;
  };
  const order = [...box.keys()].sort((a, b) => box[a][0] - box[b][0]);
  for (let i = 0; i < pieces; i++) {
    const a = box[order[i]];
    for (let j = i + 1; j < pieces; j++) {
      const b = box[order[j]];
      if (b[0] > a[3] + TOUCH) break;
      if (b[1] <= a[4] + TOUCH && a[1] <= b[4] + TOUCH && b[2] <= a[5] + TOUCH && a[2] <= b[5] + TOUCH) {
        const ra = findG(order[i]), rb = findG(order[j]);
        if (ra !== rb) group[ra] = rb;
      }
    }
  }

  // Count triangles per part, then copy them out.
  const partOf = new Map(); // group root -> part number
  const count = [];
  for (let k = 0; k < pieces; k++) {
    const r = findG(k);
    if (!partOf.has(r)) {
      partOf.set(r, count.length);
      count.push(0);
    }
  }
  if (count.length < 2) return null;
  const partOfPiece = new Int32Array(pieces);
  for (let k = 0; k < pieces; k++) partOfPiece[k] = partOf.get(findG(k));
  for (let t = 0; t < tris; t++) count[partOfPiece[pieceOf[t]]]++;
  const out = count.map((n) => ({ positions: new Float32Array(n * 9), fill: 0, box: [Infinity, Infinity, -Infinity, -Infinity] }));
  for (let t = 0; t < tris; t++) {
    const part = out[partOfPiece[pieceOf[t]]];
    part.positions.set(positions.subarray(t * 9, t * 9 + 9), part.fill);
    part.fill += 9;
  }
  for (let k = 0; k < pieces; k++) {
    const pb = out[partOfPiece[k]].box;
    const b = box[k];
    pb[0] = Math.min(pb[0], b[0]);
    pb[1] = Math.min(pb[1], b[1]);
    pb[2] = Math.max(pb[2], b[3]);
    pb[3] = Math.max(pb[3], b[4]);
  }
  // Numbered left to right.
  const parts = out.map((p) => ({ positions: p.positions, cx: (p.box[0] + p.box[2]) / 2, cy: (p.box[1] + p.box[3]) / 2 }));
  return parts.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
}
