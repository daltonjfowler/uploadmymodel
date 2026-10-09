// Split by plane and Split every loose piece (Dalton, 2026-10-09).
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { BASE, CHROME, OUT, knowPhrase } from './lib.mjs';

const base = process.argv[2] || BASE;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await knowPhrase(page);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('501') && !m.text().includes('cloudflareinsights')) errors.push(m.text()); });
const check = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); if (!ok) process.exitCode = 1; };

/** Binary STL of boxes [x, y, z, sx, sy, sz]. */
function stl(name, boxes) {
  const tris = [];
  for (const [x, y, z, sx, sy, sz] of boxes) {
    const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
    for (const f of [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]]) tris.push(f.map((i) => v[i]));
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) { o += 12; for (const p of t) for (const n of p) { buf.writeFloatLE(n, o); o += 4; } o += 2; }
  writeFileSync(OUT + name, buf);
  return OUT + name;
}

const models = () => page.evaluate(() => window.umm.viewer.models.length);
/** Open edges in every model (0 = every piece is closed, so it slices solid). */
const openEdges = () => page.evaluate(() => window.umm.viewer.models.map((m) => {
  const p = m.geometry.attributes.position.array;
  const key = (i) => `${p[i].toFixed(4)},${p[i + 1].toFixed(4)},${p[i + 2].toFixed(4)}`;
  const uses = new Map();
  for (let t = 0; t < p.length; t += 9) {
    const k = [key(t), key(t + 3), key(t + 6)];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const e = k[a] < k[b] ? k[a] + '|' + k[b] : k[b] + '|' + k[a];
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((n) => n !== 2).length;
}).join(','));
const pickSplit = async (value) => {
  await page.selectOption('#toolPanel select.splitpick', value);
  await page.waitForTimeout(400);
};

await page.goto(base + '?debug');
await page.waitForTimeout(500);

// 1. a 40 mm cube: Split → By a plane shows one plane
await page.setInputFiles('#fileInput', stl('cube40.stl', [[0, 0, 0, 40, 40, 40]]));
await page.waitForTimeout(800);
check('split dropdown choices', await page.$$eval('#toolPanel select.splitpick option', (o) => o.map((x) => x.value).join(',')), ',parts,loose,plane');
await pickSplit('plane');
check('one plane row', await page.$$eval('#toolPanel .cutrow', (r) => r.length), 1);
check('one plane drawn', await page.evaluate(() => window.umm.viewer.cutGroup.children.length), 1);

// 2. right-click the cube: add a left | right plane where clicked
const c = await page.evaluate(() => {
  const v = window.umm.viewer, m = v.models[0];
  const p = m.position.clone(); p.z = 20;
  p.project(v.camera);
  const r = v.canvas.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
});
await page.mouse.click(c.x, c.y, { button: 'right' });
await page.waitForTimeout(300);
check('menu offers a plane here', await page.isVisible('#ctxMenu button:has-text("Cut plane here: left | right (X)")'), true);
await page.click('#ctxMenu button:has-text("Cut plane here: left | right (X)")');
await page.waitForTimeout(300);
check('two plane rows', await page.$$eval('#toolPanel .cutrow', (r) => r.length), 2);
await page.screenshot({ path: OUT + 'planecut-planes.png' });

// 3. Cut: four closed pieces, one Undo step
await page.click('#toolPanel button:has-text("✂ Cut")');
await page.waitForTimeout(1200);
check('four pieces', await models(), 4);
check('every piece closed', await openEdges(), '0,0,0,0');
check('planes gone after the cut', await page.evaluate(() => window.umm.viewer.cutGroup.children.length), 0);
await page.screenshot({ path: OUT + 'planecut-pieces.png' });
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check('undo puts the cube back', await models(), 1);

// 4. Escape leaves plane mode without cutting
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.waitForTimeout(200);
await pickSplit('plane');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('escape: no plane rows', await page.$$eval('#toolPanel .cutrow', (r) => r.length), 0);
check('escape: still one model', await models(), 1);

// 5. two boxes pushed into each other: Separate parts keeps them, Every loose piece splits them
await page.evaluate(() => window.umm.viewer.removeSelected());
await page.setInputFiles('#fileInput', stl('overlap.stl', [[0, 0, 0, 30, 30, 30], [20, 20, 10, 30, 30, 30]]));
await page.waitForTimeout(800);
await pickSplit('parts');
check('separate parts keeps overlapping boxes together', await models(), 1);
await pickSplit('loose');
check('every loose piece splits them', await models(), 2);

check('no page errors', errors.join(' | '), '');
await browser.close();
