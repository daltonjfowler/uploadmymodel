// Servo pocket and mount for a 9 g servo (Dalton, 2026-10-28).
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

/** Binary STL of one box [sx, sy, sz]. */
function stl(name, [sx, sy, sz]) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [a * sx, b * sy, c * sz]);
  const faces = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  let o = 84;
  for (const f of faces) { o += 12; for (const i of f) for (const n of v[i]) { buf.writeFloatLE(n, o); o += 4; } o += 2; }
  writeFileSync(OUT + name, buf);
  return OUT + name;
}

const info = () => page.evaluate(() => {
  const v = window.umm.viewer;
  return v.models.map((m) => {
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
    return { open: [...uses.values()].filter((n) => n !== 2).length, volume: Math.round(m.volume), height: Math.round(m.size.z * 10) / 10 };
  });
});

await page.goto(base + '?debug');
await page.waitForTimeout(500);

// 1. a 60 x 40 x 30 block: Add a servo puts it on top, a pocket fits
await page.setInputFiles('#fileInput', stl('servo-block.stl', [60, 40, 30]));
await page.waitForTimeout(800);
await page.click('#toolPanel button:has-text("Add a servo")');
await page.waitForTimeout(800);
check('servo panel', await page.textContent('#toolPanel .tp-title strong'), 'Servo (9 g)');
check('see-through servo shown', await page.evaluate(() => Boolean(window.umm.viewer.ghost)), true);
check('thick enough here', await page.isVisible('#toolPanel .advice.warn'), false);
await page.fill('#toolPanel input[aria-label="Servo spin, number"]', '90');
await page.press('#toolPanel input[aria-label="Servo spin, number"]', 'Tab');
await page.screenshot({ path: OUT + 'servo-pocket.png' });
await page.click('#toolPanel button:has-text("Cut pocket")');
await page.waitForTimeout(1500);
let m = await info();
check('still one model', m.length, 1);
check('pocket: closed solid', m[0].open, 0);
check('pocket: material taken away', m[0].volume < 72000 - 5000 && m[0].volume > 72000 - 9000, true);
check('ghost gone after', await page.evaluate(() => Boolean(window.umm.viewer.ghost)), false);
await page.keyboard.press('Control+z');
await page.waitForTimeout(500);
check('undo: whole block again', (await info())[0].volume, 72000);

// 1b. other sides (Dalton, 2026-10-28): the front of the block, slid 10 mm to the right
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.waitForTimeout(200);
await page.click('#toolPanel button:has-text("Add a servo")');
await page.waitForTimeout(400);
check('six sides offered', await page.$$eval('#toolPanel .servosides button', (b) => b.map((x) => x.textContent).join(',')), 'Top,Bottom,Front,Back,Left,Right');
await page.click('#toolPanel .servosides button:has-text("Front")');
await page.waitForTimeout(300);
const aim = () => page.evaluate(() => {
  const s = window.umm.servoState();
  return `${s.normal.x.toFixed(2)},${s.normal.y.toFixed(2)},${s.normal.z.toFixed(2)} x=${s.at.x.toFixed(1)}`;
});
check('front: faces -Y, in the middle', await aim(), '0.00,-1.00,0.00 x=0.0');
await page.fill('#toolPanel input[aria-label="Servo slide ↔, number"]', '10');
await page.press('#toolPanel input[aria-label="Servo slide ↔, number"]', 'Tab');
await page.waitForTimeout(200);
check('slid 10 mm to the right', await aim(), '0.00,-1.00,0.00 x=10.0');
await page.fill('#toolPanel input[aria-label="Servo slide ↔, number"]', '200');
await page.press('#toolPanel input[aria-label="Servo slide ↔, number"]', 'Tab');
await page.waitForTimeout(200);
check('stops at the model edge', await aim(), '0.00,-1.00,0.00 x=30.0');
await page.fill('#toolPanel input[aria-label="Servo slide ↔, number"]', '10');
await page.press('#toolPanel input[aria-label="Servo slide ↔, number"]', 'Tab');
await page.waitForTimeout(200);
await page.screenshot({ path: OUT + 'servo-front.png' });
await page.click('#toolPanel button:has-text("Cut pocket")');
await page.waitForTimeout(1500);
m = await info();
check('front pocket: closed solid', m[0].open, 0);
check('front pocket: material taken away', m[0].volume < 72000 - 5000, true);
check('front pocket: still 30 mm tall', m[0].height, 30);

// 2. a 4 mm plate: too thin for a pocket, so a mount
await page.evaluate(() => { window.umm.viewer.selectAll(); window.umm.viewer.removeSelected(); });
await page.setInputFiles('#fileInput', stl('servo-plate.stl', [60, 40, 4]));
await page.waitForTimeout(800);
await page.click('#toolPanel button:has-text("Add a servo")');
await page.waitForTimeout(500);
check('thin plate: warns', await page.isVisible('#toolPanel .advice.warn'), true);
await page.click('#toolPanel button:has-text("Mount (block on top)")');
await page.waitForTimeout(300);
check('mount chosen', await page.getAttribute('#toolPanel button:has-text("Mount (block on top)")', 'aria-pressed'), 'true');
await page.screenshot({ path: OUT + 'servo-mount.png' });
await page.click('#toolPanel button:has-text("Add mount")');
await page.waitForTimeout(1500);
m = await info();
check('mount: closed solid', m[0].open, 0);
check('mount: block stands on the plate', m[0].height, 24.8);

// 3. Escape leaves servo mode
await page.click('#toolPanel button:has-text("Add a servo")');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('escape: no ghost', await page.evaluate(() => Boolean(window.umm.viewer.ghost)), false);

check('no page errors', errors.join(' | '), '');
await browser.close();
