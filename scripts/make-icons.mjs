// Draws the uploadmymodel icon: a 3D-printed cube head with uploadmycode's smile, and the upload
// arrow coming out of the top of its head. The cube and the arrow are real 3D shapes, turned by YAW
// and tipped by PITCH, then projected flat, so changing the angle redraws everything consistently.
// Writes icon.svg and the PNGs from the same shapes, like uploadmylaser's scripts/make-icons.mjs.
// No dependencies: shapes are sampled per pixel with 4x4 supersampling, PNG written with zlib.
// Usage: node scripts/make-icons.mjs public
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = process.argv[2] || '.';
const TEAL = '#1F9FA5', WHITE = '#FFFFFF', DARK = '#0F3D40', FLOOR = '#18868B';
const ARROW = '#F97316', ARROW_SHADE = '#9A3412'; // filament orange, the site's accent

// View angle. YAW turns the cube so its right side shows; PITCH tips its top toward us.
const YAW = (-32 * Math.PI) / 180, PITCH = (22 * Math.PI) / 180;
// Light from up, front and a little left (world x, y, z), plus some ambient so no face goes black.
const LIGHT = ((v) => v.map((c) => c / Math.hypot(...v)))([-0.3, 0.55, 1]), AMBIENT = 0.55;

// ---------- 3D → 64-unit icon space ----------
// World: x right, y up, z toward the viewer. The cube is [-1, 1]³ and sits on y = -1.
function view([x, y, z]) {
  const x1 = x * Math.cos(YAW) + z * Math.sin(YAW), z1 = -x * Math.sin(YAW) + z * Math.cos(YAW);
  return [x1, -(y * Math.cos(PITCH) - z1 * Math.sin(PITCH))]; // screen y points down
}

// Upload arrow outline in its own plane (x across, y up), standing on the top face, and how deep it is.
const SHAFT = 0.27, HEAD = 0.66, SHAFT_TOP = 1.6, TIP = 2.45, DEPTH = 0.5;
const arrowOutline = [[-SHAFT, 1], [SHAFT, 1], [SHAFT, SHAFT_TOP], [HEAD, SHAFT_TOP], [0, TIP], [-HEAD, SHAFT_TOP], [-SHAFT, SHAFT_TOP]];

// Fit the whole drawing (cube, arrow tip, floor shadow) into the icon with a margin.
const FLOOR_R = 1.45;
const extent = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) extent.push(view([x, y, z]));
for (const [x, y] of arrowOutline) for (const z of [-DEPTH / 2, DEPTH / 2]) extent.push(view([x, y, z]));
for (let i = 0; i < 48; i++) { const a = (i / 48) * 2 * Math.PI; extent.push(view([FLOOR_R * Math.cos(a), -1, FLOOR_R * Math.sin(a)])); }
const minX = Math.min(...extent.map((p) => p[0])), maxX = Math.max(...extent.map((p) => p[0]));
const minY = Math.min(...extent.map((p) => p[1])), maxY = Math.max(...extent.map((p) => p[1]));
const MARGIN = 5, S = (64 - 2 * MARGIN) / Math.max(maxX - minX, maxY - minY);
const OX = 32 - ((minX + maxX) / 2) * S, OY = 32 - ((minY + maxY) / 2) * S;
const P = (p) => { const [x, y] = view(p); return [+(OX + x * S).toFixed(2), +(OY + y * S).toFixed(2)]; };

// A face is visible when its normal points at the viewer after turning.
const facing = ([nx, ny, nz]) => ny * Math.sin(PITCH) + (-nx * Math.sin(YAW) + nz * Math.cos(YAW)) * Math.cos(PITCH) > 1e-6;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
// Lambert shading, scaled so a face pointing straight at us gets exactly `base` (the white face stays white).
const bright = (n) => AMBIENT + (1 - AMBIENT) * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
const lit = (base, shade, n) => mix(shade, base, Math.min(1, bright(n) / bright([0, 0, 1])));

