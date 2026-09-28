// Copy a sliced file onto the printer's own SD card over USB (Marlin M28 ... M29), so a student
// does not have to carry the card. Nothing here prints, and nothing is ever deleted: the teacher
// still starts every print from the printer's screen. Tested against the school Workhorse's answers
// (2026-09-28: Marlin 2.0.9.0.13, 250000, Cap:SD_WRITE:1, "ok P15 B3").
//
// Everything this module sends: M115 / M27 / M20 (questions), M110 (line numbers), M28 <name>, the
// slicer's own lines, and M29. While M28 is open Marlin WRITES lines to the card instead of running
// them. If that ever stopped (a reset, a closed file) the same lines would heat and move the
// printer, so: no line goes out before Marlin says "Writing to file", any line that could close
// the file early is refused, and the copy stops the moment the printer restarts or looks busy.

export const BAUD = 250000;
const MAX_IN_FLIGHT_LINES = 3;   // "B3": Marlin has 4 command slots; keep one free
const MAX_IN_FLIGHT_BYTES = 110; // AVR serial buffer is 128 bytes
const REPLY_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Marlin's line checksum: XOR of every byte before the '*'. */
export function checksum(text) {
  let cs = 0;
  for (let i = 0; i < text.length; i++) cs ^= text.charCodeAt(i);
  return cs & 0xff;
}

export const numbered = (n, cmd) => {
  const body = `N${n} ${cmd}`;
  return `${body}*${checksum(body)}`;
};

// M20-M34 are Marlin's SD card commands. Marlin closes the file on any line containing "M29" (not
// M290...), so such a line in the middle would make the rest RUN instead of being written.
const SD_COMMAND = /M(2\d|3[0-4])(?!\d)/i;

/**
 * The lines to write: comments and blank lines dropped (the printer does not use them, and each
 * byte costs time over USB). Throws if the file has anything that could end the copy early.
 */
export function cardLines(gcode) {
  const out = [];
  for (const raw of gcode.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    if (SD_COMMAND.test(line)) throw new Error(`This file has an SD card command in it (${line.slice(0, 20)}), so it cannot be copied.`);
    if (/[^\x20-\x7e]/.test(line) || line.includes('*')) throw new Error('This file has characters the printer cannot take over USB.');
    out.push(line);
  }
  return out;
}

/**
 * A short (8.3) card name no file on the card has yet: first letters of the name + 2 digits,
 * e.g. "Jordan's Benchy" -> JORDAN01.GCO. Marlin 2.0.9 only writes short names.
 */
