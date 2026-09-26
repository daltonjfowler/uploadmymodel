// The line for the slicer: who slices next, on which container, and how many are ahead of you.
//
// Each container slices one plate at a time (container/server.py holds a lock), so a class that all
// presses Slice at once forms a line. uploadmycode showed that a place in line counted beside the
// real queue lies (the order requests reach a counter is not the order they reach the engine). So
// here the line IS the queue: a slice only goes to a container once this line gives it a free slot,
// in arrival order. The place it reports is then the true order.
//
// It runs inside one Durable Object (src/index.js). Pure apart from the clock, which is passed in,
// so test/line.test.mjs runs it directly.
//
// Two ways a place can be lost, both cleaned up by sweep():
// - The student left (closed the tab, pressed Cancel, lost Wi-Fi). The page asks for its place
//   every couple of seconds while it waits; a waiting ticket not asked about for STALE_MS is dropped.
//   (Tickets the Worker made itself, for a page too old to ask, are never dropped this way.)
// - A slice that never said it finished (the Worker went away mid-request): its slot is freed after
//   LEASE_MS, longer than any real slice.

export const TICKET_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const STALE_MS = 20_000;
export const LEASE_MS = 5 * 60_000;
// A class is 20-30 students; more than this waiting is a runaway page, not a class.
export const MAX_WAITING = 80;
// Guess for how long one slice takes, until the line has timed a few (a supported model at
// Fine detail is ~16 s on the live container; Standard, the class setting, about 5 s).
const FIRST_GUESS_S = 15;

export class SliceLine {
  constructor(slots) {
    this.slots = slots;
    this.running = Array.from({ length: slots }, () => null); // { ticket, since }
    this.waiting = []; // { ticket, since, seen, polls, resolve }
    this.recent = []; // seconds for the last few slices
  }

  /**
   * Join the line. Resolves with a slot number (0..slots-1) when it is this ticket's turn, or -1 if
   * the place was lost (the student left). Throws 'full' when the line is too long.
   * `polls`: the page will ask for its place (so it can be dropped when it stops asking).
   */
  enter(ticket, now, { polls = true } = {}) {
    this.sweep(now);
    const free = this.running.indexOf(null);
    if (free >= 0 && !this.waiting.length) {
      this.running[free] = { ticket, since: now };
      return Promise.resolve(free);
    }
    if (this.waiting.length >= MAX_WAITING) throw new Error('full');
    return new Promise((resolve) => this.waiting.push({ ticket, since: now, seen: now, polls, resolve }));
  }

  /** The slice on this ticket finished (or failed): free its slot for the next in line. */
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

  /** Where this ticket is. Asking also keeps a waiting place alive. */
  status(ticket, now) {
    this.sweep(now);
    const i = this.waiting.findIndex((w) => w.ticket === ticket);
    const busy = this.running.filter(Boolean).length;
    const base = { slots: this.slots, busy, waiting: this.waiting.length, sliceSeconds: Math.round(this.sliceSeconds) };
    if (i >= 0) {
      this.waiting[i].seen = now;
      // When does a slicer come free for you? Each running slice has about `sliceSeconds` minus
      // what it has run so far left (at least a few seconds: it may be a slow one). The ones ahead
      // of you in line take the earliest free slicers, one full slice each.
      const avg = this.sliceSeconds;
      const free = this.running.map((r) => (r ? Math.max(3, avg - (now - r.since) / 1000) : 0));
      for (let k = 0; k < i; k++) {
        free.sort((a, b) => a - b);
        free[0] += avg;
      }
      const startsIn = Math.min(...free);
      return { ...base, state: 'waiting', ahead: i, startsInSeconds: Math.round(startsIn) };
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
      if (this.running[s] && now - this.running[s].since > LEASE_MS) this.running[s] = null;
    }
    this.waiting = this.waiting.filter((w) => {
      const gone = w.polls && now - w.seen > STALE_MS;
      if (gone) w.resolve(-1);
      return !gone;
    });
    this.pump(now, false);
  }

  pump(now, sweep = true) {
    if (sweep) this.sweep(now);
    for (let s = 0; s < this.slots && this.waiting.length; s++) {
      if (this.running[s]) continue;
      const next = this.waiting.shift();
      this.running[s] = { ticket: next.ticket, since: now };
      next.resolve(s);
    }
  }
}
