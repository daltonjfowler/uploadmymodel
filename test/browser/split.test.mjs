// Right-click menu and "Split into separate objects": one STL with several things in it.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { BASE, CHROME, OUT } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';

function box(x, y, z, s) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [x + a * s, y + b * s, z + c * s]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return t.map((f) => `facet normal 0 0 0\n outer loop\n${f.map((i) => `  vertex ${v[i].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n');
}
function stl(name, boxes) {
  const file = `${OUT}${name}.stl`;
  writeFileSync(file, `solid ${name}\n${boxes.join('\n')}\nendsolid ${name}\n`);
  return file;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const count = () => page.evaluate(() => window.umm.viewer.models.length);
const names = () => page.evaluate(() => window.umm.viewer.models.map((m) => m.name));
const menuItems = () => page.$$eval('#ctxMenu:not([hidden]) [role=menuitem]', (bs) => bs.map((b) => b.children[1].textContent));
// Where model i is on screen: the middle of its box, moved dx mm along X (to aim at one of
// several things in one model).
const screenOf = (i, dx = 0) => page.evaluate(([k, d]) => {
  const v = window.umm.viewer;
  const m = v.models[k];
  const p = m.mesh.position.clone();
  p.x += d;
  p.z = 10;
  p.project(v.camera);
  const r = v.canvas.getBoundingClientRect();
  return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
}, [i, dx]);
const overlaps = () => page.evaluate(() => {
  const ms = window.umm.viewer.models;
  const fp = (m) => { const s = m.size; return [m.position.x - s.x / 2, m.position.y - s.y / 2, m.position.x + s.x / 2, m.position.y + s.y / 2]; };
  let n = 0;
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const [a0, a1, a2, a3] = fp(ms[i]), [b0, b1, b2, b3] = fp(ms[j]);
    if (a0 < b2 && b0 < a2 && a1 < b3 && b1 < a3) n++;
  }
  return n;
});

await page.goto(base);
await page.waitForTimeout(400);

// Three keychains side by side, one more floating above the first, and a Tinkercad-style pair of
// overlapping boxes: 5 things, the pair stays one.
await page.setInputFiles('#fileInput', stl('keychains', [
  box(0, 0, 0, 20), box(40, 0, 0, 20), box(80, 0, 0, 20), box(0, 0, 40, 20), box(120, 0, 0, 20), box(130, 10, 10, 20),
]));
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
await page.waitForTimeout(300);

// Right-click on empty space: plate menu.
const empty = { x: 683, y: 160 };
check('test point is empty plate', await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, empty), 'CANVAS');
await page.mouse.click(empty.x, empty.y, { button: 'right' });
check('empty-space menu', await menuItems(), ['Open model', 'Select all', 'Arrange all']);
await page.keyboard.press('Escape');
check('Escape closes the menu', await page.$eval('#ctxMenu', (m) => m.hidden), true);

// A right-drag pans the camera and opens no menu.
let p = await screenOf(0, 15);
await page.mouse.move(p.x, p.y);
await page.mouse.down({ button: 'right' });
await page.mouse.move(p.x + 60, p.y + 20, { steps: 5 });
await page.mouse.up({ button: 'right' });
check('right-drag opens no menu', await page.$eval('#ctxMenu', (m) => m.hidden), true);

// Right-click the model: it gets selected and the model menu opens.
await page.evaluate(() => window.umm.viewer.select(null));
p = await screenOf(0, 15);
await page.mouse.click(p.x, p.y, { button: 'right' });
check('model menu', (await menuItems())[0], 'Split into separate objects');
check('right-click selects the model', await page.evaluate(() => window.umm.viewer.selection.size), 1);
check('menu has focus for the keyboard', await page.evaluate(() => document.activeElement.closest('#ctxMenu') !== null), true);
await page.screenshot({ path: `${OUT}split-menu.png` });
await page.click('#ctxMenu [role=menuitem]:first-child');
await page.waitForFunction(() => window.umm.viewer.models.length > 1);
check('split into 5 objects', await count(), 5);
check('parts are numbered', await names(), ['keychains 1', 'keychains 2', 'keychains 3', 'keychains 4', 'keychains 5']);
check('all parts selected', await page.evaluate(() => window.umm.viewer.selection.size), 5);
check('the floating part moved off the one below it', await overlaps(), 0);
const sizes = await page.evaluate(() => window.umm.viewer.models.map((m) => Math.round(m.size.x)));
check('the overlapping pair stayed one object', sizes.filter((s) => s === 30).length, 1);
check('toast offers Undo', await page.$eval('.toast .toast-action', (b) => b.textContent), 'Undo');
await page.screenshot({ path: `${OUT}split-done.png` });
const places = await page.evaluate(() => window.umm.viewer.models.map((m) => [m.position.x, m.position.y]));

await page.keyboard.press('Control+z');
check('undo puts it back together', await count(), 1);
await page.keyboard.press('Control+y');
check('redo splits it again', await count(), 5);
check('redo puts the parts in the same places', await page.evaluate(() => window.umm.viewer.models.map((m) => [m.position.x, m.position.y])), places);

// One piece: says so, changes nothing.
await page.evaluate(() => window.umm.viewer.clear());
await page.click('#sample');
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
await page.waitForTimeout(300);
p = await screenOf(0);
await page.mouse.click(p.x, p.y, { button: 'right' });
await page.click('#ctxMenu [role=menuitem]:first-child');
await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('one piece')));
check('one-piece model stays one', await count(), 1);

// Menu Delete works on the right-clicked model.
p = await screenOf(0);
await page.mouse.click(p.x, p.y, { button: 'right' });
await page.click('#ctxMenu [role=menuitem].danger');
check('Delete from the menu', await count(), 0);

check('no page errors', errors, []);
await browser.close();
