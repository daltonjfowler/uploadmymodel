// Worker entry point (wrangler.jsonc "main"). All the logic is in worker.js; this file adds the
// slicer as a Cloudflare Container (container/Dockerfile) when the SLICER binding exists. Kept
// apart so the Node unit tests can import worker.js without Cloudflare-only modules.
import { Container, getContainer } from '@cloudflare/containers';
import worker from './worker.js';

export class SlicerContainer extends Container {
  defaultPort = 8080;
  // Same as uploadmycode and uploadmylaser: memory bills while awake; a cold start is a few seconds.
  sleepAfter = '5m';
}

export default {
  fetch(request, env, ctx) {
    // SLICER_URL (local dev, .dev.vars) wins: wrangler cannot run containers on Windows.
    if (env.SLICER && !env.SLICER_URL) {
      const slicerSend = (path, init) => getContainer(env.SLICER).fetch(new Request(`http://slicer${path}`, init));
      env = { ...env, slicerSend };
    }
    return worker.fetch(request, env, ctx);
  },
};
