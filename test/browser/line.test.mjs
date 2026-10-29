// Place in line for the slicer, end to end (local only: needs the slicer, SLICER_URL).
// Dalton, 2026-10-29: "it just freezes on Slicing 0 s". Every slice after the first on a page froze:
// the first slice's timer, when its card went away, stopped slice.timer, which by then was the next
// slice's. So: slice twice on one page, and the counter must still count. Then a page whose line
// says "waiting" shows its place, big, and in the tab title.
import { chromium } from 'playwright-core';
import { BASE, CHROME, closeSlicing, knowPhrase, openSlicing } from './lib.mjs';

const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await knowPhrase(ctx);
const page = await ctx.newPage();
await openSlicing(page.request, base, key);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const note = () => page.$eval('#action .slicing-note', (e) => e.textContent).catch(() => null);
const seconds = async () => Number(/Slicing… (\d+) s/.exec((await note()) ?? '')?.[1] ?? -1);

await page.goto(base + '?debug');
await page.waitForTimeout(600);
await page.click('#sample');
await page.waitForTimeout(400);
const title = await page.title();
// A finished slice shows Save; any change (here a settings change, as a student moving a slider)
// brings Slice back. Back to Prepare first, as a student would.
const sliceAgain = async () => {
  await page.click('.stage[data-stage="prepare"]');
  await page.evaluate(() => window.umm.panel.dispatchEvent(new Event('change')));
  await page.waitForTimeout(300);
};

// The slicer answers after 4 s here, so the counter has time to count.
await page.route('**/api/slice', async (route) => {
  await new Promise((r) => setTimeout(r, 4000));
  await route.continue();
});
await page.click('#action button.primary');
await page.waitForTimeout(2600);
check('first slice: the counter counts', (await seconds()) >= 2, true);
await page.waitForSelector('#action .result', { timeout: 60000 });
await page.waitForTimeout(1500); // the first slice's timer sees its card is gone
await sliceAgain();
await page.click('#action button.primary');
await page.waitForTimeout(3600);
check('second slice on the same page: the counter still counts', (await seconds()) >= 2, true);
await page.waitForSelector('#action .result', { timeout: 60000 });
await page.unroute('**/api/slice');

// Waiting: the line says 2 models are ahead, then that this one is next, then that it is slicing.
let answer = { slots: 2, busy: 2, waiting: 3, sliceSeconds: 15, state: 'waiting', ahead: 2, startsInSeconds: 40 };
await page.route('**/api/slice/line?**', (route) => route.request().method() === 'GET'
  ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) })
  : route.continue());
await page.route('**/api/slice', async (route) => {
  await new Promise((r) => setTimeout(r, 9000));
  await route.continue();
});
await sliceAgain();
await page.click('#action button.primary');
await page.waitForTimeout(1000);
const place = () => page.$eval('#action .line-place', (e) => (e.hidden ? null : e.innerText.replace(/\s+/g, ' ').trim())).catch(() => null);
check('place in line shown big', await place(), '#3 in line 2 models ahead of you. Starting in about 40 s.');
check('place in line in the tab title', await page.title(), `(#3 in line) ${title}`);
await page.screenshot({ path: 'test/browser/.out/line-waiting.png' });
answer = { ...answer, ahead: 0, startsInSeconds: 6 };
await page.waitForTimeout(2600);
check('then: you are next', await place(), 'You are next Starting in about 5 s.');
check('title: next', await page.title(), `(Next in line) ${title}`);
answer = { slots: 2, busy: 2, waiting: 0, sliceSeconds: 15, state: 'slicing' };
await page.waitForTimeout(3600);
check('slicing: the place goes away', await place(), null);
check('slicing: the counter counts from its turn', (await seconds()) >= 1 && (await seconds()) <= 3, true);
check('slicing: the title is back', await page.title(), title);
await page.waitForSelector('#action .result', { timeout: 60000 });
check('done: the title stays plain', await page.title(), title);

check('no page errors', errors, []);
await closeSlicing(page.request, base, key);
await browser.close();
