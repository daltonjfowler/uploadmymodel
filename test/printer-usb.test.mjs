// Copy to the printer's SD card over USB (web/src/printer-usb.js) against a pretend Workhorse:
// Marlin 2.0.9 answers as the school printer did on 2026-09-28, checks line numbers and checksums,
// and in M28 mode WRITES lines instead of running them. The main thing checked: no line of the
// file is ever run, only written, even when a line is garbled or the printer restarts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PrinterUsb, cardLines, checksum, numbered, sdName } from '../web/src/printer-usb.js';

const CAPS = ['FIRMWARE_NAME:Marlin  FIRMWARE_VERSION:2.0.9.0.13 MACHINE_TYPE:TAZ Workhorse Edition EXTRUDER_COUNT:1',
  'Cap:BINARY_FILE_TRANSFER:0', 'Cap:SDCARD:1', 'Cap:SD_WRITE:1', 'Cap:LONG_FILENAME:1', 'ok P15 B3'];

function fakeWorkhorse({ garbleLine = -1, restartAfterLines = -1, files = ['LIZ_SC~1.GCO', 'JORDAN01.GCO'] } = {}) {
  const pr = { written: [], run: [], saving: false, savedAs: null, closed: 0 };
  let push;
  let booting = true;
  let lastN = 0;
  let flushUntil = 0;
  let fileLines = 0;
  let pending = '';
  const say = (...lines) => setTimeout(() => push?.enqueue(new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(''))), 1);
  const boot = () => {
    booting = true;
    pr.saving = false; // a reset closes the file: from now on lines would RUN
    say('start', 'Marlin 2.0.9.0.13');
    setTimeout(() => say('echo:V83 stored settings retrieved (620 bytes; crc 9087)'), 150);
    setTimeout(() => { booting = false; }, 200);
  };
  const handle = (raw) => {
    if (booting) return;
    let line = raw.trim();
    if (!line) return;
    const m = /^N(\d+)\s+(.*)\*(\d+)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = line.slice(0, line.lastIndexOf('*'));
      if (Date.now() < flushUntil && n !== lastN + 1) return; // Marlin flushed its buffer after an error
      if (checksum(body) !== Number(m[3])) {
        flushUntil = Date.now() + 100;
        say('Error:checksum mismatch, Last Line: ' + lastN, `Resend: ${lastN + 1}`, 'ok');
        return;
      }
      if (!/^M110/.test(m[2]) && n !== lastN + 1) {
        flushUntil = Date.now() + 100;
        say(`Error:Line Number is not Last Line Number+1, Last Line: ${lastN}`, `Resend: ${lastN + 1}`, 'ok');
        return;
      }
      lastN = /^M110/.test(m[2]) ? 0 : n;
      line = m[2];
    }
    if (pr.saving) {
      if (/M29(?!\d)/.test(line)) { pr.saving = false; pr.closed++; say('Done saving file.', 'ok P15 B3'); return; }
      pr.written.push(line);
      fileLines++;
      if (fileLines === restartAfterLines) { boot(); return; }
      say('ok P15 B3');
      return;
    }
    if (/^M110/.test(line)) return say('ok P15 B3');
    if (line === 'M115' && spare) {
      spare = false;
      return say('echo:SD card ok', 'X:-50.00 Y:-17.00 Z:297.00 E:0.00 Count X:-5000 Y:-1700 Z:148500', 'ok P15 B2', ...CAPS);
    }
    if (line === 'M115') return say(...CAPS);
    if (line === 'M27') return say('Not SD printing', 'ok P15 B3');
    if (line === 'M20') return say('Begin file list', ...files.map((f) => `${f} 1000`), 'End file list', 'ok P15 B3');
    if (/^M29/.test(line)) return say('ok P15 B3');
    const open = /^M28 (\S+)/.exec(line);
    if (open) { pr.saving = true; pr.savedAs = open[1]; return say(`Writing to file: ${open[1]}`, 'ok P15 B3'); }
    pr.run.push(line); // the printer would heat or move here
    say('ok P15 B3');
  };
  let spare = true; // the real Workhorse's first answer after boot starts with a spare "ok"
  let garbled = false;
  pr.port = {
    readable: null,
    writable: null,
    async open() {
      pr.port.readable = new ReadableStream({ start(c) { push = c; } });
      pr.port.writable = new WritableStream({
        write(chunk) {
          pending += new TextDecoder().decode(chunk);
          let i;
          while ((i = pending.indexOf('\n')) >= 0) {
            let line = pending.slice(0, i);
            pending = pending.slice(i + 1);
            if (!garbled && garbleLine >= 0 && pr.saving && fileLines === garbleLine) {
              garbled = true;
              line = line.replace(/X/, 'Y'); // one flipped byte on the wire
            }
            handle(line);
          }
        },
      });
      boot();
    },
    async close() { try { push?.close(); } catch { /* closed */ } },
  };
  return pr;
}

