// "Copy to printer (USB)" on the student page, with the slice answer and the printer both pretend
// (no slicer needed). The pretend Workhorse boots, lists its card and writes M28 lines to a file;
// any line it would RUN is recorded, and there must be none.
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';
const base = (process.argv[2] || BASE) + '?debug';
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };
const GCODE = [';FLAVOR:Marlin', 'M104 S215', 'G28', ...Array.from({ length: 2000 }, (_, i) => `G1 X${i % 90}.5 Y${i % 70}.5 E${i}`), 'M104 S0'].join('\n');

const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await ctx.addInitScript(() => {
  window.__printer = { written: [], run: [], savedAs: null };
  const makePort = () => {
    let push;
    let saving = false;
    let booting = true;
    let pending = '';
    const say = (...l) => setTimeout(() => push.enqueue(new TextEncoder().encode(l.map((x) => `${x}\r\n`).join(''))), 1);
    const handle = (raw) => {
      if (booting || !raw.trim()) return;
      const m = /^N\d+\s+(.*)\*\d+$/.exec(raw.trim());
      const line = m ? m[1] : raw.trim();
      if (saving) {
        if (/M29(?!\d)/.test(line)) { saving = false; return say('Done saving file.', 'ok P15 B3'); }
        window.__printer.written.push(line);
        return say('ok P15 B3');
      }
      if (line === 'M115' && !port.spared) { port.spared = true; say('echo:SD card ok', 'X:-50.00 Y:-17.00 Z:297.00', 'ok P15 B2'); } // like the school Workhorse
      if (line === 'M115') return say('FIRMWARE_NAME:Marlin  FIRMWARE_VERSION:2.0.9.0.13 MACHINE_TYPE:TAZ Workhorse Edition', 'Cap:SDCARD:1', 'Cap:SD_WRITE:1', 'ok P15 B3');
      if (line === 'M27') return say('Not SD printing', 'ok P15 B3');
      if (line === 'M20') return say('Begin file list', 'JORDAN01.GCO 1000', 'End file list', 'ok P15 B3');
      if (/^M110/.test(line) || /^M29/.test(line)) return say('ok P15 B3');
      const open = /^M28 (\S+)/.exec(line);
      if (open) { saving = true; window.__printer.savedAs = open[1]; return say(`Writing to file: ${open[1]}`, 'ok P15 B3'); }
      window.__printer.run.push(line);
      return say('ok P15 B3');
    };
    const port = {
      readable: null,
      writable: null,
      async open() {
        port.readable = new ReadableStream({ start(c) { push = c; } });
        port.writable = new WritableStream({
          write(chunk) {
            pending += new TextDecoder().decode(chunk);
            let i;
            while ((i = pending.indexOf('\n')) >= 0) { handle(pending.slice(0, i)); pending = pending.slice(i + 1); }
          },
        });
        say('start', 'Marlin 2.0.9.0.13');
        setTimeout(() => { booting = false; }, 300);
      },
      async close() {},
    };
    return port;
  };
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => makePort() } });
});
await ctx.route('**/api/slicing', (r) => r.fulfill({ json: { engine: false, open: false, until: null } }));
await ctx.route('**/api/slice', (r) => r.fulfill({
  status: 200, body: GCODE, headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="jordan-rocket.gcode"', 'x-print-summary': 'test' },
}));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(base);
await page.waitForTimeout(400);
await page.click('#sample');
await page.fill('.name-field input[autocomplete="given-name"]', 'Jordan');
await page.click('#action button.primary');
const copy = page.locator('#usbBox button', { hasText: 'Copy to printer' });
await copy.waitFor({ timeout: 20000 });
check('Copy to printer button shows next to Save', await copy.isVisible(), true);
await copy.click();
await page.waitForSelector('#usbBox .advice', { timeout: 60000 });
const msg = await page.$eval('#usbBox .advice', (e) => e.textContent);
check('saved under a new short name', /Saved on the printer as JORDAN02\.GCO/.test(msg), true);
const pr = await page.evaluate(() => window.__printer);
check('file name on the card', pr.savedAs, 'JORDAN02.GCO');
check('every line written (comments dropped)', pr.written.length, 2003);
check('nothing was run on the printer', pr.run, []);
await page.screenshot({ path: 'test/browser/.out/usbcopy.png' }).catch(() => {});
console.log(errors.join('\n') || 'no errors');
await browser.close();
