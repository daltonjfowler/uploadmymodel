// The class gate end to end (local only: needs the slicer, SLICER_URL): closed means the site
// works but Slice does not; the teacher opens it with a phrase; students type it once.
import { chromium } from 'playwright-core';
import { BASE, CHROME, TEST_PHRASE, openSlicing } from './lib.mjs';
const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const teacher = await ctx.newPage();
const student = await ctx.newPage();
for (const p of [teacher, student]) p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Closed: the site works, Slice does not.
await teacher.request.delete(base + 'api/teacher/slicing', { headers: { 'x-teacher-key': key } });
await student.goto(base + '?debug');
await student.waitForTimeout(600);
await student.click('#sample');
await student.waitForTimeout(200);
check('closed notice', await student.$eval('.slicing-status', (e) => e.textContent), 'Slicing is closed right now. Your teacher opens it during class. You can still set up your model.');
check('Slice disabled while closed', await student.$eval('#action button.primary', (b) => b.disabled), true);
await student.keyboard.press('r');
await student.click('.rot-row:nth-child(1) button:nth-of-type(1)');
check('models still work while closed', await student.evaluate(() => window.umm.viewer.models[0].size.x < 30), true);
const direct = await student.request.post(base + 'api/slice', { multipart: { model: { name: 'p.stl', mimeType: 'model/stl', buffer: Buffer.alloc(134) } } });
check('server refuses while closed', [direct.status(), (await direct.json()).error], [403, 'closed']);

// The teacher opens it from the teacher page.
await teacher.goto(base + 'teacher/');
await teacher.fill('#key', key);
await teacher.click('#load');
await teacher.waitForSelector('#slicingCard:not([hidden])');
await teacher.fill('#phraseSet', 'Orange Walrus Taco');
await teacher.selectOption('#slicingMinutes', '50');
await teacher.click('#slicingOpen');
await teacher.waitForSelector('#bigPhrase:not([hidden])');
check('big phrase for the board', await teacher.$eval('#bigPhrase', (e) => e.textContent), 'orange-walrus-taco');
check('teacher sees it open', /^Slicing is open until .+ \((49|50) min left\)\.$/.test(await teacher.$eval('#slicingNow', (e) => e.textContent)), true);

// The student slices: wrong phrase first, then the right one typed loosely.
await student.reload();
await student.waitForTimeout(800);
check('open notice', /^Slicing is open until /.test(await student.$eval('.slicing-status', (e) => e.textContent)), true);
await student.click('#action button.primary');
await student.waitForSelector('#phraseDialog[open]');
await student.fill('#phraseInput', 'purple walrus taco');
await student.press('#phraseInput', 'Enter');
await student.waitForSelector('#phraseError:not([hidden])', { timeout: 30000 });
check('wrong phrase explained', await student.$eval('#phraseError', (e) => e.textContent), 'That class phrase is not right. Check the board and type it again.');
await student.fill('#phraseInput', '  ORANGE walrus_taco ');
await student.click('#phraseDialog button.primary');
await student.waitForSelector('#previewCard:not([hidden])', { timeout: 60000 });
check('right phrase: sliced', await student.evaluate(() => document.body.dataset.stage), 'preview');
// Asked once: the next slice goes straight through.
await student.click('.stage[data-stage=prepare]');
await student.click('.seg.quality button:has-text("Fast")'); // a change, so Slice is back
await student.click('#action button.primary:has-text("Slice")');
await student.waitForSelector('#previewCard:not([hidden])', { timeout: 60000 });
check('not asked again', await student.$eval('#phraseDialog', (d) => d.open), false);

// The teacher closes it again.
await teacher.click('#slicingClose');
await teacher.waitForSelector('#slicingNow.closed');
await student.reload();
await student.waitForTimeout(800);
check('closed again for the student', await student.$eval('#action button.primary', (b) => b.disabled), true);
await openSlicing(teacher.request, base, key); // leave it open for the rest of the suite
check('open status never shows the phrase', JSON.stringify(await (await teacher.request.get(base + 'api/slicing')).json()).includes(TEST_PHRASE), false);
console.log(errors.join('\n') || 'no errors');
await browser.close();
