// The slicer line (src/line.js): order, slots, places lost and freed, and the Worker's side of it
// (sliceThroughLine) with a fake line and fake slicers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESH_MS, LEASE_MS, LineError, MAX_WAITING, STALE_MS, SliceLine, sliceThroughLine } from '../src/line.js';

// The pages asking for their place every 2 s, from `from` to `to` (both included).
function poll(line, tickets, from, to) {
  for (let t = from; t <= to; t += 2000) for (const ticket of tickets) line.status(ticket, t);
}

test('free slots go straight away, one per container', async () => {
  const line = new SliceLine(2);
  assert.equal(await line.enter('aaaaaaaa', 0), 0);
  assert.equal(await line.enter('bbbbbbbb', 0), 1);
  assert.equal(line.status('aaaaaaaa', 0).state, 'slicing');
});

test('the rest wait in arrival order and are told how many are ahead', async () => {
  const line = new SliceLine(2);
  const all = ['t0000000', 't1111111', 't2222222', 't3333333', 't4444444'];
  await line.enter('t0000000', 0);
  await line.enter('t1111111', 0);
  const got = [];
  const c = line.enter('t2222222', 1).then((s) => got.push(['c', s]));
  const d = line.enter('t3333333', 2).then((s) => got.push(['d', s]));
  const e = line.enter('t4444444', 3).then((s) => got.push(['e', s]));
  assert.equal(line.status('t2222222', 4).ahead, 0);
  assert.equal(line.status('t4444444', 4).ahead, 2);
  assert.equal(line.status('t4444444', 4).waiting, 3);
  poll(line, all, 2000, 10_000);
  line.leave('t1111111', 10_000); // container 1 frees first
  await c;
  poll(line, all, 10_000, 11_000);
  line.leave('t0000000', 11_000);
  await d;
  assert.deepEqual(got, [['c', 1], ['d', 0]]);
  assert.equal(line.status('t4444444', 11_000).ahead, 0);
  poll(line, all, 12_000, 20_000);
  line.leave('t2222222', 20_000);
  await e;
  assert.deepEqual(got.at(-1), ['e', 1]);
});

test('the wait guess follows how long slices really took', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  line.enter('bbbbbbbb', 0);
  line.enter('cccccccc', 0);
  poll(line, ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], 2000, 30_000);
  line.leave('aaaaaaaa', 30_000); // a 30 s slice; b starts
  const s = line.status('cccccccc', 30_000);
  assert.equal(s.sliceSeconds, 30);
  assert.equal(s.startsInSeconds, 30);
  // 20 s into b's slice, c starts in about 10 s; a slice running long still says a few seconds.
  poll(line, ['bbbbbbbb', 'cccccccc'], 32_000, 50_000);
  assert.equal(line.status('cccccccc', 50_000).startsInSeconds, 10);
  poll(line, ['bbbbbbbb', 'cccccccc'], 52_000, 90_000);
  assert.equal(line.status('cccccccc', 90_000).startsInSeconds, 3);
});

test('further back waits for the earliest free slicers, one slice each', async () => {
  const line = new SliceLine(2);
  await line.enter('aaaaaaaa', 0);
  await line.enter('bbbbbbbb', 10_000);
  for (const t of ['cccccccc', 'dddddddd', 'eeeeeeee']) line.enter(t, 10_000);
  // default guess 15 s a slice: a frees at 15 s, b at 25 s
  assert.equal(line.status('cccccccc', 10_000).startsInSeconds, 5);
  assert.equal(line.status('dddddddd', 10_000).startsInSeconds, 15);
  assert.equal(line.status('eeeeeeee', 10_000).startsInSeconds, 20);
});

test('a student who stops asking loses the place; the next one moves up', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const gone = line.enter('bbbbbbbb', 0);
  const stays = line.enter('cccccccc', 0);
  poll(line, ['aaaaaaaa', 'cccccccc'], 2000, STALE_MS); // a and c keep asking, b does not
  assert.equal(line.status('cccccccc', STALE_MS + 1000).ahead, 0);
  assert.equal(await gone, -1);
  line.leave('aaaaaaaa', STALE_MS + 2000);
  assert.equal(await stays, 0);
});

