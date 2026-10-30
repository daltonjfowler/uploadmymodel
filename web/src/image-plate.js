// Picture to plate: turn a picture into a solid the printer can make (Dalton, 2026-10-29). Three kinds:
//   raised      the dark parts stand up off a plate
//   engraved    the dark parts are cut into a plate
//   lithophane  a thin panel, thicker where the picture is darker: shine a light through it to see the picture
// The picture becomes a grid of heights, and the grid becomes one closed shell: the top follows the
// heights, the bottom is flat, and four walls close the sides. Everything runs in the browser.

import { LoadError } from './loaders.js';

export const PICTURE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp';
export const isPicture = (name) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);

// The 0.50 mm nozzle cannot draw anything finer, so smaller cells would only add triangles.
export const CELL_MM = 0.4;
// About two triangles per cell: a big plate still leaves room under the slicer's triangle limit.
export const MAX_CELLS = 100_000;
// A standing lithophane's foot: how far it reaches out in front and behind, and its tallest.
const FOOT_MM = 8;
const FOOT_MAX_H = 5;
// The foot reaches this far into the panel, so the slicer joins them into one piece.
const FOOT_OVERLAP = 0.2;
// Standing up, a panel that gets thicker going up hangs out over nothing, and the class's tree
// supports would grow onto the picture. It may thicken only this steeply (40° from upright, the
// strictest support angle a student can pick), so no setting ever puts support on it.
const STAND_GROWTH = Math.tan((40 * Math.PI) / 180);

export const KINDS = {
  raised: { label: 'Raised', blurb: 'The picture stands up off a plate.', name: 'raised' },
  engraved: { label: 'Engraved', blurb: 'The picture is cut into a plate.', name: 'engraved' },
  lithophane: { label: 'Lithophane', blurb: 'Shine a light through it to see the picture.', name: 'lithophane' },
};

/** Starting values for each kind, in mm (threshold 0-1: lighter than this counts as background). */
export const DEFAULTS = {
  raised: { kind: 'raised', width: 80, border: 3, base: 2, depth: 1.5, style: 'shape', threshold: 0.5, swap: false },
  engraved: { kind: 'engraved', width: 80, border: 3, base: 3, depth: 1, style: 'shape', threshold: 0.5, swap: false },
  lithophane: { kind: 'lithophane', width: 100, border: 3, thin: 0.8, thick: 3, stand: true },
};

/**
 * The grid for a picture `aspect` (width / height) wide: pc × pr samples over the picture area
 * (W × H mm, inside the border). The page asks the browser to shrink the picture to exactly this.
 */
export function gridFor(aspect, o) {
  const W = Math.max(5, o.width - 2 * o.border);
  const H = W / aspect;
  const cell = Math.max(CELL_MM, Math.sqrt((W * H) / MAX_CELLS));
  return { pc: Math.max(2, Math.round(W / cell) + 1), pr: Math.max(2, Math.round(H / cell) + 1), W, H };
}

/** Outer size in mm as it will sit on the bed: { x, y, z }. */
export function plateSize(aspect, o) {
  const { W, H } = gridFor(aspect, o);
  const w = W + 2 * o.border, h = H + 2 * o.border;
  if (o.kind === 'lithophane') return o.stand ? { x: w, y: o.thick + 2 * FOOT_MM, z: h } : { x: w, y: h, z: o.thick };
  return { x: w, y: h, z: o.kind === 'raised' ? o.base + o.depth : o.base };
}

/**
 * How much of the feature each sample gets, 0-1, from its brightness g (0 black, 1 white).
 * Raised/engraved: the "ink" (1 = stands up / is cut in). Lithophane: darkness (1 = thickest).
 */
export function inkOf(g, o) {
  if (o.kind === 'lithophane') return 1 - g;
  if (o.style === 'shades') return o.swap ? g : 1 - g;
  return (o.swap ? g >= o.threshold : g < o.threshold) ? 1 : 0;
}

