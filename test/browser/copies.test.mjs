// Copy asks how many (Dalton 2026-11-12), and a plate has no object cap any more (was 12).
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('501') && !m.text().includes('cloudflareinsights')) errors.push(m.text()); });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const count = () => page.evaluate(() => window.umm.viewer.models.length);
// Any two models whose footprints overlap (each copy should find its own free spot).
const overlaps = () => page.evaluate(() => {
  const ms = window.umm.viewer.models;
  let n = 0;
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const a = ms[i], b = ms[j];
    if (Math.abs(a.position.x - b.position.x) < (a.size.x + b.size.x) / 2 && Math.abs(a.position.y - b.position.y) < (a.size.y + b.size.y) / 2) n++;
  }
  return n;
});

await page.goto(base);
await page.evaluate(() => { try { indexedDB.deleteDatabase('umm'); } catch {} });
await page.waitForTimeout(500);
await page.click('#sample');
await page.waitForFunction(() => window.umm.viewer.models.length === 1);
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));

// Copy button: the dialog, Cancel changes nothing
await page.click('#dupBtn');
check('dialog opens', await page.$eval('#copiesDialog', (d) => d.open), true);
check('starts at 1', await page.$eval('#copiesInput', (i) => i.value), '1');
await page.click('#copiesDialog button[value="cancel"]');
check('cancel: still 1 model', await count(), 1);

// 15 copies at once (more than the old 12-object cap), Enter in the box = Copy
await page.click('#dupBtn');
await page.fill('#copiesInput', '15');
await page.press('#copiesInput', 'Enter');
await page.waitForTimeout(300);
check('15 copies made', await count(), 16);
check('the 15 copies selected', await page.evaluate(() => window.umm.viewer.selection.size), 15);
check('no copy sits on another', await overlaps(), 0);
check('object count shown', await page.$eval('#objCount', (e) => e.textContent), '16');

// one Undo removes all 15, Redo brings them back
await page.keyboard.press('Control+z');
check('one undo: back to 1', await count(), 1);
await page.keyboard.press('Control+y');
check('redo: 16 again', await count(), 16);

// Ctrl+D stays a quick single copy, past 12 objects without complaint
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.keyboard.press('Control+d');
await page.waitForTimeout(200);
check('Ctrl+D one more', await count(), 17);

// two selected, 3 copies each = 6 more
await page.evaluate(() => { const v = window.umm.viewer; v.selectMany(v.models.slice(0, 2), v.models[1]); });
await page.click('#dupBtn');
check('dialog names the selection', await page.$eval('#copiesWhat', (e) => e.textContent), 'each of the 2 selected models');
await page.fill('#copiesInput', '3');
await page.click('#copiesDialog button[value="ok"]');
await page.waitForTimeout(300);
check('3 copies of 2 models', await count(), 23);

// a bed that is full: copies that find no room are reported, never refused
await page.evaluate(() => window.umm.viewer.select(window.umm.viewer.models[0]));
await page.click('#dupBtn');
await page.fill('#copiesInput', '120');
await page.press('#copiesInput', 'Enter');
await page.waitForTimeout(800);
check('120 more copies made', await count(), 143);
check('no-room note shown', await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /did not find room/.test(t.textContent))), true);

check('no page errors', errors, []);
await browser.close();
