// Picture to plate: the left-bar button and the I key open the dialog with nothing selected; a PNG
// (picked in the dialog, or opened like a model) becomes a raised, engraved or lithophane plate of
// the size the dialog shows; impossible numbers keep "Put it on the plate" off; one Undo removes it.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { BASE, CHROME, OUT } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';

/** A w × h PNG: a black disc on white. */
function discPng(name, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 3) ** 2 ? 0 : 255;
      raw.fill(v, y * (w * 3 + 1) + 1 + x * 3, y * (w * 3 + 1) + 4 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const file = `${OUT}${name}.png`;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const size = (i) => page.evaluate((k) => { const s = window.umm.viewer.models[k].size; return [s.x, s.y, s.z].map((n) => Math.round(n * 10) / 10); }, i);
const isOpen = () => page.$eval('#pictureDialog', (d) => d.open);
const okOff = () => page.$eval('#picOk', (b) => b.disabled);
const png = discPng('disc', 400, 300);
await page.goto(base);
await page.waitForTimeout(400);

check('Picture button works with nothing on the plate', await page.$eval('#pictureBtn', (b) => b.disabled), false);
await page.click('#pictureBtn');
check('dialog opens', await isOpen(), true);
check('no picture yet: cannot make a plate', await okOff(), true);

await page.setInputFiles('#picInput', png);
await page.waitForFunction(() => !document.querySelector('#picOk').disabled);
check('size line for the default raised plate', await page.$eval('#picSize', (p) => p.textContent), 'Orange stands up. 80 × 61.5 mm, 3.5 mm tall.');
const inked = await page.$eval('#picPreview', (c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let orange = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 2] < 80) orange++;
  return orange > 1000;
});
check('preview draws the disc in orange', inked, true);

// Enter in a number box takes the number; it must not press Cancel.
await page.fill('#picFields input[type="number"] >> nth=0', '60');
await page.keyboard.press('Enter');
check('Enter keeps the dialog open', await isOpen(), true);
check('new width shows', (await page.$eval('#picSize', (p) => p.textContent)).includes('60 ×'), true);

await page.click('#picOk');
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
check('raised plate: name', await page.evaluate(() => window.umm.viewer.models[0].name), 'disc-raised');
check('raised plate: size', await size(0), [60, 46.5, 3.5]);
check('raised plate is selected', await page.evaluate(() => window.umm.viewer.selected === window.umm.viewer.models[0]), true);

// Opened like a model (Open model / drop): the dialog comes up with the picture in it.
await page.setInputFiles('#fileInput', png);
await page.waitForFunction(() => document.querySelector('#pictureDialog').open && !document.querySelector('#picOk').disabled);
check('a PNG opened as a model goes to the dialog', await isOpen(), true);
await page.click('#picKind button:has-text("Lithophane")');
check('lithophane: stands on a foot by default', await page.$eval('#picSize', (p) => p.textContent), 'How it looks with a light behind it. 100 × 19 mm, 76.5 mm tall.');
// The frame holds the foot: too thin a frame cannot stand.
await page.fill('#picFields input[type="number"] >> nth=3', '1');
await page.keyboard.press('Enter');
check('a 1 mm frame cannot stand', [await okOff(), (await page.$eval('#picError', (p) => p.textContent)).includes('Frame of 2 mm')], [true, true]);
await page.fill('#picFields input[type="number"] >> nth=3', '3');
await page.keyboard.press('Enter');
await page.click('#picOk');
await page.waitForFunction(() => window.umm.viewer.models.length === 2);
check('lithophane: standing size', await size(1), [100, 19, 76.5]);
check('standing lithophane has no red (needs-support) faces', await page.evaluate(() => Math.round(window.umm.viewer.models[1].overhangArea)), 0);

// Too big for the printer: the button stays off.
await page.click('#pictureBtn');
await page.click('#picKind button:has-text("Engraved")');
await page.fill('#picFields input[type="number"] >> nth=0', '250');
await page.keyboard.press('Enter');
check('250 mm wide engraved still fits', await okOff(), false);
await page.click('#picKind button:has-text("Raised")');
check('raised kept its own width', (await page.$eval('#picSize', (p) => p.textContent)).includes('60 ×'), true);
await page.keyboard.press('Escape');
check('Esc closes without a plate', [await isOpen(), await page.evaluate(() => window.umm.viewer.models.length)], [false, 2]);

await page.keyboard.press('Control+z');
check('one Undo removes the lithophane', await page.evaluate(() => window.umm.viewer.models.length), 1);

await page.mouse.click(5, 300); // focus the page, not a button
await page.keyboard.press('i');
check('I opens the dialog', await isOpen(), true);
await page.setViewportSize({ width: 360, height: 700 });
const fits = await page.$eval('#pictureDialog', (d) => d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().right <= innerWidth);
check('dialog fits a phone', fits, true);
await page.screenshot({ path: `${OUT}picture-phone.png` });
await page.setViewportSize({ width: 1366, height: 768 });
await page.screenshot({ path: `${OUT}picture-dialog.png` });
check('no page errors', errors, []);
await browser.close();
