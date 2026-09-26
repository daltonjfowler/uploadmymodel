// Re-center a binary STL: bounding-box centre at X=Y=0, bottom at Z=0 (what Cura does on load).
import { readFileSync, writeFileSync } from 'node:fs';
const [,, inp, out] = process.argv;
const b = readFileSync(inp);
const n = b.readUInt32LE(80);
if (84 + 50 * n !== b.length) throw new Error('not a binary STL');
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
  const x = b.readFloatLE(84 + i * 50 + 12 + v * 12 + a * 4);
  if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x;
}
const off = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
  const o = 84 + i * 50 + 12 + v * 12 + a * 4;
  b.writeFloatLE(b.readFloatLE(o) + off[a], o);
}
b.fill(0, 0, 80); b.write('centered', 0);
writeFileSync(out, b);
console.log({ triangles: n, size: max.map((x, a) => +(x - min[a]).toFixed(3)) });
