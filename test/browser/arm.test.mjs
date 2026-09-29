// The third settings tab, "Assistant to the Regional Manager": locked until the password is right
// (checked by the real local Worker, .dev.vars ARM_KEY), then its extras and pauses go with the
// slice (the slice answer itself is stubbed, so no slicer is needed).
//   UMM_ARM_KEY=<the dev ARM_KEY> node test/browser/arm.test.mjs [base]
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const KEY = process.env.UMM_ARM_KEY || 'dev-arm-key';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };

const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
let sent = null;
await ctx.route('**/api/slicing', (r) => r.fulfill({ json: { engine: false, open: false, until: null } }));
await ctx.route('**/api/slice', async (r) => {
  const body = r.request().postDataBuffer()?.toString('latin1') ?? '';
  const arm = /name="arm"\r\n\r\n([^\r]*)/.exec(body)?.[1];
  sent = { key: r.request().headers()['x-arm-key'] ?? null, arm: arm ? JSON.parse(arm) : null };
  await r.fulfill({ status: 200, body: ';FLAVOR:Marlin\n;LAYER:0\nG1 X1 Y1\n', headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="t.gcode"', 'x-pauses-done': '5@18' } });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(base);
await page.waitForTimeout(400);

const tabs = await page.$$eval('.tabs [role=tab]', (b) => b.map((x) => x.textContent));
check('three tabs', tabs, ['Recommended', 'Custom', '🔒 Assistant to the Regional Manager']);
await page.click('.tabs .arm-tab');
check('locked tab asks for the password', await page.isVisible('.arm-lock input[type=password]'), true);
await page.fill('.arm-lock input', 'not-it');
await page.click('.arm-lock button[type=submit]');
await page.waitForFunction(() => /not right/.test(document.querySelector('.arm-msg')?.textContent ?? ''), null, { timeout: 5000 });
check('wrong password is refused', await page.$eval('.arm-msg', (e) => e.textContent), 'That password is not right. Ask your teacher.');
await page.fill('.arm-lock input', KEY);
await page.click('.arm-lock button[type=submit]');
await page.waitForSelector('.arm-intro', { timeout: 5000 });
check('right password opens the tab', await page.$eval('.tabs .arm-tab', (e) => e.textContent), 'Assistant to the Regional Manager');

// Tiers: the third tab is Custom plus more, in the same sections.
const count = (sel) => page.$$eval(sel, (n) => n.length);
check('every infill pattern in one picker (7 class + 7 more)', await count('.patterns [role=radio]'), 14);
await page.click('.cat-head:has-text("Walls")'); // fuzzy skin lives with the walls
check('fuzz amount is hidden while fuzzy skin is off', await count('select[aria-label="Fuzz amount"]'), 0);
check('wall count offers 1 to 6 in one list', await page.$$eval('.row select[aria-label="Wall count"] option', (o) => o.map((x) => x.value)), ['1', '2', '3', '4', '5', '6']);
await page.click('.cat-rows button:has-text("Add a colour change pause")');
await page.fill('.pause-row input', '5');
await page.press('.pause-row input', 'Enter');
await page.selectOption('select[aria-label="Fuzzy skin"]', 'on');
await page.waitForTimeout(200);
check('fuzz amount shows once fuzzy skin is on', await count('select[aria-label="Fuzz amount"]'), 1);
await page.click('.patterns [role=radio]:has-text("Gyroid")');
await page.click('.patterns [role=radio]:has-text("Cross 3D")');
await page.waitForTimeout(150);
check('an extra pattern is picked in the same picker', await page.$eval('.patterns [aria-checked=true]', (e) => e.textContent.trim()), 'Cross 3D');
await page.click('.tabs [role=tab]:has-text("Custom")');
check('Custom keeps its 7 class patterns', await count('.patterns [role=radio]'), 7);
await page.click('.tabs .arm-tab');
check('header summary shows the extras', /Fuzzy skin/.test(await page.$eval('.settings-summary', (e) => e.textContent)), true);

// Layer height: a 4th choice "Custom…" opens 0.10-0.40 mm; first layer and top/bottom become choices.
check('layer height has Custom as a 4th choice', await page.$$eval('select[aria-label="Layer height"] option', (o) => o.map((x) => x.value)), ['high_speed', 'standard', 'high_detail', 'custom']);
check('first layer height is a choice here', await count('select[aria-label="First layer height"]'), 1);
check('top/bottom thickness is a choice here', await count('select[aria-label="Top and bottom thickness"]'), 1);
await page.selectOption('select[aria-label="Layer height"]', 'custom');
await page.waitForTimeout(150);
await page.selectOption('select[aria-label="Custom layer height"]', '0.12');
await page.waitForTimeout(150);
check('custom 0.12 mm picks Fine detail as the base profile', await page.$eval('select[aria-label="Layer height"]', (s) => s.value), 'custom');
check('header shows the custom height', /0\.12 mm layers/.test(await page.$eval('.settings-summary', (e) => e.textContent)), true);
await page.selectOption('select[aria-label="First layer height"]', '0.30');
await page.screenshot({ path: 'test/browser/.out/arm.png' }).catch(() => {});
await page.click('#sample');
await page.click('#action button.primary');
await page.waitForSelector('#action .result.ok', { timeout: 20000 });
check('slice sends the password', sent?.key, KEY);
check('slice sends the extras', sent?.arm, { settings: { fuzzy: 'on', morePatterns: 'cross_3d', layerHeight: '0.12', firstLayer: '0.30' }, pauses: [5] });
check('result says where it pauses', /Colour change pause at 5 mm \(layer 18\)/.test(await page.$eval('#action .result.ok', (e) => e.textContent)), true);
console.log(errors.join('\n') || 'no errors');
await browser.close();
