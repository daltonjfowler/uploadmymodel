// A tiny model gets unit fixes: inches (×25.4) always, meters from Blender (×1000) only when the
// result would still fit on the printer.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { BASE, CHROME, OUT } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';

function cubeStl(name, size) {
  const v = [[0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0], [0, 0, size], [size, 0, size], [size, size, size], [0, size, size]];
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  const facets = t.map((f) => `facet normal 0 0 0\n outer loop\n${f.map((i) => `  vertex ${v[i].join(' ')}`).join('\n')}\n endloop\nendfacet`);
  const file = `${OUT}${name}.stl`;
  writeFileSync(file, `solid ${name}\n${facets.join('\n')}\nendsolid ${name}\n`);
  return file;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const buttons = () => page.$$eval('.toast .toast-action', (bs) => bs.map((b) => b.textContent));
const size = (i) => page.evaluate((k) => { const s = window.umm.viewer.models[k].size; return [s.x, s.y, s.z].map((n) => Math.round(n * 100) / 100); }, i);
await page.goto(base);
await page.waitForTimeout(400);

// Blender part: 50 mm cube modeled as 0.05 m.
await page.setInputFiles('#fileInput', cubeStl('blender-cube', 0.05));
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
await page.waitForSelector('.toast .toast-action');
check('meters-sized part offers both fixes', await buttons(), ['Inches: ×25.4', 'Meters (Blender): ×1000']);
await page.click('.toast .toast-action:has-text("×1000")');
check('×1000 makes it 50 mm', await size(0), [50, 50, 50]);
await page.keyboard.press('Control+z');
check('undo brings it back', await size(0), [0.05, 0.05, 0.05]);

// 5 mm part: ×1000 would be 5 m, so only inches.
await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
await page.setInputFiles('#fileInput', cubeStl('small-cube', 5));
await page.waitForFunction(() => window.umm.viewer.models.length === 2);
await page.waitForSelector('.toast .toast-action');
check('too big for meters offers inches only', await buttons(), ['Inches: ×25.4']);
await page.click('.toast .toast-action');
check('×25.4 makes it 127 mm', await size(1), [127, 127, 127]);

// Two buttons must still fit at phone width.
await page.setViewportSize({ width: 360, height: 700 });
await page.setInputFiles('#fileInput', cubeStl('blender-cube-2', 0.05));
await page.waitForFunction(() => window.umm.viewer.models.length === 3);
await page.waitForSelector('.toast .toast-action:has-text("×1000")');
const fits = await page.$$eval('.toast', (ts) => ts.every((t) => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().right <= innerWidth));
check('toasts fit a phone', fits, true);
check('no page errors', errors, []);
await browser.close();
