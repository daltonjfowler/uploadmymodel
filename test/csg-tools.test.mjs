// Connectors and the 9 g servo pocket (web/src/csg-tools.js): results must stay closed solids.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { combine, connectorSpots, dowelPin, FITS, hole, HORN_9G, hornPocket, hornSleeve, peg, servoDepth, servoMount, servoPocket, servoSleeve, SERVO_9G } from '../web/src/csg-tools.js';
import { meshHealth } from '../web/src/mesh-health.js';

function box(x, y, z, sx, sy = sx, sz = sx) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([a, b, c]) => [x + a * sx, y + b * sy, z + c * sz]);
  const t = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(t.flatMap((f) => f.flatMap((i) => v[i])));
}
const volume = (p) => {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    v += p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6]);
  }
  return v / 6;
};
const closed = (p, msg) => {
  const h = meshHealth(p);
  assert.equal(h.openEdges, 0, `${msg}: open edges`);
  assert.equal(h.badEdges, 0, `${msg}: over-shared edges`);
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
const UP = new Vector3(0, 0, 1);

test('a hole cut into the top of a block leaves a closed block with less in it', () => {
  const out = combine(box(0, 0, 0, 30), { cuts: [hole(new Vector3(15, 15, 30), UP.clone().negate(), 3, 10)] });
  closed(out, 'block with hole');
  near(volume(out), 27000 - Math.PI * 9 * 10, 40, 'volume');
});

test('a peg joins onto a face and stays one closed solid', () => {
  const out = combine(box(0, 0, 0, 30), { adds: [peg(new Vector3(15, 15, 30), UP, 3, 8)] });
  closed(out, 'block with peg');
  assert.ok(volume(out) > 27000 + Math.PI * 9 * 7, 'the peg adds its volume');
});

test('a dowel pin is a closed solid lying on the bed', () => {
  const pin = dowelPin(2.5, 16);
  closed(pin, 'pin');
  let z0 = Infinity;
  for (let i = 2; i < pin.length; i += 3) z0 = Math.min(z0, pin[i]);
  near(z0, 0, 1e-4, 'sits on the bed');
});

test('a 9 g servo pocket cut into a block is the right size and leaves it closed', () => {
  const block = box(0, 0, 0, 50, 30, 30);
  const out = combine(block, { cuts: servoPocket(new Vector3(25, 15, 30), UP) });
  closed(out, 'block with servo pocket');
  const s = SERVO_9G, c = s.clearance;
  const body = (s.body[0] + 2 * c) * (s.body[1] + 2 * c) * (s.bodyDepth + s.tabDepth);
  const tabs = ((s.tabs[0] - s.body[0]) * (s.tabs[1] + 2 * c)) * s.tabDepth;
  const removed = 45000 - volume(out);
  assert.ok(removed > body + tabs * 0.9 && removed < body + tabs + 400, `removed ${removed.toFixed(0)} mm³`);
});

test('connector spots sit deepest in the face, two on a long face, none when too thin', () => {
  const sq = [[[0, 0], [20, 0], [20, 20], [0, 20]]];
  const [p] = connectorSpots(sq, 4);
  near(p[0], 10, 1, 'middle x');
  near(p[1], 10, 1, 'middle y');
  assert.equal(connectorSpots([[[0, 0], [120, 0], [120, 14], [0, 14]]], 4).length, 2, 'long face');
  assert.equal(connectorSpots([[[0, 0], [40, 0], [40, 3], [0, 3]]], 4).length, 0, 'too thin');
  const ring = [[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [20, 10], [20, 20], [10, 20]]];
  const [q] = connectorSpots(ring, 3);
  assert.ok(!(q[0] > 10 && q[0] < 20 && q[1] > 10 && q[1] < 20), 'not in the hole');
});

test('pegs on a cut: the peg piece grows, the other gets a matching hole, both stay closed', async () => {
  const { cutByPlanes } = await import('../web/src/plane-cut.js');
  const { addConnectors } = await import('../web/src/csg-tools.js');
  const notes = [];
  const { pieces } = cutByPlanes(box(0, 0, 0, 40, 30, 30), [{ axis: 'z', at: 15 }], (b, a, pl, loops) => {
    const r = addConnectors(b, a, pl, loops, { kind: 'peg', diameter: 6, length: 8 });
    notes.push(r);
    return r;
  });
  assert.equal(notes[0].placed, 1);
  const [lo, hi] = pieces;
  closed(lo.positions, 'peg piece');
  closed(hi.positions, 'hole piece');
  assert.ok(volume(lo.positions) > 40 * 30 * 15 + Math.PI * 9 * 7, 'peg added');
  assert.ok(volume(hi.positions) < 40 * 30 * 15 - Math.PI * 9 * 8, 'hole cut');
});

test('dowels on a cut: holes in both pieces and loose pins', async () => {
  const { cutByPlanes } = await import('../web/src/plane-cut.js');
  const { addConnectors } = await import('../web/src/csg-tools.js');
  const { pieces, extras } = cutByPlanes(box(0, 0, 0, 120, 20, 30), [{ axis: 'x', at: 60 }], (b, a, pl, loops) => addConnectors(b, a, pl, loops, { kind: 'dowel', diameter: 5, length: 16 }));
  for (const p of pieces) closed(p.positions, 'dowel piece');
  assert.ok(extras.length >= 1, 'pins to print');
  for (const pin of extras) closed(pin, 'pin');
});

test('a servo mount on a thin plate: a block with the pocket in its top, all one closed solid', () => {
  const plate = box(0, 0, 0, 60, 40, 4); // 4 mm: far too thin for a pocket
  assert.ok(servoDepth() > 18, 'a pocket needs about 19 mm');
  const m = servoMount(new Vector3(30, 20, 4), UP, 90);
  const out = combine(plate, m);
  closed(out, 'plate with servo mount');
  let z1 = -Infinity;
  for (let i = 2; i < out.length; i += 3) z1 = Math.max(z1, out[i]);
  near(z1, 4 + m.height, 1e-3, 'block top');
  const s = SERVO_9G, c = s.clearance;
  const block = (s.tabs[0] + 2 * c + 4) * (s.tabs[1] + 2 * c + 4) * m.height;
  const pocket = (s.body[0] + 2 * c) * (s.body[1] + 2 * c) * (s.bodyDepth + s.tabDepth);
  const added = volume(out) - 60 * 40 * 4;
  assert.ok(added < block - pocket && added > block - pocket - 1200, `added ${added.toFixed(0)} mm³`);
});

test('servo fits: a looser fit takes more away, and the tabs always seat (pocket deeper than the servo)', () => {
  const block = box(0, 0, 0, 50, 30, 30);
  const taken = (fit) => 45000 - volume(combine(block, { cuts: servoPocket(new Vector3(25, 15, 30), UP, 0, { ...SERVO_9G, clearance: FITS[fit] }) }));
  const [snug, normal, loose] = ['snug', 'normal', 'loose'].map(taken);
  assert.ok(snug < normal && normal < loose, `${snug.toFixed(0)} < ${normal.toFixed(0)} < ${loose.toFixed(0)}`);
  assert.ok(servoDepth() > SERVO_9G.bodyDepth + SERVO_9G.tabDepth, 'room under the servo');
  // a clone SG90 at 23.0 x 12.5 mm still fits Normal with 0.1 mm a side to spare after a 0.2 mm small print
  const c = FITS.normal;
  assert.ok(SERVO_9G.body[0] + 2 * c - 0.2 - 23.0 >= 0.2 && SERVO_9G.body[1] + 2 * c - 0.2 - 12.5 >= 0.2);
});

test('horn pockets: every kind leaves a closed solid with a recess the horn sits in', () => {
  const block = box(0, 0, 0, 60, 60, 12);
  for (const kind of ['single', 'double', 'cross', 'round']) {
    const out = combine(block, { cuts: hornPocket(new Vector3(30, 30, 12), UP, 0, { kind, through: false }) });
    closed(out, kind);
    const taken = 60 * 60 * 12 - volume(out);
    assert.ok(taken > 50 && taken < 1500, `${kind}: took ${taken.toFixed(0)} mm³`);
  }
  // the screw hole goes right through: the block is open from top to bottom in the middle
  const through = combine(block, { cuts: hornPocket(new Vector3(30, 30, 12), UP, 0, { kind: 'double' }) });
  closed(through, 'with the screw hole through');
  const r = (HORN_9G.screwHole + 2 * FITS.normal) / 2;
  assert.ok(60 * 60 * 12 - volume(through) > Math.PI * r * r * 12 * 0.95, 'hole all the way through');
  // a longer arm takes more
  const long = combine(block, { cuts: hornPocket(new Vector3(30, 30, 12), UP, 0, { kind: 'single', armLength: 22, through: false }) });
  const short = combine(block, { cuts: hornPocket(new Vector3(30, 30, 12), UP, 0, { kind: 'single', armLength: 12, through: false }) });
  assert.ok(volume(long) < volume(short), 'arm length changes the pocket');
});

test('walls round the pocket: a pocket in a 4 mm plate stays closed in (Dalton, 2026-10-28)', () => {
  const plate = box(0, 0, 0, 60, 40, 4);
  const at = new Vector3(30, 20, 4);
  const open = combine(plate, { cuts: servoPocket(at, UP) });
  closed(open, 'without walls');
  const walled = combine(plate, { adds: [servoSleeve(at, UP)], cuts: servoPocket(at, UP) });
  closed(walled, 'with walls');
  let z0 = Infinity;
  for (let i = 2; i < walled.length; i += 3) z0 = Math.min(z0, walled[i]);
  near(z0, 4 - servoDepth() - 2, 1e-3, 'floor 2 mm under the pocket, behind the plate');
  assert.ok(volume(walled) > volume(open) + 3000, 'walls and floor added');
  const horn = combine(plate, { adds: [hornSleeve(at, UP, 0, { kind: 'cross' })], cuts: hornPocket(at, UP, 0, { kind: 'cross', throughDepth: 30 }) });
  closed(horn, 'horn with walls');
});

test('shapes pushed into each other are joined before the cut, so it stays closed (Dalton\'s L part, 2026-10-28)', () => {
  const L = new Float32Array([...box(0, 0, 40, 80, 20, 20), ...box(50, 0, 0, 30, 20, 60)]); // share an edge
  assert.ok(meshHealth(L).badEdges > 0, 'the L itself has an edge used four times');
  for (const spin of [0, 90, 33]) {
    const out = combine(L, { cuts: hornPocket(new Vector3(65, 0, 50), new Vector3(0, -1, 0), spin, { kind: 'single', throughDepth: 22 }) });
    closed(out, `horn at ${spin}°`);
  }
});

test('a hollow box keeps its hollow when a pocket is cut into it', () => {
  const outer = box(0, 0, 0, 60, 40, 40);
  const inner = box(3, 3, 3, 54, 34, 34);
  for (let i = 0; i < inner.length; i += 9) for (let k = 0; k < 3; k++) [inner[i + 3 + k], inner[i + 6 + k]] = [inner[i + 6 + k], inner[i + 3 + k]];
  const hollow = new Float32Array([...outer, ...inner]);
  const solidVolume = 60 * 40 * 40 - 54 * 34 * 34;
  near(volume(hollow), solidVolume, 1, 'hollow box volume');
  const at = new Vector3(30, 20, 40);
  const out = combine(hollow, { adds: [servoSleeve(at, UP)], cuts: servoPocket(at, UP) });
  closed(out, 'hollow box with a walled pocket');
  const v = volume(out);
  assert.ok(v > solidVolume && v < solidVolume + 8000, `still hollow, walls added: ${v.toFixed(0)} vs ${solidVolume}`);
});
