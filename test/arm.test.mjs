// The "Assistant to the Regional Manager" tab (shared/arm.js): its allow-list, the slicer's copy of
// it, that nothing on it can touch temperatures/speeds/motion limits, and the Worker's password gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import {
  ARM_LABEL, ARM_SETTINGS, activeArm, curaKeys, armAgainstClass, armIsUsed, armValues, summarizeArm, toArmOverrides, validateArm,
} from '../shared/arm.js';
import { CLASS_DEFAULTS, DEFAULT_CLASS_CONFIG, PRINTER } from '../shared/settings.js';
import worker from '../src/worker.js';
import { memoryStore } from '../src/lockout.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('the tab is called what Dalton asked for', () => {
  assert.equal(ARM_LABEL, 'Assistant to the Regional Manager');
});

test('validateArm: only listed choices, pauses in range, profile means "not sent"', () => {
  assert.deepEqual(validateArm(undefined), { ok: true, arm: { settings: {}, pauses: [] } });
  assert.deepEqual(validateArm({ settings: { fuzzy: 'on', seam: 'profile' }, pauses: [12.5, 5, 5] }),
    { ok: true, arm: { settings: { fuzzy: 'on' }, pauses: [5, 12.5] } });
  for (const bad of [
    { settings: { material_print_temperature: 250 } }, { settings: { fuzzy: true } }, { settings: { brimWidth: '21' } },
    { pauses: [0.4] }, { pauses: [281] }, { pauses: [5.01] }, { pauses: [1, 2, 3, 4] }, { pauses: ['5'] }, [], 'x',
  ]) assert.equal(validateArm(bad).ok, false, JSON.stringify(bad));
});

test('needs: a sub-setting only counts when its parent is on', () => {
  const arm = { settings: { fuzzyAmount: 'wild', ironTopOnly: 'on', brimWidth: '20', skirtLines: '3' }, pauses: [] };
  assert.deepEqual(activeArm(arm, { adhesion: 'skirt' }), { skirtLines: '3' });
  assert.deepEqual(toArmOverrides({ settings: { ...arm.settings, fuzzy: 'on', ironing: 'on' } }, { adhesion: 'brim' }), {
    magic_fuzzy_skin_enabled: true, magic_fuzzy_skin_thickness: 0.5, ironing_enabled: true, ironing_only_highest_layer: true, brim_line_count: 40,
  });
  assert.equal(armIsUsed({ settings: {}, pauses: [] }), false);
  assert.equal(armIsUsed({ settings: {}, pauses: [5] }), true);
  assert.equal(summarizeArm({ settings: { fuzzy: 'on', vase: 'on' }, pauses: [5, 9] }, CLASS_DEFAULTS), 'Fuzzy skin · Vase mode · 2 pauses');
});

test('a teacher lock on walls / infill pattern also locks the ARM replacements', () => {
  const config = { ...DEFAULT_CLASS_CONFIG, open: { ...DEFAULT_CLASS_CONFIG.open, walls: false } };
  assert.deepEqual(armAgainstClass({ settings: { moreWalls: '6', fuzzy: 'on' } }, CLASS_DEFAULTS, config), ['More wall choices']);
  assert.deepEqual(armAgainstClass({ settings: { morePatterns: 'cross' } }, CLASS_DEFAULTS, config), []);
});

test("the slicer's allow-list is exactly shared/arm.js (run scripts/arm-values.mjs after a change)", () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../container/arm_values.json', import.meta.url), 'utf8')), armValues());
});

test('nothing on the tab can touch temperature, speed, flow, cooling, retraction, travel or G-code', () => {
  const forbidden = /temp|speed|flow|cool|fan|retract|travel|accel|jerk|gcode|sequence|machine_|material_|prime|wipe|hop|z_offset|layer_height$/;
  for (const key of ARM_SETTINGS.flatMap(curaKeys)) assert.doesNotMatch(key, forbidden, key);
});

test('every ARM key is a real Cura 4.13.2 setting, and every number is inside its limits', () => {
  const def = JSON.parse(readFileSync(new URL('../engine/res4132/definitions/fdmprinter.def.json', import.meta.url), 'utf8'));
  const flat = {};
  const walk = (n) => { for (const [k, v] of Object.entries(n)) { flat[k] = v; if (v.children) walk(v.children); } };
  for (const s of Object.values(def.settings)) walk(s.children ?? {});
  for (const [d, key] of ARM_SETTINGS.flatMap((x) => curaKeys(x).map((k) => [x, k]))) {
    const cura = flat[key];
    assert.ok(cura, `${key} is not in fdmprinter.def.json`);
    for (const o of d.options.filter((x) => x.value !== null)) {
      if (cura.type === 'bool') assert.equal(typeof o.value, 'boolean', d.id);
      else if (cura.type === 'enum') assert.ok(o.value in cura.options, `${d.id}: ${o.value}`);
      else {
        assert.equal(typeof o.value, 'number', d.id);
        for (const [key, cmp] of [['minimum_value', (v, lim) => v >= lim], ['minimum_value_warning', (v, lim) => v >= lim], ['maximum_value_warning', (v, lim) => v <= lim]]) {
          const lim = Number(cura[key]);
          if (Number.isFinite(lim)) assert.ok(cmp(o.value, lim), `${d.id}: ${o.value} vs ${key} ${lim}`);
        }
      }
    }
  }
});

