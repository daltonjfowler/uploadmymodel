// The printer USB test page against a pretend Marlin printer (Web Serial stubbed). The pretend
// printer only answers at 115200, so the page must fall back from 250000. Everything the page sends
// is recorded: it must only ever be the four allowed questions.
import { chromium } from 'playwright-core';
import { BASE, CHROME } from './lib.mjs';
const base = process.argv[2] || BASE;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await ctx.addInitScript(() => {
  const replies = {
    M115: ['FIRMWARE_NAME:Marlin 2.0.9.0.13 (Aug 26 2022) SOURCE_CODE_URL:github.com/lulzbot3d/Marlin PROTOCOL_VERSION:1.0 MACHINE_TYPE:LulzBot TAZ Workhorse EXTRUDER_COUNT:1', 'Cap:SERIAL_XON_XOFF:0', 'Cap:BINARY_FILE_TRANSFER:0', 'Cap:SDCARD:1', 'Cap:LONG_FILENAME:1', 'ok'],
    M105: ['ok T:24.8 /0.0 B:23.9 /0.0 @:0 B@:0'],
    M27: ['Not SD printing', 'ok'],
    M20: ['Begin file list', 'BENCHY~1.GCO 5909969', 'JORDAN~1.GCO 812334', 'End file list', 'ok'],
  };
  window.__sent = [];
  window.__bauds = [];
  const makePort = () => {
    let push = null;
    let baud = 0;
    const port = {
      readable: null,
      writable: null,
      async open(opts) {
        baud = opts.baudRate;
        window.__bauds.push(baud);
        port.readable = new ReadableStream({ start(c) { push = c; } });
        port.writable = new WritableStream({
          write(chunk) {
            const text = new TextDecoder().decode(chunk);
            window.__sent.push(text);
            if (baud !== 115200) return; // wrong speed: silence
            const cmd = text.trim();
            setTimeout(() => push.enqueue(new TextEncoder().encode((replies[cmd] ?? ['echo:Unknown command', 'ok']).join('\r\n') + '\r\n')), 30);
          },
        });
        setTimeout(() => baud === 115200 && push.enqueue(new TextEncoder().encode('start\r\necho: External Reset\r\n')), 50);
      },
      async close() { port.readable = null; port.writable = null; },
    };
    return port;
  };
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => makePort() } });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); if (!ok) process.exitCode = 1; };

const res = await page.goto(base + 'usb-test/');
check('page allows Web Serial for itself', res.headers()['permissions-policy'].includes('serial=(self)'), true);
await page.click('#connect');
await page.waitForSelector('#state[data-tone="ok"]', { timeout: 20000 });
check('fell back to 115200', await page.$eval('#state', (e) => e.textContent), 'Connected at 115200. The printer answered.');
check('tried 250000 first', await page.evaluate(() => window.__bauds), [250000, 115200]);
for (const cmd of ['M105', 'M27', 'M20']) {
  await page.click(`#asks button[data-cmd="${cmd}"]`);
  await page.waitForTimeout(300);
}
const facts = await page.$$eval('#facts dt', (d) => Object.fromEntries(d.map((x) => [x.textContent, x.nextElementSibling.textContent])));
check('firmware read', facts.Firmware, 'Marlin 2.0.9.0.13 (Aug 26 2022)');
check('machine read', facts.Machine, 'LulzBot TAZ Workhorse');
check('SD support read', [facts['SD card support'], facts['Long file names'], facts['Binary file transfer']], ['yes', 'yes', 'no']);
check('temperatures read', facts.Temperatures, 'nozzle 24.8 °C (target 0.0), bed 23.9 °C (target 0.0)');
check('SD status read', facts['SD printing'], 'not printing');
check('files read', facts['Files on the SD card'], '2: BENCHY~1.GCO 5909969, JORDAN~1.GCO 812334');
const sent = await page.evaluate(() => window.__sent.map((s) => s.trim()));
check('only the four questions were ever sent', sent.every((s) => ['M115', 'M105', 'M27', 'M20'].includes(s)), true);
console.log('  sent:', sent.join(' '));
console.log(errors.join('\n') || 'no errors');
await browser.close();
