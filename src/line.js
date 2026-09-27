// The line for the slicer: who slices next, on which container, and how many are ahead of you.
//
// Each container slices one plate at a time (container/server.py holds a lock), so a class that all
// presses Slice at once forms a line. uploadmycode showed that a place in line counted beside the
// real queue lies (the order requests reach a counter is not the order they reach the engine). So
// here the line IS the queue: a slice only goes to a container once this line gives it a free slot,
// in arrival order. The place it reports is then the true order.
//
// It runs inside one Durable Object (src/index.js). Pure apart from the clock, which is passed in,
// so test/line.test.mjs runs it directly. sliceThroughLine() below is the Worker's side of it.
//
// Every slice has a ticket from the page, and the page asks for its place every 2 s the whole time
// (waiting and slicing). That asking is how the line knows the student is still there:
// - A waiting ticket not asked about for STALE_MS is dropped (tab closed, Cancel, lost Wi-Fi).
// - A free slicer only goes to a waiting ticket asked about in the last FRESH_MS, so a student who
//   just left never gets a slicer that then sits idle. A late one keeps its place until STALE_MS.
// - A slicing ticket not asked about for STALE_MS gives its slot back (the Worker went away
//   without saying so). Its container may still be finishing; the next slice waits for that
//   container's own lock, never runs beside it.
// - LEASE_MS is the last resort: longer than any real slice (container/server.py SLICE_BUDGET_S
//   plus the upload and the answer).

export const TICKET_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const STALE_MS = 20_000;
export const FRESH_MS = 8_000;
// container/server.py SLICE_BUDGET_S (180 s for all tries together) + 30 s.
export const LEASE_MS = 210_000;
// A class is 20-30 students; more than this waiting is a runaway page, not a class.
export const MAX_WAITING = 80;
// Guess for how long one slice takes, until the line has timed a few (a supported model at
// Fine detail is ~16 s on the live container; Standard, the class setting, about 5 s).
const FIRST_GUESS_S = 15;

export class SliceLine {
  constructor(slots) {
    this.slots = slots;
    this.running = Array.from({ length: slots }, () => null); // { ticket, since, seen }
    this.waiting = []; // { ticket, since, seen, resolve }
    this.recent = []; // seconds for the last few slices
  }

  /**
   * Join the line. Resolves with a slot number (0..slots-1) when it is this ticket's turn, or -1 if
   * the place was lost (the student left, or the ticket is already in the line). Throws 'full'
   * when the line is too long.
   */
  enter(ticket, now) {
    this.sweep(now);
    // One ticket, one place: a page never sends the same ticket twice.
    if (this.waiting.some((w) => w.ticket === ticket) || this.running.some((r) => r?.ticket === ticket)) {
      return Promise.resolve(-1);
    }
    if (this.waiting.length >= MAX_WAITING) throw new Error('full');
    const turn = new Promise((resolve) => this.waiting.push({ ticket, since: now, seen: now, resolve }));
    this.pump(now, false);
    return turn;
  }

  /** The slice on this ticket finished (or failed, or the student went away): free its slot. */
  leave(ticket, now) {
    const slot = this.running.findIndex((r) => r?.ticket === ticket);
    if (slot >= 0) {
      this.recent.push((now - this.running[slot].since) / 1000);
      if (this.recent.length > 8) this.recent.shift();
      this.running[slot] = null;
    }
    this.cancel(ticket);
    this.pump(now);
  }

  /** The student gave up before their turn (Cancel). */
  cancel(ticket) {
    const i = this.waiting.findIndex((w) => w.ticket === ticket);
    if (i >= 0) this.waiting.splice(i, 1)[0].resolve(-1);
  }

  /** Where this ticket is. Asking also keeps its place (waiting or slicing) alive. */
  status(ticket, now) {
    const i = this.waiting.findIndex((w) => w.ticket === ticket);
    if (i >= 0) this.waiting[i].seen = now;
    const run = this.running.find((r) => r?.ticket === ticket);
    if (run) run.seen = now;
    // After marking: a late student who asks again can take a slicer that came free meanwhile.
    this.sweep(now);
    const busy = this.running.filter(Boolean).length;
    const base = { slots: this.slots, busy, waiting: this.waiting.length, sliceSeconds: Math.round(this.sliceSeconds) };
    const at = this.waiting.findIndex((w) => w.ticket === ticket);
    if (at >= 0) {
      // When does a slicer come free for you? Each running slice has about `sliceSeconds` minus
      // what it has run so far left (at least a few seconds: it may be a slow one). The ones ahead
      // of you in line take the earliest free slicers, one full slice each.
      const avg = this.sliceSeconds;
      const free = this.running.map((r) => (r ? Math.max(3, avg - (now - r.since) / 1000) : 0));
      for (let k = 0; k < at; k++) {
        free.sort((a, b) => a - b);
        free[0] += avg;
      }
      const startsIn = Math.min(...free);
      return { ...base, state: 'waiting', ahead: at, startsInSeconds: Math.round(startsIn) };
    }
    if (this.running.some((r) => r?.ticket === ticket)) return { ...base, state: 'slicing' };
    return { ...base, state: 'unknown' };
  }

