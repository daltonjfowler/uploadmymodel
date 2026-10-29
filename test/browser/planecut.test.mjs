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
  await page.click('.tool[data-tool="split"]'); // its own button on the left (2026-10-28)
  await page.click(`#toolPanel button[data-split="${value}"]`);
  await page.waitForTimeout(400);
};

await page.goto(base + '?debug');
await page.waitForTimeout(500);

// 1. a 40 mm cube: Split → By a plane shows one plane
await page.setInputFiles('#fileInput', stl('cube40.stl', [[0, 0, 0, 40, 40, 40]]));
await page.waitForTimeout(800);
await page.click('.tool[data-tool="split"]');
check('split choices', await page.$$eval('#toolPanel button[data-split]', (b) => b.map((x) => x.dataset.split).join(',')), 'parts,loose,plane');
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

// 6. Tilt and size (Dalton's coworker, 2026-10-28): two towers in one file, 40 mm apart
await page.evaluate(() => { window.umm.viewer.selectAll(); window.umm.viewer.removeSelected(); });
await page.setInputFiles('#fileInput', stl('towers.stl', [[0, 0, 0, 20, 20, 40], [40, 0, 0, 20, 20, 40]]));
await page.waitForTimeout(800);
const setCtl = async (label, value) => {
  const box = page.locator(`#toolPanel input[aria-label="Plane 1 ${label}, number"]`);
  await box.fill(String(value));
  await box.press('Tab');
  await page.waitForTimeout(150);
};
await pickSplit('plane');
await page.click('#toolPanel .cutmore summary');
check('tilt and size opens', await page.isVisible('#toolPanel input[aria-label="Plane 1 size along x, number"]'), true);
check('size starts whole', await page.textContent('#toolPanel .cutctl:nth-of-type(3) .unit'), 'mm (whole)');
await setCtl('size along x', 30);
await setCtl('slide along x', -20); // over the left tower only
check('smaller plane drawn with an edge', await page.evaluate(() => window.umm.viewer.cutGroup.children[0].children.length), 1);
await page.screenshot({ path: OUT + 'planecut-small.png' });
await page.click('#toolPanel button:has-text("✂ Cut")');
await page.waitForTimeout(1200);
check('small plane: left tower in two, right tower whole', await models(), 3);
check('small plane: every piece closed', await openEdges(), '0,0,0');
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check('undo puts the towers back', await models(), 1);

await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.waitForTimeout(200);
await pickSplit('plane');
await page.click('#toolPanel .cutmore summary');
await setCtl('size along x', 10); // too small for either tower: nothing is cut
await page.click('#toolPanel button:has-text("✂ Cut")');
await page.waitForTimeout(1000);
check('too small: nothing cut', await models(), 1);
check('too small: says why', await page.isVisible('text=covers all the way across'), true);
await setCtl('size along x', 250); // much bigger than the model: cuts like a whole plane
check('a 250 mm plane is allowed', await page.inputValue('#toolPanel input[aria-label="Plane 1 size along x, number"]'), '250');
check('drawn 250 mm wide', await page.evaluate(() => Math.round(window.umm.viewer.cutGroup.children[0].geometry.parameters.width)), 250);
await page.click('#toolPanel .cutmore button:has-text("Flat and whole again")');
check('reset keeps tilt and size open', await page.isVisible('#toolPanel input[aria-label="Plane 1 tilt round x, number"]'), true);
await setCtl('tilt round x', 30);
await page.screenshot({ path: OUT + 'planecut-tilted.png' });
await page.click('#toolPanel button:has-text("✂ Cut")');
await page.waitForTimeout(1200);
check('tilted plane: both towers cut', await models(), 2);
check('tilted plane: every piece closed', await openEdges(), '0,0');

// 7. Turning a plane the easy way (Dalton, 2026-10-28): drag a ring on it, or line it up with a face
await page.evaluate(() => { window.umm.viewer.selectAll(); window.umm.viewer.removeSelected(); });
await page.setInputFiles('#fileInput', stl('cube-rings.stl', [[0, 0, 0, 40, 40, 40]]));
await page.waitForTimeout(800);
await pickSplit('plane');
check('rings on the plane', await page.evaluate(() => window.umm.viewer.planeRings.visible), true);
// a point on a ring at angle a, on screen
const ringPoint = (deg, which = 'tiltU') => page.evaluate(([a, w]) => {
  const v = window.umm.viewer;
  const g = v.planeRingParts[w].group;
  g.updateMatrixWorld();
  const p = g.localToWorld(new (v.camera.position.constructor)(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), 0));
  p.project(v.camera);
  const r = v.canvas.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}, [deg, which]);
