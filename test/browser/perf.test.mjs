// Load a big STL with the CPU slowed 4x (roughly a school Chromebook) and time the main actions.
import { writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';

const TRIS = Number(process.argv[3] || 500000);
const file = OUT + `big-${TRIS}.stl`;
if (!existsSync(file)) {
  // A bumpy sphere: rings x segments grid, 2 triangles per cell.
  const seg = Math.round(Math.sqrt(TRIS / 2 * 2));
  const ring = Math.round(TRIS / 2 / seg);
  const n = ring * seg * 2;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  const pt = (i, j) => {
    const ph = (i / ring) * Math.PI, th = (j / seg) * 2 * Math.PI;
    const r = 40 + 2 * Math.sin(th * 12) * Math.sin(ph * 9);
    return [r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), 45 + r * Math.cos(ph)];
  };
  let o = 84;
  const tri = (a, b, c) => { o += 12; for (const v of [a, b, c]) for (const x of v) { buf.writeFloatLE(x, o); o += 4; } o += 2; };
  for (let i = 0; i < ring; i++) for (let j = 0; j < seg; j++) {
    const a = pt(i, j), b = pt(i, j + 1), c = pt(i + 1, j + 1), d = pt(i + 1, j);
    tri(a, d, c); tri(a, c, b);
  }
  writeFileSync(file, buf);
  console.log('made', file, n, 'triangles', (buf.length / 1048576).toFixed(1), 'MB');
}

const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(base);
await page.waitForTimeout(500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

const time = async (label, fn) => {
  const t0 = Date.now();
  await fn();
  const ms = Date.now() - t0;
  console.log(`${label.padEnd(34)} ${String(ms).padStart(6)} ms`);
  return ms;
};

await time('open file (parse + paint + show)', async () => {
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => window.umm.viewer.models.length === 1, null, { timeout: 120000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
});
const inPage = (label, code) => time(label, () => page.evaluate(code));
await inPage('turn 90 (bake + normals + paint)', () => { const v = window.umm.viewer; v.rotate(v.models[0], 'z', 90); });
await inPage('scale 50% (paint)', () => { const v = window.umm.viewer; v.setScale(v.models[0], 50, 50, 50); });
await inPage('support angle change (paint)', () => { window.umm.viewer.setSupportAngle(45); });
await inPage('undo', () => window.umm.viewer.undo());
await inPage('lay flat (biggest side)', () => { const v = window.umm.viewer; v.layFlatAuto(v.models[0]); });
await inPage('export plate STL', () => { window.umm.viewer.exportPlateSTL(); });
await inPage('one frame render', () => new Promise((r) => { window.umm.viewer.requestRender(); requestAnimationFrame(() => requestAnimationFrame(r)); }));
await inPage('click pick before tree (plain)', () => { const v = window.umm.viewer; v.models[0].geometry.disposeBoundsTree?.(); v.scheduleTrees(); const r = v.canvas.getBoundingClientRect(); v.pick({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); });
await inPage('hover pick before tree (box)', () => { const v = window.umm.viewer; const r = v.canvas.getBoundingClientRect(); v.pick({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, { hover: true }); });
if (TRIS <= 200000) await time('idle tree build finishes', () => page.waitForFunction(() => !!window.umm.viewer.models[0].geometry.boundsTree, null, { timeout: 60000, polling: 50 }));
await inPage('pick (raycast) x10', () => { const v = window.umm.viewer; const r = v.canvas.getBoundingClientRect(); for (let i = 0; i < 10; i++) v.pick({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); });
await inPage('duplicate', () => { const v = window.umm.viewer; v.duplicate(v.models[0]); });
const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
console.log(`JS heap after all that: ${mem} MB`);
console.log(errors.join('\n') || 'no errors');
await browser.close();
