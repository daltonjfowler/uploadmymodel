// Draws the uploadmymodel icon: the family robot as a 3D-printed cube head (print layer lines on
// the side), wearing the upload arrow on top. Drawn by hand as three faces rather than projected,
// so it matches the other three. The look (ink outline, hand-drawn wobble) lives in
// scripts/icon-kit.mjs, shared by all four sites. Usage: node scripts/make-icons.mjs web/public
import { circle, curve, inked, poly, tile, writeIcons } from './icon-kit.mjs';

const OUT = process.argv[2] || '.';
// Family colours: grey face, deep tile of the site's colour, arrow in a brighter tint of it.
const BG = '#9A3412', FACE = '#AEB6C0', ARROW = '#FB923C', ARROW_SHADE = '#C2410C', INK = '#3A1206';
const WHITE = '#FFFFFF', DARK = '#0F3D40', FLOOR = '#7B2A0E';
const SIDE = '#8F98A3', TOP = '#C7CDD5', LAYER = '#7C8591';

const ellipse = (cx, cy, rx, ry, fill) => poly(Array.from({ length: 40 }, (_, i) => [cx + rx * Math.cos((i / 40) * 2 * Math.PI), cy + ry * Math.sin((i / 40) * 2 * Math.PI)]), fill);
const front = [[12.5, 27], [39, 29.5], [39, 56], [12.5, 53.5]];
const side = [[39, 29.5], [51, 23.8], [51, 50], [39, 56]];
const top = [[12.5, 27], [39, 29.5], [51, 23.8], [24.5, 21.5]];
// Arrow standing on the top face: a shaded copy behind it gives it depth.
const arrow = (dx, dy) => [[29 + dx, 25 + dy], [34 + dx, 25.4 + dy], [34 + dx, 15.5 + dy], [40.5 + dx, 15.8 + dy], [31.8 + dx, 5.5 + dy], [23.2 + dx, 15.2 + dy], [29 + dx, 15.4 + dy]];

writeIcons(OUT, [
  tile(BG),
  ellipse(32, 56.5, 23, 4.2, FLOOR), // shadow on the floor
  ...inked([poly(front, FACE), poly(side, SIDE), poly(top, TOP)], INK),
  // print layer lines on the side
  ...[0, 1, 2, 3, 4].map((k) => curve(40, 34 + k * 4.6, 45, 31.6 + k * 4.6, 50.2, 29 + k * 4.6, 0.7, LAYER)),
  // face on the front
  circle(21.5, 37.5, 2.4, DARK), circle(31.5, 38.5, 2.4, DARK),
  circle(22.3, 36.7, 0.8, WHITE), circle(32.3, 37.7, 0.8, WHITE),
  curve(20.5, 45, 26.5, 50, 32.5, 46.5, 2.4, DARK),
  // the arrow
  ...inked([poly(arrow(1.4, 0.6), ARROW_SHADE), poly(arrow(0, 0), ARROW)], INK),
], 'uploadmymodel icon: the family robot as a 3D-printed cube head with the upload arrow.');
