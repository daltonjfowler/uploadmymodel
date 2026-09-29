// Materials (PLA / PETG / TPU): hidden while the teacher allows only PLA; with more allowed, the
// student picks one in Recommended, the chip and the file name follow, and the slice sends it.
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const errors = [];

async function open(materials) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  let sent = null;
  await ctx.route('**/api/slicing', (r) => r.fulfill({ json: { engine: false, open: false, until: null } }));
  await ctx.route('**/api/class', async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    await r.fulfill({ json: materials ? { ...body, materials } : body });
  });
  await ctx.route('**/api/slice', async (r) => {
    const body = r.request().postDataBuffer()?.toString('latin1') ?? '';
    sent = JSON.parse(/name="settings"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? 'null');
    await r.fulfill({ status: 200, body: ';FLAVOR:Marlin\n;LAYER:0\nG1 X1 Y1\n', headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="t.gcode"' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base);
  await page.waitForTimeout(600);
  return { page, sent: () => sent };
}

{
  const { page } = await open(null);
  check('PLA only: no material buttons in Recommended', await page.$$eval('.seg.material button', (b) => b.length), 0);
  check('chip says PLA', await page.$eval('#printerChip small', (e) => e.textContent), 'SE 0.50 mm · PolyLite PLA');
}
{
  const { page, sent } = await open(['polylite_pla', 'polylite_petg', 'polyflex_tpu95']);
  check('three materials to pick', await page.$$eval('.seg.material button', (b) => b.map((x) => x.textContent)), ['PLA', 'PETG', 'TPU (flexible)']);
  await page.click('.seg.material button:has-text("PETG")');
  await page.waitForTimeout(150);
  check('chip follows the material', await page.$eval('#printerChip small', (e) => e.textContent), 'SE 0.50 mm · PolyLite PETG');
  await page.click('.tabs [role=tab]:has-text("Custom")');
  check('Custom shows the Material section', await page.isVisible('.cat-head:has-text("Material")'), true);
  await page.click('.tabs [role=tab]:has-text("Recommended")');
  await page.click('#sample');
  await page.fill('.name-field input[autocomplete="given-name"]', 'Jordan');
  check('file name ends in -petg', /-petg\.gcode$/.test(await page.$eval('#fileNamePreview', (e) => e.textContent)), true);
  await page.click('#action button.primary');
  await page.waitForSelector('#action .result.ok', { timeout: 20000 });
  check('slice sends the material', sent()?.material, 'polylite_petg');
}
console.log(errors.join('\n') || 'no errors');
await browser.close();
