import { chromium } from 'playwright-core';
import { BASE, BENCHY, CHROME, OUT, ensureMushroom } from './lib.mjs';
const base = process.argv[2] || BASE;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('501') && !m.text().includes('cloudflareinsights')) errors.push(m.text()); });
await page.goto(base);
await page.waitForTimeout(500);
const size = () => page.$eval('.object-list li.on .obj-size', (e) => e.textContent).catch(() => 'none');
const count = () => page.$eval('#objCount', (e) => e.textContent);
const x = () => page.$eval('#toolPanel input', (i) => i.value).catch(() => 'n/a');
const check = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); if (!ok) process.exitCode = 1; };

check('undo disabled at start', await page.$eval('#undoBtn', (b) => b.disabled), true);
await page.click('#sample');
await page.waitForTimeout(300);
const s0 = await size();
check('undo enabled after add', await page.$eval('#undoBtn', (b) => b.disabled), false);

// drag = one step
await page.mouse.move(683, 405); await page.mouse.down();
await page.mouse.move(720, 430, { steps: 6 }); await page.mouse.move(760, 450, { steps: 6 }); await page.mouse.up();
const xDragged = await x();
await page.keyboard.press('Control+z');
check('drag undone in one step', await x(), '0');
await page.keyboard.press('Control+y');
check('drag redone', await x(), xDragged);

// arrows
await page.click('#toolPanel button.wide'); // center
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+ArrowRight');
check('nudge 1 + 10 mm', await x(), '11');
await page.keyboard.press('Control+z');
check('undo nudge', await x(), '1');

// turn + undo
await page.keyboard.press('r');
await page.click('.rot-row:nth-child(2) button:nth-of-type(1)');
const sTipped = await size();
await page.keyboard.press('Control+z');
check('turn undone', await size(), s0);
await page.keyboard.press('Control+Shift+z');
check('turn redone', await size(), sTipped);
await page.keyboard.press('Control+z');

// mirror twice then undo twice
await page.keyboard.press('m');
await page.click('text=Flip upside down');
await page.keyboard.press('Control+z');
check('mirror undone', await size(), s0);

// fit to bed = one step (scale + move)
await page.keyboard.press('s');
await page.click('text=200%');
check('scaled 200%', await size(), '84 × 48 × 80 mm');
await page.keyboard.press('Control+z');
check('scale undone', await size(), s0);

// delete + undo brings it back; clear + undo
await page.keyboard.press('Control+d');
check('copy made', await count(), '2');
await page.keyboard.press('Delete');
check('deleted', await count(), '1');
await page.keyboard.press('Control+z');
check('delete undone', await count(), '2');
await page.click('#clearPlate');
await page.waitForTimeout(200);
check('plate cleared', await page.$eval('#objects', (e) => e.hidden), true);
await page.click('#undoBtn');
check('clear undone in one step', await count(), '2');
await page.screenshot({ path: OUT + '9-undo.png' });
console.log(errors.join('\n') || 'no errors');
await browser.close();
