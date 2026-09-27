// Worker entry point (wrangler.jsonc "main"). All the logic is in worker.js; this file adds the
// slicer as a Cloudflare Container (container/Dockerfile) when the SLICER binding exists, and the
// line in front of it (src/line.js). Kept apart so the Node unit tests can import worker.js
// without Cloudflare-only modules.
import { DurableObject } from 'cloudflare:workers';
import { Container, getContainer } from '@cloudflare/containers';
import { SliceLine, sliceThroughLine } from './line.js';
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

  enter(ticket) {
    return this.line.enter(ticket, Date.now());
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
        // The student's browser going away (request.signal) still gives the place in line back.
        slicerSend: (path, init, opts) => sliceThroughLine(line, on, path, init, {
          ...opts, signal: request.signal, waitUntil: (p) => ctx.waitUntil(p),
        }),
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