  get sliceSeconds() {
    if (!this.recent.length) return FIRST_GUESS_S;
    return this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
  }

  sweep(now) {
    for (let s = 0; s < this.slots; s++) {
      const r = this.running[s];
      if (r && (now - r.since > LEASE_MS || now - r.seen > STALE_MS)) this.running[s] = null;
    }
    this.waiting = this.waiting.filter((w) => {
      const gone = now - w.seen > STALE_MS;
      if (gone) w.resolve(-1);
      return !gone;
    });
    this.pump(now, false);
  }

  // Free slots go to the first waiting tickets that asked recently, in line order.
  pump(now, sweep = true) {
    if (sweep) this.sweep(now);
    for (let s = 0; s < this.slots; s++) {
      if (this.running[s]) continue;
      const i = this.waiting.findIndex((w) => now - w.seen <= FRESH_MS);
      if (i < 0) break;
      const [next] = this.waiting.splice(i, 1);
      this.running[s] = { ticket: next.ticket, since: now, seen: now };
      next.resolve(s);
    }
  }
}

/** Thrown by sliceThroughLine; src/worker.js turns `code` into a message for the student. */
export class LineError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * The Worker's side of the line (src/index.js): a slice waits its turn, goes to the slicer the line
 * picked, and gives the turn back. Anything else (the teacher's warm-up) goes to slicer-0.
 *
 * line():        the SlicerLine Durable Object stub (enter / leave).
 * on(n, path, init): send to slicer n.
 * ticket:        the page's x-slice-ticket (required; src/worker.js checks it first).
 * signal:        the incoming request's signal: aborts when the student's browser goes away, which
 *                cancels this code, finally blocks included (enable_request_signal, wrangler.jsonc).
 * waitUntil:     ctx.waitUntil, so the leave() sent from that abort still reaches the line.
 */
export async function sliceThroughLine(line, on, path, init, { ticket, signal, waitUntil } = {}) {
  if (path !== '/slice') return on(0, path, init);
  if (!TICKET_PATTERN.test(ticket ?? '')) throw new LineError('reload');
  // Give the place back exactly once, however this ends: finished, failed, or cancelled.
  let given = null;
  const giveBack = () => {
    if (!given) {
      given = Promise.resolve().then(() => line().leave(ticket)).catch(() => {});
      waitUntil?.(given);
    }
    return given;
  };
  signal?.addEventListener?.('abort', giveBack, { once: true });
  try {
    let slot;
    try {
      slot = await line().enter(ticket);
    } catch (err) {
      if (String(err?.message).includes('full')) throw new LineError('full');
      // The line itself failed (evicted, restarted): slice anyway on slicer-0, whose own lock still
      // keeps order. Only the place-in-line display is lost.
      console.error(JSON.stringify({ message: 'slicer line failed', error: String(err?.message ?? err) }));
      return await on(0, path, init);
    }
    if (slot < 0) throw new LineError('left');
    if (signal?.aborted) return new Response(null, { status: 499 }); // gone while waiting: no slice
    const res = await on(slot, path, init);
    // A slicer that could not start (Cloudflare's instance cap reached, e.g. an old instance still
    // shutting down): slice on slicer-0 instead, which queues it behind its current slice.
    if (slot > 0 && res.status === 500) {
      const detail = await res.clone().text().catch(() => '');
      if (/Failed to start container/i.test(detail)) {
        console.error(JSON.stringify({ message: 'slicer could not start, using slicer-0', slot, detail: detail.slice(0, 200) }));
        return await on(0, path, init);
      }
    }
    return res;
  } finally {
    signal?.removeEventListener?.('abort', giveBack);
    // The container answers when the slice is done (it releases its lock before sending the file).
    await giveBack();
  }
}
