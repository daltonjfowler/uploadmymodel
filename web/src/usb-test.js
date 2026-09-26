// Printer USB test: talk to the Workhorse's Marlin firmware over Web Serial, read-only. Only the
// four questions in ASK can ever be sent (no free typing): nothing here heats, moves or prints.
// What we learn (does it connect, which speed, firmware version, SD card, file names) decides how
// "print from USB" should work (docs/USB_PRINTING.md).

import './style.css';
import { $, el } from './dom.js';
import { initThemeButton } from './theme.js';

initThemeButton($('#theme'));

const ASK = new Set(['M115', 'M105', 'M27', 'M20']);
const log = $('#log');
let port = null;
let reader = null;
let lines = []; // waiting for the next "ok"
let waiters = [];
let buffer = '';

function write(text, cls = '') {
  const line = el('span', { class: cls }, `${text}\n`);
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function state(text, tone = 'plain') {
  $('#state').textContent = text;
  $('#state').dataset.tone = tone;
}

function onLine(line) {
  write(`< ${line}`);
  lines.push(line);
  if (/^ok\b/.test(line)) {
    const got = lines;
    lines = [];
    waiters.shift()?.(got);
  }
}

async function readLoop() {
  const decoder = new TextDecoder();
  while (port?.readable) {
    reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(buffer[i] === '\r' ? i + 2 : i + 1);
          if (line) onLine(line);
        }
      }
    } catch (e) {
      write(`(read stopped: ${e.message})`, 'muted');
    } finally {
      reader.releaseLock();
      reader = null;
    }
    if (!port) break;
  }
}

/** Send one of the allowed questions; resolves with the reply lines, or null after timeoutMs. */
async function ask(cmd, timeoutMs = 4000) {
  if (!ASK.has(cmd)) throw new Error('not allowed');
  const w = port.writable.getWriter();
  write(`> ${cmd}`, 'sent');
  await w.write(new TextEncoder().encode(`${cmd}\n`));
  w.releaseLock();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiters = waiters.filter((f) => f !== done);
      resolve(null);
    }, timeoutMs);
    const done = (got) => {
      clearTimeout(t);
      resolve(got);
    };
    waiters.push(done);
  });
}

function fact(label, value) {
  const dl = $('#facts');
  const old = [...dl.querySelectorAll('dt')].find((d) => d.textContent === label);
  if (old) {
    old.nextElementSibling.textContent = value;
    return;
  }
  dl.append(el('dt', {}, label), el('dd', {}, value));
}

function readFacts(cmd, got) {
  const text = got.join('\n');
  if (cmd === 'M115') {
    const fw = /FIRMWARE_NAME:([^\n]*?)(?:\s+SOURCE_CODE_URL|\s+PROTOCOL_VERSION|\s+MACHINE_TYPE|$)/m.exec(text);
    if (fw) fact('Firmware', fw[1].trim());
    const mt = /MACHINE_TYPE:([^\n]*?)(?:\s+EXTRUDER_COUNT|$)/m.exec(text);
    if (mt) fact('Machine', mt[1].trim());
    const cap = (name) => { const m = new RegExp(`Cap:${name}:(\\d)`).exec(text); return m ? (m[1] === '1' ? 'yes' : 'no') : 'not reported'; };
    fact('SD card support', cap('SDCARD'));
    fact('Long file names', cap('LONG_FILENAME'));
    fact('Binary file transfer', cap('BINARY_FILE_TRANSFER'));
  }
  if (cmd === 'M105') {
    const m = /T:([\d.]+)\s*\/([\d.]+).*B:([\d.]+)\s*\/([\d.]+)/.exec(text);
    if (m) fact('Temperatures', `nozzle ${m[1]} °C (target ${m[2]}), bed ${m[3]} °C (target ${m[4]})`);
  }
  if (cmd === 'M27') fact('SD printing', /Not SD printing/i.test(text) ? 'not printing' : (got.find((l) => !/^ok/.test(l)) ?? 'no answer'));
  if (cmd === 'M20') {
    const files = got.filter((l) => !/^(ok|Begin file list|End file list)/i.test(l));
    fact('Files on the SD card', files.length ? `${files.length}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}` : 'none (or no card)');
  }
}

async function openAt(baud) {
  await port.open({ baudRate: baud, bufferSize: 8192 });
  readLoop();
  // Opening resets many boards (Marlin prints "start"); give it a moment, then ask who it is.
  await new Promise((r) => setTimeout(r, 2500));
  const got = await ask('M115', 3000);
  if (got) return got;
  await close();
  return null;
}

async function close() {
  const p = port;
  port = null;
  try {
    await reader?.cancel();
  } catch { /* already stopped */ }
  try {
    await p?.close();
  } catch { /* already closed */ }
}

$('#connect').addEventListener('click', async () => {
  if (!('serial' in navigator)) {
    state('This browser cannot use USB serial. Use Chrome on a Chromebook or computer.', 'error');
    return;
  }
  let chosen;
  try {
    chosen = await navigator.serial.requestPort({});
  } catch {
    state('No printer picked.', 'error');
    return;
  }
  const choice = $('#baud').value;
  const speeds = choice === 'auto' ? [250000, 115200] : [Number(choice)];
  for (const baud of speeds) {
    port = chosen;
    state(`Trying ${baud}…`);
    try {
      const hello = await openAt(baud);
      if (hello) {
        state(`Connected at ${baud}. The printer answered.`, 'ok');
        fact('Speed', String(baud));
        $('#disconnect').disabled = false;
        for (const b of document.querySelectorAll('#asks button')) b.disabled = false;
        readFacts('M115', hello);
        return;
      }
    } catch (e) {
      write(`(could not open at ${baud}: ${e.message})`, 'muted');
      await close();
    }
  }
  state('The printer did not answer. Check the cable and that the printer is on, and try the other speed.', 'error');
});

$('#disconnect').addEventListener('click', async () => {
  await close();
  state('Disconnected.');
  $('#disconnect').disabled = true;
  for (const b of document.querySelectorAll('#asks button')) b.disabled = true;
});

for (const b of document.querySelectorAll('#asks button')) {
  b.addEventListener('click', async () => {
    const cmd = b.dataset.cmd;
    const got = await ask(cmd, cmd === 'M20' ? 8000 : 4000);
    if (got) readFacts(cmd, got);
    else write(`(no "ok" for ${cmd})`, 'muted');
  });
}

$('#copy').addEventListener('click', async () => {
  const facts = [...$('#facts').querySelectorAll('dt')].map((d) => `${d.textContent}: ${d.nextElementSibling.textContent}`).join('\n');
  try {
    await navigator.clipboard.writeText(`${facts}\n\n${log.textContent}`);
    $('#copied').textContent = 'Copied.';
  } catch {
    $('#copied').textContent = 'Could not copy; select the text instead.';
  }
});
