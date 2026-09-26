// Shared bits for the browser tests (playwright-core driving an installed Chrome).
//   BASE:   site to test (first argument of each test, default local wrangler dev)
//   CHROME: Chrome binary (env CHROME_PATH, default the usual Windows install)
//   OUT:    folder for screenshots and generated models (gitignored)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://127.0.0.1:8787/';
export const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const OUT = fileURLToPath(new URL('./.out/', import.meta.url));
export const BENCHY = fileURLToPath(new URL('../golden/benchy_school_cura_4.13.2.gcode', import.meta.url));
mkdirSync(OUT, { recursive: true });

/** A 50 mm "mushroom" (cap overhangs a thin stem), written once to OUT; returns its path. */
export function ensureMushroom() {
  const file = OUT + 'mushroom.stl';
  if (existsSync(file)) return file;
  const tris = [];
  const seg = 48, ring = 24;
  const pt = (r, th, ph, cz) => [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), cz + r * Math.cos(ph)];
  for (let i = 0; i < ring; i++) for (let j = 0; j < seg; j++) {
    const p0 = (i * Math.PI) / ring, p1 = ((i + 1) * Math.PI) / ring, t0 = (j * 2 * Math.PI) / seg, t1 = ((j + 1) * 2 * Math.PI) / seg;
    const a = pt(25, t0, p0, 30), b = pt(25, t1, p0, 30), c = pt(25, t1, p1, 30), d = pt(25, t0, p1, 30);
    tris.push([a, d, c], [a, c, b]);
  }
  for (let j = 0; j < seg; j++) {
    const t0 = (j * 2 * Math.PI) / seg, t1 = ((j + 1) * 2 * Math.PI) / seg;
    const a = [8 * Math.cos(t0), 8 * Math.sin(t0), 0], b = [8 * Math.cos(t1), 8 * Math.sin(t1), 0];
    tris.push([a, b, [b[0], b[1], 10]], [a, [b[0], b[1], 10], [a[0], a[1], 10]], [[0, 0, 0], b, a]);
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) { o += 12; for (const v of t) for (const n of v) { buf.writeFloatLE(n, o); o += 4; } o += 2; }
  writeFileSync(file, buf);
  return file;
}