// ---- The Worker's password gate ------------------------------------------------------------------

function plateSTL() {
  const buf = new ArrayBuffer(84 + 50);
  const v = new DataView(buf);
  v.setUint32(80, 1, true);
  const mid = PRINTER.bed.x / 2;
  [[mid, mid, 0], [mid + 10, mid, 0], [mid, mid + 10, 10]].flat().forEach((n, i) => v.setFloat32(96 + i * 4, n, true));
  return buf;
}

const PHRASE = 'orange-walrus-taco';
const DEVICE = '11111111-2222-4333-8444-555555555555';

function env({ config = null, armKey = 'test-arm-key' } = {}) {
  const store = { class: config, slicing: { phrase: PHRASE, until: Date.now() + 3_600_000 } };
  return {
    SLICER_URL: 'http://slicer.test',
    ARM_KEY: armKey,
    lockoutStore: memoryStore(),
    CLASS_KV: { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = JSON.parse(v); }, delete: async (k) => { store[k] = null; } },
    ASSETS: { fetch: async () => new Response('asset') },
  };
}

async function sliceRequest({ arm, key, settings = {} } = {}) {
  const form = new FormData();
  form.append('model', new Blob([plateSTL()]), 'plate.stl');
  form.append('settings', JSON.stringify(settings));
  form.append('name', 'Jordan');
  form.append('modelName', 'Vase');
  if (arm) form.append('arm', JSON.stringify(arm));
  const body = new Request('https://uploadmymodel.com/api/slice', { method: 'POST', body: form });
  const bytes = await body.arrayBuffer();
  return new Request('https://uploadmymodel.com/api/slice', {
    method: 'POST', body: bytes,
    headers: {
      'content-type': body.headers.get('content-type'), 'content-length': String(bytes.byteLength),
      'x-class-phrase': PHRASE, 'x-slice-ticket': 'abcdef12-3456-7890', 'cf-connecting-ip': '203.0.113.9', 'x-client-id': DEVICE,
      ...(key ? { 'x-arm-key': key } : {}),
    },
  });
}

function fakeSlicer(done = '') {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(';FLAVOR:Marlin\nG28\n', { status: 200, headers: { 'x-print-time-s': '600', 'x-filament-g': '3', 'x-layers': '40', 'x-pauses-done': done } });
  };
  return calls;
}

const ARM = { settings: { fuzzy: 'on', moreWalls: '6' }, pauses: [5] };

test('slicing with ARM extras needs the password; the right one sends them to the slicer', async () => {
  let calls = fakeSlicer();
  for (const key of [undefined, 'wrong']) {
    const res = await worker.fetch(await sliceRequest({ arm: ARM, key }), env());
    assert.equal(res.status, 403, String(key));
    assert.equal((await res.json()).error, 'arm');
  }
  assert.equal(calls.length, 0, 'the slicer is never reached without the password');

  calls = fakeSlicer('5@20');
  const res = await worker.fetch(await sliceRequest({ arm: ARM, key: 'test-arm-key' }), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-pauses-done'), '5@20');
  const sent = JSON.parse(calls[0].init.headers['x-cura-settings']);
  assert.equal(sent.magic_fuzzy_skin_enabled, true);
  assert.equal(sent.wall_line_count, 6);
  assert.equal(calls[0].init.headers['x-pauses'], '[5]');
});

test('without extras nothing changes: no password needed, no extra keys, no pauses header', async () => {
  const calls = fakeSlicer();
  const res = await worker.fetch(await sliceRequest({ arm: { settings: {}, pauses: [] } }), env());
  assert.equal(res.status, 200);
  assert.equal(Object.keys(JSON.parse(calls[0].init.headers['x-cura-settings'])).includes('magic_fuzzy_skin_enabled'), false);
  assert.equal(calls[0].init.headers['x-pauses'], undefined);
});

test('no ARM_KEY secret set = the tab cannot be used', async () => {
  fakeSlicer();
  const res = await worker.fetch(await sliceRequest({ arm: ARM, key: 'anything' }), env({ armKey: '' }));
  assert.equal(res.status, 403);
});

test('a teacher lock on walls refuses "More wall choices"', async () => {
  const calls = fakeSlicer();
  const config = { ...DEFAULT_CLASS_CONFIG, open: { ...DEFAULT_CLASS_CONFIG.open, walls: false } };
  const res = await worker.fetch(await sliceRequest({ arm: ARM, key: 'test-arm-key' }), env({ config }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('/api/arm checks the password; five wrong tries lock that device', async () => {
  const e = env();
  const ask = (key) => worker.fetch(new Request('https://uploadmymodel.com/api/arm', {
    method: 'POST', headers: { 'x-arm-key': key, 'x-client-id': DEVICE, 'cf-connecting-ip': '203.0.113.9' },
  }), e);
  assert.equal((await ask('test-arm-key')).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await ask('nope')).status, 403);
  const locked = await ask('test-arm-key');
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'locked');
});
