import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';
import { knowPhrase } from './lib.mjs';
const base = process.argv[2] || BASE;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await knowPhrase(page);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('501') && !m.text().includes('cloudflareinsights')) errors.push(m.text()); });
const check = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); if (!ok) process.exitCode = 1; };
await page.goto(base + '?debug');
await page.waitForTimeout(500);
await page.setInputFiles('#fileInput', ensureMushroom());
await page.waitForTimeout(500);
await page.click('[data-view=below]');
await page.waitForTimeout(600);

const setAngle = async (v) => {
  await page.$eval('input[aria-label="Support overhang angle"]', (i, val) => {
    i.value = String(val);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);
  await page.waitForTimeout(400);
};
check('placement buttons shown', await page.$$eval('.seg.placement button', (b) => b.map((x) => x.textContent).join(' | ')), 'Touching build plate | Everywhere');
check('angle default', await page.$eval('input[aria-label="Support overhang angle"]', (i) => i.value), '60');
await page.screenshot({ path: OUT + '10-angle-60.png' });
await setAngle(40);
await page.screenshot({ path: OUT + '10-angle-40.png' });
check('summary tag changed', await page.$eval('.profile-tag', (e) => e.textContent), 'Changed');
await setAngle(80);
await page.screenshot({ path: OUT + '10-angle-80.png' });
await page.click('.seg.placement button:nth-child(2)');
check('everywhere picked', await page.$eval('.seg.placement button.on', (e) => e.textContent), 'Everywhere');
// turn supports off, then on: placement remembered
await page.click('.toggle:has-text("Tree supports")');
check('controls hidden when off', await page.$$eval('.seg.placement', (x) => x.length), 0);
await page.click('.toggle:has-text("Tree supports")');
check('placement remembered', await page.$eval('.seg.placement button.on', (e) => e.textContent), 'Everywhere');
// custom tab
await page.click('.seg.tabs button:nth-child(2)');
await page.waitForTimeout(200);
check('custom has placement', await page.$$eval('.cat .seg.placement', (x) => x.length), 1);
check('custom angle value', await page.$eval('.cat input[aria-label="Support overhang angle"]', (i) => i.value), '80');
await page.$eval('.cat .seg.placement', (e) => e.scrollIntoView());
await page.screenshot({ path: OUT + '11-custom-support.png' });
// What the page sends is what counts: check the request's settings. Works with or without a
// slicer connected (with one, the answer is G-code instead of the 501 echo).
// (Chrome does not show multipart bodies with files to the test, so read what the page sends:
// runSlice() posts panel.value.)
const sent = await page.evaluate(() => window.umm.panel.value);
const resP = page.waitForResponse('**/api/slice');
await page.click('#action button.primary');
check('page sends support angle 80', sent.supportAngle, 80);
check('page sends everywhere', sent.support, 'everywhere');
const answer = await resP;
await answer.body().catch(() => {}); // the whole file, before the browser closes
console.log('  slice status', answer.status(), (await answer.text().catch(() => '')).slice(0, 160));
check('server accepted it (501 echo or 200 G-code)', [200, 501].includes(answer.status()), true);
if (answer.status() === 501) {
  const body = await answer.json();
  check('server support_angle', body.cura?.support_angle, 80);
  check('server support infill', body.cura?.support_infill_rate, 0);
}
console.log(errors.join('\n') || 'no errors');
await browser.close();
