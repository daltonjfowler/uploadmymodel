import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('501') && !m.text().includes('cloudflareinsights')) errors.push(m.text()); });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
await page.goto(base);
await page.waitForTimeout(500);
await page.click('#sample');
await page.keyboard.press('Control+d');
await page.keyboard.press('Control+d');
await page.waitForTimeout(200);
const positions = () => page.evaluate(() => window.umm.viewer.models.map((m) => [m.position.x, m.position.y]));
const screenOf = (world) => page.evaluate((w) => {
  const v = window.umm.viewer;
  const p = v.rings.position.clone().set(w[0], w[1], w[2]).project(v.camera);
  const r = v.canvas.getBoundingClientRect();
  return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
}, world);

check('3 models', await page.$eval('#objCount', (e) => e.textContent), '3');
await page.keyboard.press('Control+a');
check('all selected', await page.evaluate(() => window.umm.viewer.selection.size), 3);
check('group panel', await page.$eval('.tp-title strong', (e) => e.textContent), '3 models selected');
check('list highlights 3', await page.$$eval('.object-list li.on', (x) => x.length), 3);

// arrows move all
const before = await positions();
await page.keyboard.press('ArrowRight');
const after = await positions();
check('arrow moved all +1', after.map((p, i) => Math.round((p[0] - before[i][0]) * 10) / 10), [1, 1, 1]);
await page.keyboard.press('Control+z');
check('one undo restores all', await positions(), before);

// drag one of them drags all
const m0 = await page.evaluate(() => { const m = window.umm.viewer.models[0]; return [m.position.x, m.position.y, m.size.z / 2]; });
const [sx, sy] = await screenOf(m0);
await page.mouse.move(sx, sy); await page.mouse.down();
await page.mouse.move(sx + 30, sy, { steps: 5 }); await page.mouse.move(sx + 60, sy, { steps: 5 }); await page.mouse.up();
const dragged = await positions();
const dxs = dragged.map((p, i) => Math.round((p[0] - before[i][0]) * 10) / 10);
check('group drag moved all the same', new Set(dxs).size === 1 && dxs[0] > 0, true);
await page.keyboard.press('Control+z');
check('group drag = one undo', await positions(), before);

// ctrl+click removes one from the selection
const m1 = await page.evaluate(() => { const m = window.umm.viewer.models[1]; return [m.position.x, m.position.y - m.size.y / 2, 2.5]; }); // front of its solid base
const [cx, cy] = await screenOf(m1);
await page.keyboard.down('Control'); await page.mouse.click(cx, cy); await page.keyboard.up('Control');
check('ctrl+click deselects one', await page.evaluate(() => window.umm.viewer.selection.size), 2);
check('the right one left', await page.evaluate(() => window.umm.viewer.selection.has(window.umm.viewer.models[1])), false);

// delete selected (2), undo brings both back
await page.keyboard.press('Delete');
check('deleted 2', await page.$eval('#objCount', (e) => e.textContent), '1');
await page.keyboard.press('Control+z');
check('undo brings 2 back', await page.$eval('#objCount', (e) => e.textContent), '3');

// group spin
await page.keyboard.press('Control+a');
await page.click('text=Spin each >> xpath=.. >> button >> nth=0');
const sizes = await page.evaluate(() => window.umm.viewer.models.map((m) => [Math.round(m.size.x), Math.round(m.size.y)]));
check('each spun 90°', sizes, [[24, 42], [24, 42], [24, 42]]);
await page.keyboard.press('Control+z');

// ---- rotate rings
await page.keyboard.press('Escape');
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.keyboard.press('r');
await page.waitForTimeout(200);
check('rings visible', await page.evaluate(() => window.umm.viewer.rings.visible), true);
// grab the blue (Z) ring at its +X side and drag round a quarter turn to its +Y side
const ring = await page.evaluate(() => { const v = window.umm.viewer; return [v.rings.position.x, v.rings.position.y, v.rings.position.z, v.rings.scale.x]; });
const pts = [];
for (let a = 0; a <= 90; a += 10) {
  const r = (a * Math.PI) / 180;
  pts.push(await screenOf([ring[0] + ring[3] * Math.cos(r), ring[1] + ring[3] * Math.sin(r), ring[2]]));
}
await page.mouse.move(...pts[0]);
await page.mouse.down();
for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 3 });
const label = await page.$eval('.angle-label', (e) => (e.hidden ? 'hidden' : e.textContent));
await page.screenshot({ path: OUT + '12-ring-drag.png' });
await page.mouse.up();
check('angle label during drag', label, '90°');
check('ring turned model 90° about Z', await page.evaluate(() => { const s = window.umm.viewer.models[0].size; return [Math.round(s.x), Math.round(s.y), Math.round(s.z)]; }), [24, 42, 40]);
await page.keyboard.press('Control+z');
check('ring turn undone', await page.evaluate(() => { const s = window.umm.viewer.models[0].size; return [Math.round(s.x), Math.round(s.y)]; }), [42, 24]);
await page.keyboard.press('t');
check('rings hidden on move tool', await page.evaluate(() => window.umm.viewer.rings.visible), false);
await page.keyboard.press('r');
await page.screenshot({ path: OUT + '13-rings.png' });
console.log(errors.join('\n') || 'no errors');
await browser.close();