/** A lithophane uses the panel's whole thickness range: the picture's darkest to its lightest. */
export function stretch(gray) {
  let lo = 1, hi = 0;
  for (const g of gray) {
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  if (hi - lo < 0.02) return gray;
  return gray.map((g) => (g - lo) / (hi - lo));
}

function heightOf(ink, o) {
  if (o.kind === 'raised') return o.base + o.depth * ink;
  if (o.kind === 'engraved') return o.base - Math.min(o.depth, o.base - 0.4) * ink;
  return o.thin + (o.thick - o.thin) * ink;
}

/** Sample positions along one side: the border (with one extra cell, so a ramp stays one cell wide), then the picture. */
function axis(n, size, border) {
  const step = size / (n - 1);
  const out = [];
  if (border > 0) out.push(0);
  if (border > step * 1.5) out.push(border - step);
  for (let i = 0; i < n; i++) out.push(border + i * step);
  if (border > step * 1.5) out.push(border + size + step);
  if (border > 0) out.push(size + 2 * border);
  return { at: out, first: border > 0 ? (border > step * 1.5 ? 2 : 1) : 0 };
}

/**
 * The plate as triangle corners (x, y, z, ...) in mm, front-left corner at 0, 0, 0.
 * `gray`: pc × pr brightness values, row 0 = top of the picture (from gridFor(aspect, o));
 * `aspect`: the picture's width / height, so the plate is exactly the size plateSize promised.
 */
export function picturePlate(gray, pc, pr, o, aspect) {
  if (gray.length !== pc * pr) throw new LoadError('The picture did not load right. Try another one.');
  const { W, H } = gridFor(aspect, o);
  const X = axis(pc, W, o.border), Y = axis(pr, H, o.border);
  const nx = X.at.length, ny = Y.at.length;
  const g = o.kind === 'lithophane' ? stretch(gray) : gray;
  // The border is plain plate; a lithophane's border is a frame at full thickness.
  const edge = heightOf(o.kind === 'lithophane' ? 1 : 0, o);
  const h = new Float32Array(nx * ny).fill(edge);
  for (let r = 0; r < pr; r++) {
    const k = Y.first + (pr - 1 - r); // the top of the picture goes to the back of the plate
    for (let c = 0; c < pc; c++) h[k * nx + X.first + c] = heightOf(inkOf(g[r * pc + c], o), o);
  }
  if (o.kind === 'lithophane' && o.stand) {
    // y becomes up when it stands: walk up the rows and cap how fast it may get thicker
    for (let k = 1; k < ny; k++) {
      const most = (Y.at[k] - Y.at[k - 1]) * STAND_GROWTH;
      for (let i = 0; i < nx; i++) h[k * nx + i] = Math.min(h[k * nx + i], h[(k - 1) * nx + i] + most);
    }
  }
  let positions = heightField(X.at, Y.at, h);
  if (o.kind === 'lithophane' && o.stand) positions = standUp(positions, X.at[nx - 1], o, H / (pr - 1));
  return positions;
}

/**
 * A closed shell over a grid: top at height h[k * nx + i] above (xs[i], ys[k]), bottom at 0.
 * xs and ys must rise. Triangles wind counter-clockwise seen from outside.
 */
export function heightField(xs, ys, h) {
  const nx = xs.length, ny = ys.length;
  // The bottom is flat, so it needs only strips between neighbouring columns; the two end strips
  // also take every corner of the left and right walls, so every edge is shared by two triangles.
  const bottom = [];
  const ends = [ys[0], ys[ny - 1]];
  for (let i = 0; i < nx - 1; i++) zipper(bottom, xs[i], i === 0 ? ys : ends, xs[i + 1], i + 1 === nx - 1 ? ys : ends);
  const walls = 2 * 2 * ((nx - 1) + (ny - 1));
  const out = new Float32Array((2 * (nx - 1) * (ny - 1) + walls) * 9 + bottom.length);
  let o = 0;
  const put = (x, y, z) => {
    out[o++] = x; out[o++] = y; out[o++] = z;
  };
  for (let k = 0; k < ny - 1; k++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = k * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
      put(xs[i], ys[k], h[a]); put(xs[i + 1], ys[k], h[b]); put(xs[i + 1], ys[k + 1], h[c]);
      put(xs[i], ys[k], h[a]); put(xs[i + 1], ys[k + 1], h[c]); put(xs[i], ys[k + 1], h[d]);
    }
  }
  // Walls: walk the outline counter-clockwise seen from above; the outside is on the right.
  const wall = (i0, k0, i1, k1) => {
    const ha = h[k0 * nx + i0], hb = h[k1 * nx + i1];
    put(xs[i0], ys[k0], 0); put(xs[i1], ys[k1], 0); put(xs[i1], ys[k1], hb);
    put(xs[i0], ys[k0], 0); put(xs[i1], ys[k1], hb); put(xs[i0], ys[k0], ha);
  };
  for (let i = 0; i < nx - 1; i++) wall(i, 0, i + 1, 0);
  for (let k = 0; k < ny - 1; k++) wall(nx - 1, k, nx - 1, k + 1);
  for (let i = nx - 1; i > 0; i--) wall(i, ny - 1, i - 1, ny - 1);
  for (let k = ny - 1; k > 0; k--) wall(0, k, 0, k - 1);
  out.set(bottom, o);
  return out;
}