test('every place needs a page that asks: a silent ticket is dropped too', async () => {
  // Before, a ticket the Worker made up for an old page was never dropped. Now every slice has a
  // page ticket, so a waiting place nobody asks about always goes.
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const silent = line.enter('bbbbbbbb', 0);
  poll(line, ['aaaaaaaa'], 2000, STALE_MS + 2000);
  assert.equal(await silent, -1);
});

test('a free slicer only goes to someone who asked just now', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const late = line.enter('bbbbbbbb', 0); // asked once (joining), then went quiet
  const keen = line.enter('cccccccc', 0);
  let lateGot = null;
  late.then((s) => { lateGot = s; });
  poll(line, ['aaaaaaaa', 'cccccccc'], 2000, 10_000);
  // b last asked 10 s ago: more than FRESH_MS, less than STALE_MS.
  assert.ok(10_000 > FRESH_MS && 10_000 < STALE_MS);
  line.leave('aaaaaaaa', 10_000);
  assert.equal(await keen, 0); // c gets it, although b was first
  await Promise.resolve();
  assert.equal(lateGot, null); // b keeps its place (first in line) until it is stale
  assert.equal(line.status('bbbbbbbb', 11_000).ahead, 0);
});

test('a late student who asks again gets the next free slicer', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0);
  poll(line, ['aaaaaaaa'], 2000, 10_000);
  line.leave('aaaaaaaa', 10_000); // b is not fresh: the slicer stays free for now
  assert.equal(line.status('zzzzzzzz', 10_000).busy, 0);
  line.status('bbbbbbbb', 12_000); // b is back
  assert.equal(await b, 0);
});

test('a slicing student who stops asking gives the slicer back', async () => {
  // The Worker went away without saying so (it was cancelled): the page stops asking too.
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0);
  poll(line, ['bbbbbbbb'], 2000, STALE_MS + 2000);
  assert.equal(await b, 0);
  assert.equal(line.status('aaaaaaaa', STALE_MS + 2000).state, 'unknown');
});

test('Cancel gives the place up at once', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0);
  line.cancel('bbbbbbbb');
  assert.equal(await b, -1);
  assert.equal(line.status('bbbbbbbb', 1).state, 'unknown');
});

test('a slice that never finished frees its slot after the lease, even if the page still asks', async () => {
  assert.equal(LEASE_MS, 210_000); // container/server.py SLICE_BUDGET_S (180 s) + 30 s
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0);
  poll(line, ['aaaaaaaa', 'bbbbbbbb'], 2000, LEASE_MS);
  assert.equal(line.status('aaaaaaaa', LEASE_MS).state, 'slicing');
  line.status('bbbbbbbb', LEASE_MS + 1000);
  assert.equal(await b, 0);
});

test('one ticket holds one place', async () => {
  const line = new SliceLine(2);
  assert.equal(await line.enter('aaaaaaaa', 0), 0);
  assert.equal(await line.enter('aaaaaaaa', 0), -1); // not a second slicer
  await line.enter('bbbbbbbb', 0);
  line.enter('cccccccc', 0);
  assert.equal(await line.enter('cccccccc', 0), -1); // not a second place in line
  assert.equal(line.status('cccccccc', 0).waiting, 1);
});

test('a runaway line is refused', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  for (let i = 0; i < MAX_WAITING; i++) line.enter(`w${String(i).padStart(7, '0')}`, 0);
  assert.throws(() => line.enter('overflow', 0), /full/);
});

// ---- sliceThroughLine: the Worker's side ------------------------------------------------------

const TICKET = 'abcdef12-3456-7890';

// A real SliceLine behind a fake Durable Object stub, on a fake clock, recording every call.
function fakeLine(slots = 1) {
  const real = new SliceLine(slots);
  const calls = [];
  const stub = {
    enter: async (t) => { calls.push(['enter', t]); return real.enter(t, 0); },
    leave: async (t) => { calls.push(['leave', t]); real.leave(t, 0); },
  };
  return { real, calls, line: () => stub };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a slice goes to the slicer the line picked, then gives the place back', async () => {
  const { line, calls } = fakeLine(2);
  const sent = [];
  const on = async (n, path) => { sent.push([n, path]); return new Response('G1'); };
  const res = await sliceThroughLine(line, on, '/slice', {}, { ticket: TICKET });
  assert.equal(await res.text(), 'G1');
  assert.deepEqual(sent, [[0, '/slice']]);
  assert.deepEqual(calls, [['enter', TICKET], ['leave', TICKET]]);
});

