// The slicer idle cap (src/idle-cap.js). Guards the 2026-11-10 leak: a slicer the containers library
// still counted as busy sat awake ~6 h (18.7 GiB-h) with no slicing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { IDLE_CAP_MS, idleCapAction, idleCapReached, KILL_AFTER_MS, LEASE_MS, SLEEP_AFTER_MS } from '../src/idle-cap.js';

const MIN = 60_000;
const LIBRARY_ALARM_MAX_MS = 3 * MIN; // @cloudflare/containers re-arms its alarm at most 3 min apart

test('the cap can never cut off a real slice or beat the normal sleep clock', () => {
  assert.ok(IDLE_CAP_MS > 2 * LEASE_MS, 'longer than a wait for the lock plus a whole slice');
  assert.ok(IDLE_CAP_MS > SLEEP_AFTER_MS);
  const py = readFileSync(new URL('../container/server.py', import.meta.url), 'utf8');
  const budget = Number(py.match(/^SLICE_BUDGET_S = (\d+)/m)[1]);
  assert.ok(IDLE_CAP_MS > 2 * budget * 1000 + 2 * MIN, 'the slice budget grew: raise IDLE_CAP_MS');
});

test('only a running slicer with no request for the cap; SIGTERM first, SIGKILL a minute later', () => {
  const last = 1_000_000, capAt = last + IDLE_CAP_MS;
  assert.equal(idleCapReached(capAt - 1, last, true), false);
  assert.equal(idleCapAction(capAt, last, false, null), 'none', 'never touches a stopped slicer');
  assert.equal(idleCapAction(capAt, last, true, null), 'stop');
  assert.equal(idleCapAction(capAt + KILL_AFTER_MS - 1, last, true, capAt), 'none');
  assert.equal(idleCapAction(capAt + KILL_AFTER_MS, last, true, capAt), 'kill');
  const later = capAt + 5 * MIN; // a new request after the stop: the old stop does not count
  assert.equal(idleCapAction(later + IDLE_CAP_MS, later, true, capAt), 'stop');
});

test('replay of 2026-11-10: stuck at 16:00 UTC, stopped within the cap instead of at 22:00', () => {
  const start = Date.UTC(2026, 10, 10, 16, 0);
  let sent = null, stoppedAt = null;
  for (let t = start; t <= start + 6 * 60 * MIN; t += LIBRARY_ALARM_MAX_MS) {
    const a = idleCapAction(t, start, true, sent);
    if (a === 'stop') { sent = t; stoppedAt = t; break; }
  }
  assert.ok(stoppedAt !== null && stoppedAt - start <= IDLE_CAP_MS + LIBRARY_ALARM_MAX_MS);
});

test('index.js wires the cap into the slicer container', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const cls = src.slice(src.indexOf('export class SlicerContainer'), src.indexOf('export class SlicerLine'));
  assert.ok(cls.length > 0);
  assert.match(cls, /sleepAfter = '1m'/);
  assert.match(cls, /\n {2}async fetch\(request\) \{\n\s*this\.#lastRequestAt = Date\.now\(\);\n\s*this\.#stopSentAt = null;\n\s*return super\.fetch\(request\);/);
  assert.match(cls, /\n {2}async alarm\(alarmProps\) \{[\s\S]*?\n\s*const action = idleCapAction\(now, this\.#lastRequestAt,[\s\S]*?\n\s*await this\.stop\(\);[\s\S]*?\n\s*await this\.destroy\(\);[\s\S]*?\n\s*return super\.alarm\(alarmProps\);/);
  assert.match(cls, /\n {2}#lastRequestAt = Date\.now\(\);\n/);
});