/** Triangles on z = 0 between a left column (x = xl, corners at ls) and a right one, facing down. */
function zipper(out, xl, ls, xr, rs) {
  let a = 0, b = 0;
  // Seen from above, (left, right, next right) and (left, right, next left) turn counter-clockwise;
  // the bottom faces down, so each goes out the other way round.
  while (a < ls.length - 1 || b < rs.length - 1) {
    if (a === ls.length - 1 || (b < rs.length - 1 && rs[b + 1] <= ls[a + 1])) {
      out.push(xl, ls[a], 0, xr, rs[b + 1], 0, xr, rs[b], 0);
      b++;
    } else {
      out.push(xl, ls[a], 0, xl, ls[a + 1], 0, xr, rs[b], 0);
      a++;
    }
  }
}

/**
 * Stand a lithophane on its bottom edge, picture side to the front, and give it a foot in front and
 * behind so it cannot tip. Standing up, each layer prints a row of the picture at the nozzle's full
 * detail; lying flat, the shades would come out in steps of one layer.
 */
function standUp(flat, width, o, cell) {
  // Turn a quarter round X: (x, y, z) -> (x, -z, y). The relief (z) now points to the front (-y).
  const up = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    up[i] = flat[i];
    up[i + 1] = -flat[i + 2];
    up[i + 2] = flat[i + 1];
  }
  // Only as tall as the full-thickness frame, so the foot never covers the picture.
  const footH = Math.max(1, Math.min(FOOT_MAX_H, o.border - cell));
  const feet = [];
  box(feet, 0, -o.thick - FOOT_MM, 0, width, -o.thick + FOOT_OVERLAP, footH);
  box(feet, 0, -FOOT_OVERLAP, 0, width, FOOT_MM, footH);
  const out = new Float32Array(up.length + feet.length);
  out.set(up);
  out.set(feet, up.length);
  return out;
}

function box(out, x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]) {
    out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  }
}

// ---- Reading the picture (browser only) -----------------------------------------------------------

/** Decode a picture file. Throws LoadError with a message for students. */
export async function readPicture(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new LoadError(`Could not read "${file.name}" as a picture. Try a PNG or JPG.`);
  }
}

/** The picture shrunk to pc × pr, as brightness 0 (black) to 1 (white). See-through parts count as white. */
export function grayGrid(bitmap, pc, pr) {
  const canvas = document.createElement('canvas');
  canvas.width = pc;
  canvas.height = pr;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, pc, pr);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, pc, pr);
  const d = g.getImageData(0, 0, pc, pr).data;
  const out = new Float32Array(pc * pr);
  for (let i = 0; i < out.length; i++) out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return out;
}
