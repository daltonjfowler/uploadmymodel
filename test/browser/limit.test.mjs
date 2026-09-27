// The teacher's longest-print limit, end to end with the slicer (local only: needs SLICER_URL).
import { chromium } from 'playwright-core';
import { BASE, CHROME, closeSlicing, knowPhrase, openSlicing } from './lib.mjs';
const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await knowPhrase(page);
await openSlicing(page.request, base, key);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const put = (cfg) => page.request.put(base + 'api/teacher/class', { headers: { 'x-teacher-key': key, 'content-type': 'application/json' }, data: cfg });
await page.goto(base + '?debug');
check('teacher sets a 30 min limit', (await put({ maxPrintMinutes: 30 })).status(), 200);
await page.reload();
await page.waitForTimeout(600);
await page.click('#sample');
check('limit shown to the student', await page.$$eval('#action .note', (x) => x.some((e) => e.textContent === "Your teacher's limit: prints up to 30 min.")), true);
await page.click('#action button.primary');
await page.waitForSelector('#action .advice.warn', { timeout: 60000 });
const msg = await page.$eval('#action .advice.warn', (e) => e.textContent);
check('too-long print refused with a hint', /^This print would take about 1 h \d+ min\. Your teacher's limit is 30 min\. Try Fast quality/.test(msg), true);
console.log('  message:', msg);
check('no preview for a refused print', await page.evaluate(() => document.body.dataset.stage ?? 'prepare'), 'prepare');
// Fast quality + no supports + smaller: fits under 2 h
check('teacher raises the limit to 2 h', (await put({ maxPrintMinutes: 120 })).status(), 200);
// The plate is saved 1.5 s after it last changed; a fast refusal comes back sooner than that.
await page.waitForTimeout(2000);
await page.reload();
await page.waitForTimeout(600);
await page.click('#action button.primary');
await page.waitForSelector('#previewCard:not([hidden])', { timeout: 60000 });
check('under the limit: sliced', await page.evaluate(() => document.body.dataset.stage), 'preview');
check('teacher removes the limit', (await put({})).status(), 200);
// Run on its own (not from run.mjs): close the slicing window this test opened.
if (!process.env.UMM_TEST_PHRASE) await closeSlicing(page.request, base, key);
console.log(errors.join('\n') || 'no errors');
await browser.close();
