// "Do I need supports?" advice in the settings panel, for four made-up models, and its buttons.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { BASE, CHROME, OUT } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';

function box(x, y, z, sx, sy, sz) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return t.map((f) => `facet normal 0 0 0\n outer loop\n${f.map((i) => `  vertex ${v[i].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n');
}
function stl(name, boxes) {
  const file = `${OUT}${name}.stl`;
  writeFileSync(file, `solid ${name}\n${boxes.join('\n')}\nendsolid ${name}\n`);
  return file;
}
const MODELS = {
  cube: [box(0, 0, 0, 20, 20, 20)],
  // A cube with a 4 x 4 mm ledge sticking out near the top: 16 mm² of red.
  ledge: [box(0, 0, 0, 20, 20, 20), box(20, 8, 15, 4, 4, 2)],
  // A small table: the underside of the top is red, with only the bed below it.
  table: [box(0, 0, 0, 5, 5, 20), box(25, 0, 0, 5, 5, 20), box(0, 25, 0, 5, 5, 20), box(25, 25, 0, 5, 5, 20), box(0, 0, 20, 30, 30, 4)],
  // A wide cap on a pillar over a base: much of the cap's underside has the base below it.
  mushroom: [box(0, 0, 0, 40, 40, 10), box(15, 15, 10, 10, 10, 20), box(-10, -10, 30, 60, 60, 5)],
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const advice = () => page.$eval('#settings .advice p', (p) => p.textContent).catch(() => null);
const buttons = () => page.$$eval('#settings .advice-actions button', (bs) => bs.map((b) => b.textContent));
const support = () => page.evaluate(() => window.umm.panel.value.support);
async function open(name) {
  await page.evaluate(() => window.umm.viewer.clear());
  await page.setInputFiles('#fileInput', stl(`support-${name}`, MODELS[name]));
  await page.waitForFunction(() => window.umm.viewer.models.length === 1);
}
// The advice settles once the support check has run (idle, after the search tree is built).
async function adviceStarting(text) {
  await page.waitForFunction((t) => document.querySelector('#settings .advice p')?.textContent.startsWith(t), text, { timeout: 15000 }).catch(() => {});
  return advice();
}

await page.goto(base);
await page.waitForTimeout(400);
check('class default is tree supports touching the bed', await support(), 'buildplate');

await open('cube');
check('cube: no supports needed', (await adviceStarting('Nothing on your model is red'))?.slice(0, 28), 'Nothing on your model is red');
check('cube: offers to turn them off', await buttons(), ['Turn supports off']);
await page.click('#settings .advice-actions button');
check('cube: button turned supports off', await support(), 'none');
check('cube: now says none needed', (await adviceStarting('Nothing hangs'))?.slice(0, 13), 'Nothing hangs');
await page.evaluate(() => window.umm.panel.reset?.());
await page.evaluate(() => window.umm.panel.set('support', 'buildplate'));

await open('ledge');
check('ledge: tiny bit of red', (await adviceStarting('Only a tiny bit is red'))?.slice(0, 22), 'Only a tiny bit is red');

await open('table');
check('table: supports from the bed are right', (await adviceStarting('Good: tree supports'))?.slice(0, 19), 'Good: tree supports');
await page.evaluate(() => window.umm.panel.set('support', 'none'));
check('table, supports off: warns', (await adviceStarting('Red parts hang'))?.slice(0, 14), 'Red parts hang');
check('table, supports off: turn on + show me', await buttons(), ['Turn on tree supports', 'Show me the red']);
await page.click('#settings .advice-actions button:first-child');
check('table: button turned supports on', await support(), 'buildplate');
await page.evaluate(() => window.umm.panel.set('support', 'everywhere'));
check('table, everywhere: says bed is enough', (await adviceStarting('Every red part is above the bed'))?.slice(0, 31), 'Every red part is above the bed');
await page.click('#settings .advice-actions button');
check('table: back to touching build plate', await support(), 'buildplate');

await open('mushroom');
check('mushroom: bed supports cannot reach', (await adviceStarting('Some red parts are above your model'))?.slice(0, 35), 'Some red parts are above your model');
await page.screenshot({ path: `${OUT}supports-mushroom.png` });
check('mushroom: offers Everywhere', (await buttons())[0], 'Use Everywhere');
await page.click('#settings .advice-actions button:first-child');
check('mushroom: now everywhere', await support(), 'everywhere');
check('mushroom: everywhere is right', (await adviceStarting('Good: supports can grow'))?.slice(0, 23), 'Good: supports can grow');
await page.evaluate(() => window.umm.panel.set('support', 'none'));
check('mushroom, off: suggests Everywhere', (await buttons())[0], 'Use Everywhere');
await page.click('#settings .advice-actions button.linkbtn');
await page.waitForTimeout(700);
check('Show me the red turns the view to below', await page.evaluate(() => window.umm.viewer.camera.position.z < 0), true);
await page.evaluate(() => window.umm.panel.set('support', 'buildplate'));

check('no page errors', errors, []);
await browser.close();
