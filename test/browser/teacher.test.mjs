// Teacher page end to end, against local dev (key from .dev.vars) or a base URL + key.
import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';
const base = process.argv[2] || BASE;
const key = process.argv[3] || 'local-test-key-not-real';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/501|401|400|cloudflareinsights/.test(m.text())) errors.push(m.text()); });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };

// wrong key
await page.goto(base + 'teacher/');
await page.fill('#key', 'wrong-key');
await page.click('#load');
await page.waitForSelector('#status[data-tone="error"]');
check('wrong key refused', await page.$eval('#status', (e) => e.textContent), 'That teacher key was refused. Check it and try again.');
check('setup hidden', await page.$eval('#setup', (e) => e.hidden), true);

// right key: lock walls at 3, infill at 15, set a note, save
await page.fill('#key', key);
await page.click('#load');
await page.waitForSelector('#setup:not([hidden])');
check('7 setting rows', await page.$$eval('#rows tr', (r) => r.length), 7);
check('print limit choices', await page.$$eval('#maxPrint option', (o) => o.map((x) => x.textContent)), ['No limit', '30 min', '45 min', '1 h', '1 h 30 min', '2 h', '3 h', '4 h', '5 h', '8 h']);
await page.selectOption('select[aria-label="Wall count: starts at"]', '3');
await page.click('input[aria-label="Students can change Wall count"] + .switch');
await page.selectOption('select[aria-label="Infill density: starts at"]', '15');
await page.click('input[aria-label="Students can change Infill density"] + .switch');
await page.fill('#message', 'Period 3: under 2 hours please.');
await page.screenshot({ path: OUT + '15-teacher.png', fullPage: true });
await page.click('#save');
await page.waitForSelector('#status[data-tone="ok"]');
check('saved message', await page.$eval('#status', (e) => e.textContent), 'Saved. Locked for students: Wall count, Infill density.');

// public config reflects it
const cfg = await (await page.request.get(base + 'api/class')).json();
check('public config locks', [cfg.open.walls, cfg.open.infillDensity, cfg.open.quality], [false, false, true]);
check('public config defaults', [cfg.defaults.walls, cfg.defaults.infillDensity], [3, 15]);

// student page shows locks + note
const student = await ctx.newPage();
student.on('pageerror', (e) => errors.push('student pageerror: ' + e.message));
await student.goto(base);
await student.waitForSelector('.class-note');
check('note shown', await student.$eval('.class-note', (e) => e.textContent), 'From your teacher: Period 3: under 2 hours please.');
check('infill locked line', await student.$eval('.locked-line', (e) => e.textContent.trim()), '🔒 Infill density15%');
check('summary uses 15%', await student.$eval('.settings-summary', (e) => e.textContent), '0.18 mm · 15% · Tree support · Skirt');
check('tag says class settings', await student.$eval('.profile-tag', (e) => e.textContent), 'Class settings');
await student.click('.seg.tabs button:nth-child(2)');
await student.click('text=Walls');
check('custom shows walls locked', await student.$$eval('.row.lockedrow .row-label', (x) => x.map((e) => e.textContent)).then((l) => l.includes('Wall count')), true);
await student.screenshot({ path: OUT + '16-student-locked.png' });

// server refuses a changed locked setting, accepts the teacher's
const stl = (() => {
  const b = Buffer.alloc(84 + 50); b.writeUInt32LE(1, 80);
  const pts = [[140, 140, 0], [150, 140, 0], [140, 150, 10]];
  let o = 96; for (const p of pts) for (const n of p) { b.writeFloatLE(n, o); o += 4; }
  return b;
})();
const post = (settings) => page.request.post(base + 'api/slice', { multipart: { model: { name: 'p.stl', mimeType: 'model/stl', buffer: stl }, settings: JSON.stringify(settings), name: 'x', modelName: 'y' } });
const bad = await post({ walls: 2, infillDensity: 15 });
check('server refuses unlocked change', [bad.status(), (await bad.json()).locked], [400, ['Wall count']]);
const good = await post({ walls: 3, infillDensity: 15, quality: 'standard' });
check('server accepts teacher values (501 without slicer, 200 with)', [200, 501].includes(good.status()), true);

// put it back to all open
await page.click('#school');
await page.fill('#message', '');
await page.click('#save');
await page.waitForSelector('#status[data-tone="ok"]');
check('reset saved', await page.$eval('#status', (e) => e.textContent), 'Saved. Students can change every setting.');
console.log(errors.join('\n') || 'no errors');
await browser.close();