export function sdName(base, taken = []) {
  const used = new Set(taken.map((t) => t.toUpperCase()));
  const stem = (String(base).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PRINT').slice(0, 6);
  for (let i = 1; i <= 99; i++) {
    const name = `${stem}${String(i).padStart(2, '0')}.GCO`;
    if (!used.has(name)) return name;
  }
  throw new Error('The printer already has 99 files with this name. Ask your teacher to clean up the card.');
}

export class PrinterUsb {
  constructor(port) {
    this.port = port;
    this.lines = [];      // received, not yet taken by a waiter
    this.listeners = new Set();
    this.lastData = 0;
    this.heard = 0;
    this.restarted = false;
    this.buffer = '';
  }

  async open() {
    await this.port.open({ baudRate: BAUD, bufferSize: 8192 });
    this.writer = this.port.writable.getWriter();
    this.reading = this.readLoop();
    await this.waitForBoot();
    // Right after boot the Workhorse sends "echo:SD card ok", its position and a spare "ok" BEFORE
    // the M115 answer (school log, 2026-09-28), so wait for the answer itself, not just any "ok".
    let hello = null;
    for (let i = 0; i < 3 && !hello; i++) hello = await this.ask('M115', 3000, /FIRMWARE_NAME/);
    if (!hello) throw new Error('The printer did not answer. Check it is on and the USB cable is in, then try again.');
    await this.settle(); // late answers to an earlier M115 try, spare "ok"s
    const text = hello.join('\n');
    if (!/Cap:SD_WRITE:1/.test(text)) throw new Error('This printer cannot save files from USB. Use the SD card instead.');
    this.restarted = false; // the reset from opening the port is expected
  }

  async close() {
    try { await this.reader?.cancel(); } catch { /* already stopped */ }
    try { this.writer?.releaseLock(); } catch { /* fine */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }

  async readLoop() {
    const decoder = new TextDecoder();
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.lastData = Date.now();
        this.buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = this.buffer.search(/\r?\n/)) >= 0) {
          const line = this.buffer.slice(0, i).trim();
          this.buffer = this.buffer.slice(this.buffer[i] === '\r' ? i + 2 : i + 1);
          if (!line) continue;
          this.heard++;
          if (line === 'start') this.restarted = true;
          for (const f of this.listeners) f(line);
        }
      }
    } catch { /* port closed or cable pulled */ } finally {
      try { this.reader.releaseLock(); } catch { /* fine */ }
    }
  }

  /** Opening the port resets the Workhorse; it ignores commands for several seconds while it boots. */
  async waitForBoot() {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await sleep(250);
      const quiet = Date.now() - (this.lastData || t0);
      if (this.heard && quiet > 1500) return;
      if (!this.heard && quiet > 3000) return;
    }
  }

  async write(text) {
    await this.writer.write(new TextEncoder().encode(`${text}\n`));
  }

  /** Wait until the printer has been quiet for `ms`. */
  async settle(ms = 700) {
    const t0 = Date.now();
    while (Date.now() - Math.max(this.lastData, t0) < ms && Date.now() - t0 < 5000) await sleep(100);
  }

  /**
   * Send one line and collect the reply up to "ok" (null after timeoutMs). With `until`, an "ok"
   * only counts once a line matching it has come: a spare "ok" from before cannot end the answer.
   */
  async ask(cmd, timeoutMs = REPLY_MS, until = null) {
    const got = [];
    let seen = !until;
    const reply = new Promise((resolve) => {
      const t = setTimeout(() => { this.listeners.delete(on); resolve(null); }, timeoutMs);
      const on = (line) => {
        got.push(line);
        if (until?.test(line)) seen = true;
        if (seen && /^ok\b/.test(line)) { clearTimeout(t); this.listeners.delete(on); resolve(got); }
      };
      this.listeners.add(on);
    });
    await this.write(cmd);
    return reply;
  }

  /** Short names of the files on the card, and whether the printer is busy printing from it. */
  async cardState() {
    const status = await this.ask('M27', REPLY_MS, /SD printing/i);
    if (!status) throw new Error('The printer did not answer.');
    const printing = !status.some((l) => /Not SD printing/i.test(l));
    const list = await this.ask('M20', 10000, /End file list/i);
    if (!list || !list.some((l) => /Begin file list/i.test(l))) throw new Error('The printer has no SD card in it, or it cannot read it. Put the card in the printer and try again.');
    const files = list.filter((l) => !/^(ok|Begin file list|End file list)/i.test(l)).map((l) => l.split(' ')[0]);
    return { printing, files };
  }

  /**
   * Write `lines` to the card as `name`. onProgress(bytesDone, bytesTotal). Resolves when Marlin
   * says the file is saved; throws (after closing the file when it still can) on any trouble.
   */
  async copy(lines, name, { onProgress, signal } = {}) {
    let stop = null; // set to an Error the moment anything looks wrong
    const watch = (line) => {
      if (line === 'start') stop ??= new Error('The printer restarted, so the copy stopped. Try again.');
      else if (/busy|Unknown command/i.test(line)) stop ??= new Error('The printer started running commands instead of saving them, so the copy stopped. Ask your teacher to check the printer.');
    };
    this.listeners.add(watch);
    try {
      // Line numbers + checksums: the printer asks again for any line that got garbled.
      const reset = await this.ask(numbered(0, 'M110 N0'));
      if (!reset) throw new Error('The printer did not answer.');
      await this.settle(300);
      const open = await this.ask(numbered(1, `M28 ${name}`), 8000, /Writing to file|fail|error/i);
      if (!open || !open.some((l) => /Writing to file/i.test(l))) {
        throw new Error('The printer could not start a file on its SD card. Check the card is in the printer.');
      }
      const total = lines.reduce((a, l) => a + l.length + 1, 0);
      const firstN = 2;
      const offsets = [0];
      for (const l of lines) offsets.push(offsets.at(-1) + l.length + 1);

      let next = 0;          // index of the next line to send
      let acked = 0;         // lines the printer has taken
      const inFlight = [];   // byte sizes of sent, un-acked lines
      let resendFrom = null;
      let lastAck = Date.now();
      let wake = null;
      const nudge = () => { const w = wake; wake = null; w?.(); };
      const onLine = (line) => {
        const resend = /^(?:Resend|rs)\s*:?\s*N?(\d+)/i.exec(line);
        if (resend) { resendFrom = Math.max(0, Number(resend[1]) - firstN); nudge(); return; }
        if (/^ok\b/.test(line) && inFlight.length) {
          inFlight.shift();
          acked++;
          lastAck = Date.now();
          nudge();
        }
      };
      this.listeners.add(onLine);
      try {
        while (acked < lines.length || inFlight.length) {
          if (stop) throw stop;
          if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
          if (resendFrom !== null) {
            // Marlin throws away what was still in its buffer: let it settle, then go again from there.
            await sleep(400);
            next = resendFrom;
            acked = resendFrom;
            inFlight.length = 0;
            resendFrom = null;
            continue;
          }
          const bytes = inFlight.reduce((a, b) => a + b, 0);
          if (next < lines.length && inFlight.length < MAX_IN_FLIGHT_LINES) {
            const text = numbered(firstN + next, lines[next]);
            if (!inFlight.length || bytes + text.length + 1 <= MAX_IN_FLIGHT_BYTES) {
              inFlight.push(text.length + 1);
              next++;
              await this.write(text);
              continue;
            }
          }
          if (acked >= lines.length && !inFlight.length) break;
          if (Date.now() - lastAck > REPLY_MS * 2) throw new Error('The printer stopped answering, so the copy stopped. Check the USB cable.');
          await new Promise((r) => { wake = r; setTimeout(nudge, 200); });
          onProgress?.(offsets[acked], total);
        }
      } finally {
        this.listeners.delete(onLine);
      }
      if (stop) throw stop;
      onProgress?.(total, total);
      const done = await this.ask(numbered(firstN + lines.length, 'M29'), 8000);
      if (!done) throw new Error('The printer did not confirm the file was saved. Check the card before printing it.');
    } catch (err) {
      // Close the file if the printer is still with us, so it stops writing. A half file stays
      // on the card (nothing here deletes files); the message says so.
      if (!this.restarted) {
        await sleep(400);
        await this.ask('M29', 3000).catch(() => {});
      }
      throw err;
    } finally {
      this.listeners.delete(watch);
    }
  }
}