test('no ticket, no line: the page must be reloaded', async () => {
  const { line, calls } = fakeLine();
  for (const ticket of [undefined, '', 'short', 'bad ticket!']) {
    await assert.rejects(sliceThroughLine(line, async () => new Response(''), '/slice', {}, { ticket }),
      (err) => err instanceof LineError && err.code === 'reload');
  }
  assert.deepEqual(calls, []);
});

test('the warm-up skips the line and goes to slicer-0', async () => {
  const { line, calls } = fakeLine();
  const sent = [];
  await sliceThroughLine(line, async (n, path) => { sent.push([n, path]); return new Response('{}'); }, '/health', {});
  assert.deepEqual(sent, [[0, '/health']]);
  assert.deepEqual(calls, []);
});

test('a lost place and a full line become LineErrors', async () => {
  let { line } = fakeLine();
  line().enter = async () => -1;
  await assert.rejects(sliceThroughLine(line, async () => new Response(''), '/slice', {}, { ticket: TICKET }), (e) => e.code === 'left');
  ({ line } = fakeLine());
  line().enter = async () => { throw new Error('full'); };
  await assert.rejects(sliceThroughLine(line, async () => new Response(''), '/slice', {}, { ticket: TICKET }), (e) => e.code === 'full');
});

test('the student going away mid-slice still frees the slicer (the finally never runs)', async () => {
  const { real, line, calls } = fakeLine();
  const abort = new AbortController();
  const kept = [];
  // A cancelled Worker: the slicer never answers, so nothing after the await ever runs.
  sliceThroughLine(line, () => new Promise(() => {}), '/slice', {}, { ticket: TICKET, signal: abort.signal, waitUntil: (p) => kept.push(p) });
  await tick();
  assert.equal(real.status(TICKET, 0).state, 'slicing');
  abort.abort();
  assert.equal(kept.length, 1); // leave() handed to ctx.waitUntil, so it outlives the cancel
  await Promise.all(kept);
  assert.deepEqual(calls, [['enter', TICKET], ['leave', TICKET]]);
  assert.equal(real.status(TICKET, 0).state, 'unknown');
  assert.equal(real.status(TICKET, 0).busy, 0);
});

test('the student going away while in line gives the place up at once', async () => {
  const { real, line } = fakeLine();
  await real.enter('someone1', 0); // the only slicer is busy
  const abort = new AbortController();
  const kept = [];
  const slice = sliceThroughLine(line, async () => new Response('G1'), '/slice', {}, { ticket: TICKET, signal: abort.signal, waitUntil: (p) => kept.push(p) });
  await tick();
  assert.equal(real.status(TICKET, 0).state, 'waiting');
  abort.abort();
  await Promise.all(kept);
  await assert.rejects(slice, (e) => e.code === 'left');
  assert.equal(real.status(TICKET, 0).waiting, 0);
});

test('the place is given back once, not twice', async () => {
  const { line, calls } = fakeLine();
  const abort = new AbortController();
  let answer;
  const slice = sliceThroughLine(line, () => new Promise((r) => { answer = r; }), '/slice', {}, { ticket: TICKET, signal: abort.signal, waitUntil: () => {} });
  await tick();
  abort.abort();
  answer(new Response('G1'));
  await slice;
  assert.equal(calls.filter(([what]) => what === 'leave').length, 1);
});

test('a broken line still slices, on slicer-0', async () => {
  const { line } = fakeLine();
  line().enter = async () => { throw new Error('Durable Object reset'); };
  const sent = [];
  const res = await sliceThroughLine(line, async (n) => { sent.push(n); return new Response('G1'); }, '/slice', {}, { ticket: TICKET });
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [0]);
});
