// Backstop for the slicer's sleep clock (same fix as uploadmylaser src/idle-cap.ts, 2026-11-13).
//
// @cloudflare/containers will not let a container sleep while it counts a request as in flight, and it
// only stops counting once that response body has finished streaming. A body nobody finishes reading,
// or a slicer that never answers, keeps the count above zero forever, so `sleepAfter` never fires.
// Usage shows it: on 2026-11-10 a slicer sat awake ~16:00-22:00 UTC (18.7 GiB-h) with ~45 CPU-seconds an
// hour, the idle heartbeat; with sleepAfter '1m' a whole idle hour is impossible otherwise.
//
// The rule here does not trust that count: if no new request has reached the slicer for IDLE_CAP_MS,
// stop it (SIGTERM; server.py exits within 2 s), and SIGKILL if it is still up KILL_AFTER_MS later. The
// slicer is stateless (each slice is its own request), so stopping it loses nothing.

import { LEASE_MS } from './line.js';

/** Longer than any real request can last from its arrival: waiting for the slicer lock (at most one
 *  slice, LEASE_MS) and then its own slice (LEASE_MS), with room to spare. */
export const IDLE_CAP_MS = 20 * 60_000;
export const KILL_AFTER_MS = 60_000;
export const SLEEP_AFTER_MS = 60_000; // SlicerContainer `sleepAfter = '1m'`
export { LEASE_MS };

export function idleCapReached(now, lastRequestAt, running) {
  return running && now - lastRequestAt >= IDLE_CAP_MS;
}

/** 'none' | 'stop' | 'kill'. `stopSentAt`: when the cap last sent SIGTERM, null if not since the last request. */
export function idleCapAction(now, lastRequestAt, running, stopSentAt) {
  if (!idleCapReached(now, lastRequestAt, running)) return 'none';
  const sent = stopSentAt !== null && stopSentAt >= lastRequestAt;
  if (!sent) return 'stop';
  return now - stopSentAt >= KILL_AFTER_MS ? 'kill' : 'none';
}
