// Write a 20 mm cube as binary STL. Centered on the origin in X/Y, sitting on Z=0.
import { writeFileSync } from 'node:fs';
const s = 20, h = s / 2;
const v = [[-h,-h,0],[h,-h,0],[h,h,0],[-h,h,0],[-h,-h,s],[h,-h,s],[h,h,s],[-h,h,s]];
const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
const buf = Buffer.alloc(84 + 50 * f.length);
buf.write('20mm cube', 0);
buf.writeUInt32LE(f.length, 80);
f.forEach((t, i) => {
  const o = 84 + i * 50;
  const [a, b, c] = t.map((k) => v[k]);
  const u = b.map((x, j) => x - a[j]), w = c.map((x, j) => x - a[j]);
  const n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
  const len = Math.hypot(...n);
  [...n.map((x) => x / len), ...a, ...b, ...c].forEach((x, j) => buf.writeFloatLE(x, o + j * 4));
});
writeFileSync(process.argv[2] ?? 'cube20.stl', buf);
console.log('wrote', buf.length, 'bytes');