// the green ring (round Y) faces the camera from the front: go 30° round it
// start where only the green ring is under the pointer (not where it crosses the red one)
const grabs = (q) => page.evaluate(({ x, y }) => window.umm.viewer.hitPlaneRing({ clientX: x, clientY: y }), q);
let best = null;
for (let a = 0; a < 360 && !best; a += 15) {
  if ((await grabs(await ringPoint(a, 'tiltV'))) === 'tiltV' && (await grabs(await ringPoint(a + 30, 'tiltV'))) === 'tiltV') best = { a };
}
let from = await ringPoint(best.a, 'tiltV');
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let k = 1; k <= 8; k++) {
  const p = await ringPoint(best.a + (k * 30) / 8, 'tiltV');
  await page.mouse.move(p.x, p.y);
}
await page.mouse.up();
await page.waitForTimeout(300);
const tiltV = await page.evaluate(() => window.umm.cutState().planes[0].tiltV);
check('going round the green ring tilts the plane about 30°', Math.abs(Math.abs(tiltV) - 30) <= 5, true);
check('the panel shows the new tilt', Number(await page.inputValue('#toolPanel input[aria-label="Plane 1 tilt round y, number"]')), tiltV);
// the red ring (round X) is edge-on from the front: dragging up 40 px tilts it 20°
from = await ringPoint(90, 'tiltU');
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let k = 1; k <= 8; k++) await page.mouse.move(from.x, from.y - k * 5);
await page.mouse.up();
await page.waitForTimeout(300);
const tiltU = await page.evaluate(() => window.umm.cutState().planes[0].tiltU);
check('dragging the edge-on red ring up tilts it 20°', tiltU, 20);
await page.screenshot({ path: OUT + 'planecut-rings.png' });
await page.keyboard.press('Escape');

// a wedge: its slope rises 20 mm over 40 mm (26.6°); right-click it, Plane along this face
await page.evaluate(() => { window.umm.viewer.selectAll(); window.umm.viewer.removeSelected(); });
{
  const tris = [
    [[0, 0, 0], [0, 20, 0], [40, 20, 0]], [[0, 0, 0], [40, 20, 0], [40, 0, 0]], // bottom
    [[40, 0, 0], [40, 20, 0], [40, 20, 20]], [[40, 0, 0], [40, 20, 20], [40, 0, 20]], // tall end
    [[0, 0, 0], [40, 0, 20], [40, 20, 20]], [[0, 0, 0], [40, 20, 20], [0, 20, 0]], // slope
    [[0, 0, 0], [40, 0, 0], [40, 0, 20]], [[0, 20, 0], [40, 20, 20], [40, 20, 0]], // sides
  ];
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) { o += 12; for (const p of t) for (const n of p) { buf.writeFloatLE(n, o); o += 4; } o += 2; }
  writeFileSync(OUT + 'wedge.stl', buf);
}
await page.setInputFiles('#fileInput', OUT + 'wedge.stl');
await page.waitForTimeout(800);
await pickSplit('plane');
const slope = await page.evaluate(() => {
  const v = window.umm.viewer, m = v.models[0];
  const p = m.position.clone(); p.z = 10; // the slope's middle (the wedge is centred on its box)
  p.project(v.camera);
  const r = v.canvas.getBoundingClientRect();
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
});
await page.mouse.click(slope.x, slope.y, { button: 'right' });
await page.waitForTimeout(300);
check('menu offers a plane along the face', await page.isVisible('#ctxMenu button:has-text("Plane along this face")'), true);
await page.click('#ctxMenu button:has-text("Plane along this face")');
await page.waitForTimeout(300);
const along = await page.evaluate(() => window.umm.cutState().planes[0]);
check('plane along the slope: tilted 26.6°', Math.abs(Math.hypot(along.tiltU, along.tiltV) - 26.6) < 1, true);
await page.screenshot({ path: OUT + 'planecut-along.png' });
await page.click('#toolPanel button:has-text("✂ Cut")');
await page.waitForTimeout(1200);
check('cut along the slope: pieces closed', (await openEdges()).split(',').every((n) => n === '0'), true);

check('no page errors', errors.join(' | '), '');
await browser.close();
