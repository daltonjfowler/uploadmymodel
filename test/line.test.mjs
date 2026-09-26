// The slicer line (src/line.js): order, slots, places lost and freed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEASE_MS, MAX_WAITING, STALE_MS, SliceLine } from '../src/line.js';

test('free slots go straight away, one per container', async () => {
  const line = new SliceLine(2);
  assert.equal(await line.enter('aaaaaaaa', 0), 0);
  assert.equal(await line.enter('bbbbbbbb', 0), 1);
  assert.equal(line.status('aaaaaaaa', 0).state, 'slicing');
});

test('the rest wait in arrival order and are told how many are ahead', async () => {
  const line = new SliceLine(2);
  await line.enter('t0000000', 0);
  await line.enter('t1111111', 0);
  const got = [];
  const c = line.enter('t2222222', 1).then((s) => got.push(['c', s]));
  const d = line.enter('t3333333', 2).then((s) => got.push(['d', s]));
  const e = line.enter('t4444444', 3).then((s) => got.push(['e', s]));
  assert.equal(line.status('t2222222', 4).ahead, 0);
  assert.equal(line.status('t4444444', 4).ahead, 2);
  assert.equal(line.status('t4444444', 4).waiting, 3);
  line.leave('t1111111', 10_000); // container 1 frees first
  await c;
  line.leave('t0000000', 11_000);
  await d;
  assert.deepEqual(got, [['c', 1], ['d', 0]]);
  assert.equal(line.status('t4444444', 11_000).ahead, 0);
  line.leave('t2222222', 20_000);
  await e;
  assert.deepEqual(got.at(-1), ['e', 1]);
});

test('the wait guess follows how long slices really took', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  line.enter('bbbbbbbb', 0, { polls: false });
  line.enter('cccccccc', 0, { polls: false });
  line.leave('aaaaaaaa', 30_000); // a 30 s slice; b starts
  const s = line.status('cccccccc', 30_000);
  assert.equal(s.sliceSeconds, 30);
  assert.equal(s.startsInSeconds, 30);
  // 20 s into b's slice, c starts in about 10 s; a slice running long still says a few seconds.
  assert.equal(line.status('cccccccc', 50_000).startsInSeconds, 10);
  assert.equal(line.status('cccccccc', 90_000).startsInSeconds, 3);
});

test('further back waits for the earliest free slicers, one slice each', async () => {
  const line = new SliceLine(2);
  await line.enter('aaaaaaaa', 0);
  await line.enter('bbbbbbbb', 10_000);
  for (const t of ['cccccccc', 'dddddddd', 'eeeeeeee']) line.enter(t, 10_000, { polls: false });
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
  line.status('cccccccc', STALE_MS); // c keeps asking, b does not
  assert.equal(line.status('cccccccc', STALE_MS + 1000).ahead, 0);
  assert.equal(await gone, -1);
  line.leave('aaaaaaaa', STALE_MS + 2000);
  assert.equal(await stays, 0);
});

test('a ticket the Worker made (old page, never asks) keeps its place', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const old = line.enter('bbbbbbbb', 0, { polls: false });
  line.status('zzzzzzzz', STALE_MS * 3);
  line.leave('aaaaaaaa', STALE_MS * 3);
  assert.equal(await old, 0);
});

test('Cancel gives the place up at once', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0);
  line.cancel('bbbbbbbb');
  assert.equal(await b, -1);
  assert.equal(line.status('bbbbbbbb', 1).state, 'unknown');
});

test('a slice that never finished frees its slot after the lease', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  const b = line.enter('bbbbbbbb', 0, { polls: false });
  line.status('bbbbbbbb', LEASE_MS + 1);
  assert.equal(await b, 0);
});

test('a runaway line is refused', async () => {
  const line = new SliceLine(1);
  await line.enter('aaaaaaaa', 0);
  for (let i = 0; i < MAX_WAITING; i++) line.enter(`w${String(i).padStart(7, '0')}`, 0, { polls: false });
  assert.throws(() => line.enter('overflow', 0), /full/);
});