const GCODE = [';FLAVOR:Marlin', ';Generated with Cura_SteamEngine 4.13.2', 'M104 S215 ; heat', 'G28 ; home', '',
  ...Array.from({ length: 300 }, (_, i) => `G1 X${(i % 50) + 10}.5 Y${Math.floor(i / 50) + 20}.25 E${(i * 0.01).toFixed(3)}`),
  ';LAYER:1', 'M104 S0', 'M140 S0'].join('\n');

test('checksum and numbered lines match Marlin', () => {
  assert.equal(checksum('N1 M28 JORDAN01.GCO'), [...'N1 M28 JORDAN01.GCO'].reduce((a, c) => a ^ c.charCodeAt(0), 0));
  assert.match(numbered(5, 'G28'), /^N5 G28\*\d+$/);
});

test('cardLines drops comments and blank lines, refuses SD commands', () => {
  const lines = cardLines(GCODE);
  assert.equal(lines[0], 'M104 S215');
  assert.equal(lines[1], 'G28');
  assert.ok(lines.every((l) => l && !l.includes(';')));
  assert.equal(lines.length, 2 + 300 + 2);
  for (const bad of ['G1 X1\nM29\nG1 X2', 'M28 OTHER.GCO', 'G1 X1 M30', 'M32 P']) assert.throws(() => cardLines(bad), /SD card command/, bad);
  assert.doesNotThrow(() => cardLines('M290 Z0.1')); // babystep is not an SD command
  assert.throws(() => cardLines('G1 X1*12'), /characters/);
});

test('sdName: short, safe, never an existing name', () => {
  assert.equal(sdName("Jordan's Benchy", []), 'JORDAN01.GCO');
  assert.equal(sdName('jordan-benchy', ['JORDAN01.GCO', 'jordan02.gco']), 'JORDAN03.GCO');
  assert.equal(sdName('!!!', []), 'PRINT01.GCO');
  assert.equal(sdName('Al', []), 'AL01.GCO');
  assert.throws(() => sdName('a', Array.from({ length: 99 }, (_, i) => `A${String(i + 1).padStart(2, '0')}.GCO`)), /99 files/);
});

test('copy: every line written to the card, none run, file closed', async () => {
  const pr = fakeWorkhorse();
  const printer = new PrinterUsb(pr.port);
  await printer.open();
  const card = await printer.cardState();
  assert.deepEqual(card, { printing: false, files: ['LIZ_SC~1.GCO', 'JORDAN01.GCO'] });
  const name = sdName('Jordan', card.files);
  const lines = cardLines(GCODE);
  const seen = [];
  await printer.copy(lines, name, { onProgress: (d, t) => seen.push(d / t) });
  await printer.close();
  assert.equal(pr.savedAs, 'JORDAN02.GCO');
  assert.deepEqual(pr.written, lines);
  assert.deepEqual(pr.run, []);
  assert.equal(pr.closed, 1);
  assert.equal(seen.at(-1), 1);
});

test('copy: a garbled line is sent again, the file is still exact', async () => {
  const pr = fakeWorkhorse({ garbleLine: 120 });
  const printer = new PrinterUsb(pr.port);
  await printer.open();
  const lines = cardLines(GCODE);
  await printer.copy(lines, 'TEST01.GCO');
  await printer.close();
  assert.deepEqual(pr.written, lines);
  assert.deepEqual(pr.run, []);
});

test('copy: the printer restarts halfway -> the copy stops and nothing runs', async () => {
  const pr = fakeWorkhorse({ restartAfterLines: 100 });
  const printer = new PrinterUsb(pr.port);
  await printer.open();
  await assert.rejects(printer.copy(cardLines(GCODE), 'TEST01.GCO'), /restarted/);
  await new Promise((r) => setTimeout(r, 500)); // anything still on its way arrives while it boots
  await printer.close();
  assert.equal(pr.written.length, 100);
  assert.deepEqual(pr.run, []);
});

test('copy: cancel closes the file', async () => {
  const pr = fakeWorkhorse();
  const printer = new PrinterUsb(pr.port);
  await printer.open();
  const ac = new AbortController();
  const p = printer.copy(cardLines(GCODE), 'TEST01.GCO', { signal: ac.signal, onProgress: (d, t) => d / t > 0.3 && ac.abort() });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await printer.close();
  assert.ok(pr.written.length < 304);
  assert.equal(pr.saving, false);
  assert.deepEqual(pr.run, []);
});

test('a printer that cannot write to its card is refused before anything is sent', async () => {
  const pr = fakeWorkhorse();
  const i = CAPS.indexOf('Cap:SD_WRITE:1');
  CAPS[i] = 'Cap:SD_WRITE:0';
  try {
    await assert.rejects(new PrinterUsb(pr.port).open(), /cannot save files/);
  } finally {
    CAPS[i] = 'Cap:SD_WRITE:1';
  }
});
