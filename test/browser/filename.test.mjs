// Students name the file for the SD card; Save uses Chrome's save dialog (stubbed here), or a
// download where there is none. Needs the slicer (local only: SLICER_URL).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { BASE, CHROME } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const errors = [];

async function sliced(page) {
  await page.goto(base);
  await page.waitForTimeout(400);
  await page.click('#sample');
  await page.fill('.name-field input[autocomplete="given-name"]', 'Jordan');
}

// 1. Chrome's save dialog: the name the student typed is suggested, and the file is written.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => {
    window.__saved = null;
    window.showSaveFilePicker = async (opts) => ({
      name: opts.suggestedName,
      createWritable: async () => {
        const parts = [];
        return { write: async (b) => parts.push(await b.text()), close: async () => { window.__saved = { name: opts.suggestedName, text: parts.join('') }; } };
      },
    });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await sliced(page);
  check('placeholder is the default name', await page.$eval('#fileNameInput', (i) => i.placeholder), 'jordan-support-test');
  await page.fill('#fileNameInput', 'My Rocket!!');
  check('preview shows the cleaned name', await page.$eval('#fileNamePreview', (e) => e.textContent), 'my-rocket.gcode');
  await page.click('#action button.primary');
  await page.waitForSelector('#previewCard:not([hidden])', { timeout: 60000 });
  await page.fill('#fileNameInput', 'boat 2'); // renamed after slicing: no need to slice again
  await page.click('#action button.primary:has-text("Save to SD card")');
  await page.waitForFunction(() => window.__saved, null, { timeout: 10000 });
  const saved = await page.evaluate(() => window.__saved);
  check('save dialog got the new name', saved.name, 'boat-2.gcode');
  check('file content is the G-code', saved.text.startsWith(';FLAVOR:Marlin'), true);
  check('saved message', await page.$$eval('.toast span', (x) => x.some((e) => e.textContent.startsWith('Saved boat-2.gcode'))), true);
  await ctx.close();
}

// 2. No save dialog (other browsers): a normal download with the name.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  await ctx.addInitScript(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await sliced(page);
  await page.click('#action button.primary');
  await page.waitForSelector('#previewCard:not([hidden])', { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#action button.primary:has-text("Save to SD card")')]);
  check('download uses the default name', dl.suggestedFilename(), 'jordan-support-test.gcode');
  check('downloaded G-code', readFileSync(await dl.path(), 'utf8').startsWith(';FLAVOR:Marlin'), true);
  await ctx.close();
}
console.log(errors.join('\n') || 'no errors');
await browser.close();
