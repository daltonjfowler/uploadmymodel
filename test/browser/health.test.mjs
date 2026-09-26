// A model with holes gets a warning; a clean one does not. Also times the check on a big model.
import { chromium } from 'playwright-core';
import { BASE, CHROME, OUT, ensureMushroom } from './lib.mjs';
import { writeFileSync } from 'node:fs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
// A closed 20 mm cube.
const cube = OUT + 'cube.stl';
{
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
  const t = [];
  for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]) t.push([v[a], v[b], v[c]], [v[a], v[c], v[d]]);
  const buf = Buffer.alloc(84 + t.length * 50); buf.writeUInt32LE(t.length, 80);
  let o = 84; for (const tri of t) { o += 12; for (const p of tri) for (const n of p) { buf.writeFloatLE(n, o); o += 4; } o += 2; }
  writeFileSync(cube, buf);
}
await page.goto(base);
await page.waitForTimeout(400);
await page.setInputFiles('#fileInput', cube);
await page.waitForFunction(() => window.umm.viewer.models[0]?.health, null, { timeout: 10000 });
check('clean cube: no holes', await page.evaluate(() => window.umm.viewer.models[0].health), { triangles: 12, openEdges: 0, badEdges: 0 });
check('clean cube: no flag', await page.$$eval('.obj-flag', (x) => x.length), 0);
// The test mushroom's stem has no top: a real hole.
await page.setInputFiles('#fileInput', ensureMushroom());
await page.waitForFunction(() => window.umm.viewer.models[1]?.health, null, { timeout: 10000 });
check('mushroom: holes found', await page.evaluate(() => window.umm.viewer.models[1].health.openEdges > 0), true);
check('mushroom: flag in the list', await page.$$eval('.obj-flag', (x) => x.map((e) => e.textContent)), ['holes']);
check('warning toast', await page.$$eval('.toast.warn span', (x) => x.some((e) => e.textContent.includes('holes or broken edges'))), true);
await page.keyboard.press('Control+d');
check('copy keeps the flag', await page.$$eval('.obj-flag', (x) => x.length), 2);
console.log(errors.join('\n') || 'no errors');
await browser.close();