// ---------- 2D shapes: an SVG element and an inside(x, y) test ----------
const poly = (pts, fill) => ({
  svg: `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`,
  fill,
  inside: (px, py) => { // even-odd ray cast
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  },
});
// A thick polyline with round caps, `width` in icon units.
const stroke = (pts, width, color) => {
  const r2 = (width / 2) ** 2;
  return {
    svg: `<path d="M${pts.map((p) => p.join(' ')).join(' L')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    fill: color,
    inside: (px, py) => pts.some(([ax, ay], i) => {
      if (i === pts.length - 1) return false;
      const [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= r2;
    }),
  };
};
// Points on a face: `at(u, v)` maps face coordinates (-1..1 across, -1..1 up) to 3D.
const ring = (at, cu, cv, r, n = 40) => Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI; return P(at(cu + r * Math.cos(a), cv + r * Math.sin(a))); });
const bend = (at, [u0, v0], [qu, qv], [u1, v1], n = 24) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n;
  return P(at((1 - t) ** 2 * u0 + 2 * (1 - t) * t * qu + t * t * u1, (1 - t) ** 2 * v0 + 2 * (1 - t) * t * qv + t * t * v1));
});

const front = (u, v) => [u, v, 1], right = (u, v) => [1, v, -u], top = (u, v) => [u, 1, -v];

// ---------- the drawing, back to front ----------
const shapes = [];
shapes.push({ svg: `<rect x="0" y="0" width="64" height="64" rx="14" fill="${TEAL}"/>`, fill: TEAL, inside: (px, py) => {
  const r = 14, cx = Math.min(Math.max(px, r), 64 - r), cy = Math.min(Math.max(py, r), 64 - r);
  return px >= 0 && py >= 0 && px <= 64 && py <= 64 && (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
} });
shapes.push(poly(ring((u, v) => [u, -1, -v], 0, 0, FLOOR_R, 48), FLOOR)); // shadow on the floor

// Cube head: only the three faces we can see.
const cubeFaces = [
  { n: [0, 0, 1], at: front }, { n: [1, 0, 0], at: right }, { n: [0, 1, 0], at: top },
];
for (const { n, at } of cubeFaces) {
  if (!facing(n)) continue;
  shapes.push(poly([P(at(-1, -1)), P(at(1, -1)), P(at(1, 1)), P(at(-1, 1))], lit(WHITE, TEAL, n)));
}
// Print layer lines on the side, so it reads as a 3D-printed part.
const sideLines = mix(TEAL, lit(WHITE, TEAL, [1, 0, 0]), 0.8);
for (let v = -0.7; v <= 0.71; v += 0.35) shapes.push(stroke([P(right(-0.96, v)), P(right(0.96, v))], 0.55, sideLines));

// Face, on the front: uploadmycode's eyes and smile.
shapes.push(poly(ring(front, -0.42, 0.22, 0.24), DARK), poly(ring(front, 0.42, 0.22, 0.24), DARK));
shapes.push(poly(ring(front, -0.34, 0.32, 0.085, 20), WHITE), poly(ring(front, 0.5, 0.32, 0.085, 20), WHITE));
shapes.push(stroke(bend(front, [-0.36, -0.3], [0, -0.7], [0.36, -0.3]), 2.6, DARK));

// Upload arrow: an extruded outline. Its shadow on the head first, falling back and right (away
// from the light), then the sides (farthest first), then the front cap.
const zf = DEPTH / 2, zb = -DEPTH / 2, sides = [];
const CAST_X = 0.3, CAST_Z = -0.42;
shapes.push(poly([[-SHAFT, zf], [SHAFT, zf], [SHAFT + CAST_X, zf + CAST_Z], [SHAFT + CAST_X, zb + CAST_Z], [-SHAFT + CAST_X, zb + CAST_Z], [-SHAFT, zb]]
  .map(([x, z]) => P([x, 1, z])), mix(lit(WHITE, TEAL, [0, 1, 0]), TEAL, 0.3)));
for (let i = 0; i < arrowOutline.length; i++) {
  const [ax, ay] = arrowOutline[i], [bx, by] = arrowOutline[(i + 1) % arrowOutline.length];
  const len = Math.hypot(bx - ax, by - ay), n = [(by - ay) / len, -(bx - ax) / len, 0]; // outline runs counter-clockwise
  if (!facing(n)) continue;
  const depth = -(((ax + bx) / 2) * -Math.sin(YAW)) * Math.cos(PITCH) - ((ay + by) / 2) * Math.sin(PITCH);
  sides.push({ depth, shape: poly([P([ax, ay, zf]), P([bx, by, zf]), P([bx, by, zb]), P([ax, ay, zb])], lit(ARROW, ARROW_SHADE, n)) });
}
sides.sort((a, b) => b.depth - a.depth).forEach((s) => shapes.push(s.shape));
shapes.push(poly(arrowOutline.map(([x, y]) => P([x, y, zf])), lit(ARROW, ARROW_SHADE, [0, 0, 1])));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <!-- uploadmymodel icon: a 3D-printed cube head with uploadmycode's smile and upload arrow. Generated by scripts/make-icons.mjs, edit it there. -->
  ${shapes.map((s) => s.svg).join('\n  ')}
</svg>
`;
writeFileSync(join(OUT, 'icon.svg'), svg);

function render(size) {
  const px = Buffer.alloc(size * size * 4), SS = 4, scale = 64 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const ux = (x + (sx + 0.5) / SS) * scale, uy = (y + (sy + 0.5) / SS) * scale;
      let col = null;
      for (const s of shapes) if (s.inside(ux, uy)) col = s.fill;
      if (col) { const [cr, cg, cb] = hex(col); r += cr; g += cg; b += cb; a += 255; }
    }
    const n = SS * SS, o = (y * size + x) * 4, cov = a / 255;
    px[o] = cov ? r / cov : 0; px[o + 1] = cov ? g / cov : 0; px[o + 2] = cov ? b / cov : 0; px[o + 3] = a / n;
  }
  return png(size, px);
}

function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  writeFileSync(join(OUT, name), render(size));
}
console.log('icons written to', OUT);
