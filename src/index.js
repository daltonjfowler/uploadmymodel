// Worker entry point (wrangler.jsonc "main"). All the logic is in worker.js; this file adds the
// slicer as a Cloudflare Container (container/Dockerfile) when the SLICER binding exists, and the
// line in front of it (src/line.js). Kept apart so the Node unit tests can import worker.js
// without Cloudflare-only modules.
import { DurableObject } from 'cloudflare:workers';
import { Container, getContainer } from '@cloudflare/containers';
import { SliceLine, TICKET_PATTERN } from './line.js';
import worker from './worker.js';

// How many slicer containers there are: container names slicer-0 .. slicer-<N-1>. Must be at most
// max_instances in wrangler.jsonc: Cloudflare counts every name ever used, asleep or not, against
// that cap, and a name past it cannot start ("Maximum number of running container instances
// exceeded"). max_instances is one more than this for the name from before the line,
// cf-singleton-container, which still holds a place (asleep, so it costs nothing). Never call
// getContainer(env.SLICER) without a name: that brings it back. The line gives out the lowest free
// slicer, so slicer-1 only wakes (and bills) when slicer-0 is busy.
const SLICERS = 2;

export class SlicerContainer extends Container {
  defaultPort = 8080;
  // Much shorter than uploadmycode/uploadmylaser (5m): slicing happens in bursts during class, 3 GiB
  // of memory bills every second it is awake, and a cold start is only a few seconds (the
  // container pre-warms itself). Closing slicing stops it at once (slicerStopIdle below). This only
  // works because container/server.py exits on SIGTERM.
  sleepAfter = '1m';
}

// The line, in its own Durable Object with no container attached. Every waiting student asks it
// for their place every couple of seconds; those requests must never reach (and so wake, or keep
// awake) a container. See uploadmycode docs/DEPLOY.md: keep anything cheap to call out of the
// container class.
export class SlicerLine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.line = new SliceLine(SLICERS);
  }

  enter(ticket, polls) {
    return this.line.enter(ticket, Date.now(), { polls });
  }

  leave(ticket) {
    this.line.leave(ticket, Date.now());
  }

  cancel(ticket) {
    this.line.cancel(ticket);
  }

  status(ticket) {
    return this.line.status(ticket, Date.now());
  }
}

/** Thrown by slicerSend; worker.js turns `code` into a message for the student. */
class LineError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export default {
  fetch(request, env, ctx) {
    // The containers, or SLICER_URL for local dev (wrangler cannot run containers on Windows):
    // one URL per slicer, comma-separated, e.g. two Docker slicers to try the line.
    const urls = env.SLICER_URL ? String(env.SLICER_URL).split(',').map((u) => u.trim()).filter(Boolean) : [];
    const on = urls.length
      ? (n, path, init) => fetch(new URL(path, urls[n % urls.length]), init)
      : env.SLICER
        ? (n, path, init) => getContainer(env.SLICER, `slicer-${n}`).fetch(new Request(`http://slicer${path}`, init))
        : null;
    if (on && env.SLICER_LINE) {
      const line = () => env.SLICER_LINE.get(env.SLICER_LINE.idFromName('line'));
      env = {
        ...env,
        slicerSend: (path, init, opts) => send(line, on, path, init, opts),
        sliceLineStatus: (ticket) => line().status(ticket),
        sliceLineCancel: (ticket) => line().cancel(ticket),
        // The teacher closed slicing: put the slicers to sleep now instead of a minute from now,
        // unless a slice is running or waiting (that student still gets their file; the idle
        // timer puts it to sleep after).
        slicerStopIdle: async () => {
          if (!env.SLICER || urls.length) return false;
          const s = await line().status('closing-check');
          if (s.busy || s.waiting) return false;
          await Promise.all(Array.from({ length: SLICERS }, (_, n) => getContainer(env.SLICER, `slicer-${n}`).stop()));
          return true;
        },
      };
    }
    return worker.fetch(request, env, ctx);
  },
};

// A slice waits its turn in the line, goes to the slicer the line picked, and gives the turn back.
// Anything else (the teacher's warm-up) goes to slicer-0.
async function send(line, on, path, init, { ticket } = {}) {
  if (path !== '/slice') return on(0, path, init);
  // A ticket from the page means it will ask for its place; without one (a page from before the
  // line), make one that is never dropped for not asking.
  const polls = TICKET_PATTERN.test(ticket ?? '');
  const t = polls ? ticket : crypto.randomUUID();
  let slot;
  try {
    slot = await line().enter(t, polls);
  } catch (err) {
    if (String(err?.message).includes('full')) throw new LineError('full');
    // The line itself failed (evicted, restarted): slice anyway on slicer-0, whose own lock still
    // keeps order. Only the place-in-line display is lost.
    console.error(JSON.stringify({ message: 'slicer line failed', error: String(err?.message ?? err) }));
    return on(0, path, init);
  }
  if (slot < 0) throw new LineError('left');
  try {
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
    // The container answers when the slice is done (it releases its lock before sending the file).
    await line().leave(t).catch(() => {});
  }
}
