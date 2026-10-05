// The student settings are the only thing a student can change, so the checks get tests.
// Run: npm test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASS_DEFAULTS, DEFAULT_CLASS_CONFIG, INFILL_PATTERNS, MATERIALS, PRINTER, SETTINGS, TREE_SUPPORT_INFILL, applyClassLocks, checkAgainstClass, lockedRows,
  SIMPLE_QUALITIES, gcodeFileName, safeNamePart, summarize, toCuraOverrides, validateClassConfig, validateSettings,
} from '../shared/settings.js';
import { MAX_PHRASE, MIN_PHRASE, PHRASE_COUNT, PHRASE_WORDS, generatePhrase, normalizePhrase, validateOpenRequest } from '../shared/slicing.js';
import { checkPlateSTL } from '../src/worker.js';

test('class defaults: the school profile current_lulzbot_9_18, but Standard layers (0.25 mm)', () => {
  assert.deepEqual({ ...CLASS_DEFAULTS }, {
    material: 'polylite_pla', quality: 'standard', infillDensity: 20, infillPattern: 'grid', walls: 2, support: 'buildplate', supportAngle: 60, adhesion: 'skirt',
  });
  assert.equal(CLASS_DEFAULTS.supportAngle, PRINTER.supportAngleDeg);
  assert.equal(validateSettings(CLASS_DEFAULTS).ok, true);
  assert.equal(summarize(CLASS_DEFAULTS), '0.25 mm · 20% · Tree support · Skirt');
  assert.equal(summarize({ support: 'everywhere', supportAngle: 45 }), '0.25 mm · 20% · Tree support everywhere 45° · Skirt');
  assert.equal(summarize({ support: 'none', supportAngle: 45 }), '0.25 mm · 20% · No support · Skirt');
});

test('missing keys take the class default; unknown keys are dropped', () => {
  const r = validateSettings({ infillDensity: 35, material_print_temperature: 300 });
  assert.equal(r.ok, true);
  assert.equal(r.settings.infillDensity, 35);
  assert.equal(r.settings.quality, 'standard');
  assert.equal('material_print_temperature' in r.settings, false);
});

test('values off the lists are refused, never fixed up', () => {
  for (const bad of [
    { infillDensity: 22 }, { infillDensity: 105 }, { infillDensity: -5 }, { infillDensity: '20' }, { infillDensity: 20.5 },
    { quality: 'ultra' }, { infillPattern: 'honeycomb' }, { support: 'normal' }, { adhesion: 'glue' }, { walls: 10 }, { walls: '2' },
    { supportAngle: 35 }, { supportAngle: 85 }, { supportAngle: 62 }, { supportAngle: '60' },
  ]) {
    assert.equal(validateSettings(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateSettings(null).ok, false);
  assert.equal(validateSettings([1]).ok, false);
});

test('every setting is a list or a stepped range (no free-typed numbers)', () => {
  for (const def of SETTINGS) {
    assert.ok(def.kind === 'choice' || def.kind === 'range', def.id);
    if (def.kind === 'range') assert.ok(def.step > 0 && Number.isInteger(def.min) && Number.isInteger(def.max));
  }
});

test('Cura overrides: tree supports always 0% infill, temperatures never present', () => {
  for (const support of ['none', 'buildplate', 'everywhere']) {
    const c = toCuraOverrides({ ...CLASS_DEFAULTS, support });
    assert.equal(c.support_infill_rate, TREE_SUPPORT_INFILL);
    assert.equal(c.support_infill_rate, 0);
    assert.equal(c.support_structure, 'tree');
    assert.equal(c.support_enable, support !== 'none');
  }
  const keys = Object.keys(toCuraOverrides(CLASS_DEFAULTS));
  for (const k of keys) assert.doesNotMatch(k, /temperature|speed|retract|gcode|fan|material_/);
  // The material is only ever a NAME from the list; its temperatures come from LulzBot's files.
  assert.ok(MATERIALS.some((m) => m.id === toCuraOverrides(CLASS_DEFAULTS).material));
  assert.equal(toCuraOverrides({ ...CLASS_DEFAULTS, material: 'nylon' }).material, 'polylite_pla');
  assert.equal(toCuraOverrides({ quality: 'high_speed' }).quality_type, 'high speed');
  assert.equal(toCuraOverrides(CLASS_DEFAULTS).support_angle, 60);
  assert.equal(validateSettings({ supportAngle: 45 }).settings.supportAngle, 45);
  assert.equal(toCuraOverrides({ supportAngle: 75 }).support_angle, 75);
  for (const p of INFILL_PATTERNS) assert.equal(toCuraOverrides({ infillPattern: p.id }).infill_pattern, p.id);
});

test('locked temperature rows follow the layer height (4.13.2 quality files)', () => {
  const nozzle = (quality) => lockedRows({ quality })[0].rows.find((r) => r[0] === 'Nozzle temperature')[1];
  assert.equal(nozzle('high_detail'), '210 °C (205 °C first layer)');
  assert.equal(nozzle('standard'), '215 °C (210 °C first layer)');
  assert.equal(nozzle('high_speed'), '215 °C (210 °C first layer)');
});

test('G-code file names: the student own name, or name-model', () => {
  assert.equal(gcodeFileName('', 'Jordan', 'Rocket Ship'), 'jordan-rocket-ship.gcode');
  assert.equal(gcodeFileName('', '', 'Rocket'), 'rocket.gcode');
  assert.equal(gcodeFileName('My Rocket!!', 'Jordan', 'x'), 'my-rocket.gcode');
  assert.equal(gcodeFileName('boat.gcode', 'Jordan', 'x'), 'boat.gcode');
  assert.equal(gcodeFileName('../../evil', 'Jordan', 'x'), 'evil.gcode');
  assert.equal(gcodeFileName('???', 'Jordan', 'Boat'), 'jordan-boat.gcode'); // nothing usable: default
  assert.ok(gcodeFileName('a'.repeat(80), '', '').length <= 30 + 6);
  assert.equal(gcodeFileName('', 'Alexandria-Rosemary', 'Very Long Model Name Here'), 'alexandria-rosemary-very-long.gcode');
});

test('class phrases: forgiving to type, strict to check', () => {
  assert.equal(normalizePhrase('  Orange Walrus__TACO '), 'orange-walrus-taco');
  assert.equal(normalizePhrase('orange--walrus-taco!'), 'orange-walrus-taco');
  assert.equal(normalizePhrase('Golden Walrus Lantern 42'), 'golden-walrus-lantern-42');
  assert.match(generatePhrase(), /^[a-z]+-[a-z]+-[a-z]+-[1-9][0-9]$/);
  assert.deepEqual(validateOpenRequest({ minutes: 50, phrase: 'Blue Robot Pancake' }), { ok: true, phrase: 'blue-robot-pancake', minutes: 50 });
  for (const bad of [{ minutes: 51, phrase: 'blue-robot-pancake' }, { minutes: 50, phrase: '' }, { minutes: 50, phrase: '!!' }, { minutes: 50, phrase: 'x'.repeat(41) }, null]) {
    assert.equal(validateOpenRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test("class phrases: a teacher's own can be any length up to the box (Dalton's call)", () => {
  assert.equal(MIN_PHRASE, 1);
  assert.deepEqual(validateOpenRequest({ minutes: 50, phrase: 'Cat' }), { ok: true, phrase: 'cat', minutes: 50 });
  assert.equal(validateOpenRequest({ minutes: 50, phrase: '7' }).ok, true);
});

test('class phrases: "Set phrase" changes the phrase and keeps the window', () => {
  assert.deepEqual(validateOpenRequest({ phrase: 'Room 12', keep: true }), { ok: true, phrase: 'room-12', keep: true });
  assert.equal(validateOpenRequest({ phrase: '', keep: true }).ok, false);
  assert.equal(validateOpenRequest({ phrase: 'room-12', keep: 'yes' }).ok, false); // no minutes, not a keep
});

test('suggested phrases: too many to guess, easy to type', () => {
  // 60 guesses a minute per address (SLICE_RATE_IP) against at least 2^28 phrases.
  assert.ok(PHRASE_COUNT >= 2 ** 28, `only ${PHRASE_COUNT} phrases`);
  const words = PHRASE_WORDS.flat();
  assert.deepEqual(words.filter((w, i) => words.indexOf(w) !== i), [], 'no word twice');
  for (const w of words) assert.match(w, /^[a-z]{3,11}$/, w);
  // Every phrase the button can make is one the teacher could also type in, and fits the box.
  const longest = PHRASE_WORDS.map((list) => Math.max(...list.map((w) => w.length))).reduce((a, b) => a + b) + 3 + 2;
  const shortest = PHRASE_WORDS.map((list) => Math.min(...list.map((w) => w.length))).reduce((a, b) => a + b) + 3 + 2;
  assert.ok(longest <= MAX_PHRASE && shortest >= MIN_PHRASE, `${shortest}..${longest}`);
  // The ends of each list and the number range are reachable.
  assert.equal(generatePhrase(() => 0), `${PHRASE_WORDS.map((l) => l[0]).join('-')}-10`);
  assert.equal(generatePhrase(() => 0.999999), `${PHRASE_WORDS.map((l) => l.at(-1)).join('-')}-99`);
  for (let i = 0; i < 200; i++) assert.equal(validateOpenRequest({ minutes: 50, phrase: generatePhrase() }).ok, true);
  // Some words that must never be in a list (names, double meanings, tricky spellings).
  for (const w of ['taco', 'banana', 'pickle', 'muffin', 'amber', 'violet', 'rusty', 'raven', 'desert', 'arctic', 'leopard', 'grey', 'gray']) {
    assert.equal(words.includes(w), false, w);
  }
});

test('adhesion: skirt, brim, raft, none; summary reads well', () => {
  for (const a of ['skirt', 'brim', 'raft', 'none']) {
    assert.equal(validateSettings({ adhesion: a }).ok, true, a);
    assert.equal(toCuraOverrides({ adhesion: a }).adhesion_type, a);
  }
  assert.equal(validateSettings({ adhesion: 'glue' }).ok, false);
  assert.match(summarize({ adhesion: 'raft' }), / · Raft$/);
  assert.match(summarize({ adhesion: 'none' }), / · No skirt$/);
});

test('safe file names', () => {
  assert.equal(safeNamePart('Jordan B.'), 'jordan-b');
  assert.equal(safeNamePart('  Zoë  Smith '), 'zoe-smith');
  assert.equal(safeNamePart('../../etc/passwd'), 'etcpasswd');
  assert.equal(safeNamePart('<script>'), 'script');
  assert.equal(safeNamePart('', 'model'), 'model');
  assert.equal(safeNamePart('!!!', 'model'), 'model');
  assert.ok(safeNamePart('a'.repeat(100)).length <= 24);
});

// ---- Server-side STL checks ----

function stl(tris) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const v = new DataView(buf);
  v.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const n of t.flat()) { v.setFloat32(off, n, true); off += 4; }
    off += 2;
  }
  return buf;
}
const mid = PRINTER.bed.x / 2;
const tri = (dx = 0, z = 0) => [[mid + dx, mid, z], [mid + dx + 10, mid, z], [mid + dx, mid + 10, z + 10]];

test('plate STL: a model in the middle of the bed passes', () => {
  const r = checkPlateSTL(stl([tri()]));
  assert.equal(r.ok, true);
  assert.equal(r.triangles, 1);
  assert.deepEqual(r.size, [10, 10, 10]);
});

test('plate STL: off the bed, floating, broken, or truncated is refused', () => {
  assert.equal(checkPlateSTL(stl([tri(200)])).ok, false); // past the right edge
  assert.equal(checkPlateSTL(stl([tri(0, 5)])).ok, false); // floating
  assert.equal(checkPlateSTL(stl([[[NaN, 0, 0], [1, 1, 1], [2, 2, 2]]])).ok, false);
  const good = stl([tri()]);
  assert.equal(checkPlateSTL(good.slice(0, good.byteLength - 10)).ok, false);
  assert.equal(checkPlateSTL(new ArrayBuffer(10)).ok, false);
  // too tall
  assert.equal(checkPlateSTL(stl([[[mid, mid, 0], [mid + 1, mid, 0], [mid, mid, PRINTER.bed.z + 1]]])).ok, false);
});

// ---- Teacher's class setup ----

test('class setup: defaults are all open with the school profile', () => {
  const v = validateClassConfig({});
  assert.equal(v.ok, true);
  assert.deepEqual(v.config.defaults, { ...CLASS_DEFAULTS });
  assert.ok(SETTINGS.every((d) => v.config.open[d.id] === true));
  assert.equal(v.config.message, '');
});

test('class setup: bad values are refused', () => {
  for (const bad of [
    null, [], { open: { walls: 'no' } }, { open: [] }, { defaults: { infillDensity: 7 } },
    { defaults: { quality: 'ultra' } }, { message: 5 }, { message: 'x'.repeat(161) },
  ]) {
    assert.equal(validateClassConfig(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateClassConfig({ message: 'a\u0000b' }).config.message, 'a b');
});

test('class setup: print time limit is one of the choices', () => {
  assert.equal(validateClassConfig({}).config.maxPrintMinutes, 0);
  assert.equal(validateClassConfig({ maxPrintMinutes: 120 }).config.maxPrintMinutes, 120);
  for (const bad of [100, -30, '60', 60.5, null]) assert.equal(validateClassConfig({ maxPrintMinutes: bad }).ok, false, String(bad));
  // USB copy to the printer's card: on unless the teacher turns it off (old saved setups keep it on).
  assert.equal(validateClassConfig({}).config.usbCopy, true);
  assert.equal(validateClassConfig({ usbCopy: false }).config.usbCopy, false);
  assert.equal(validateClassConfig({ usbCopy: 'no' }).ok, false);
});

test('class setup: locked settings must match the teacher, open ones may differ', () => {
  const { config } = validateClassConfig({ open: { walls: false, infillDensity: false }, defaults: { walls: 3, infillDensity: 15 } });
  assert.deepEqual(checkAgainstClass({ ...CLASS_DEFAULTS, walls: 3, infillDensity: 15, quality: 'standard' }, config), []);
  assert.deepEqual(checkAgainstClass({ ...CLASS_DEFAULTS, walls: 2, infillDensity: 15 }, config), ['Wall count']);
  const fixed = applyClassLocks({ ...CLASS_DEFAULTS, walls: 4, infillDensity: 60, quality: 'standard' }, config);
  assert.equal(fixed.walls, 3);
  assert.equal(fixed.infillDensity, 15);
  assert.equal(fixed.quality, 'standard'); // open: the student's choice stays
});

test('Recommended shows Fast and Standard; Fine detail is in Custom only', () => {
  assert.deepEqual(SIMPLE_QUALITIES, ['high_speed', 'standard']);
  assert.equal('layer_height' in toCuraOverrides({ quality: 'standard' }), false);
});

test('materials: PLA, PETG and TPU; the teacher allows PLA only to start', () => {
  assert.deepEqual(MATERIALS.map((m) => m.id), ['polylite_pla', 'polylite_petg', 'polyflex_tpu95']);
  assert.deepEqual(DEFAULT_CLASS_CONFIG.materials, ['polylite_pla']);
  assert.equal(validateSettings({ material: 'polylite_petg' }).settings.material, 'polylite_petg');
  assert.equal(validateSettings({ material: 'nylon' }).ok, false);
  const pla = validateClassConfig({}).config;
  assert.deepEqual(checkAgainstClass({ ...CLASS_DEFAULTS, material: 'polylite_petg' }, pla), ['Material']);
  assert.equal(applyClassLocks({ material: 'polylite_petg' }, pla).material, 'polylite_pla');
  const both = validateClassConfig({ materials: ['polyflex_tpu95', 'polylite_petg'] }).config;
  assert.deepEqual(both.materials, ['polylite_petg', 'polyflex_tpu95']);
  assert.equal(both.defaults.material, 'polylite_petg', 'the class default moves to an allowed material');
  assert.deepEqual(checkAgainstClass({ ...both.defaults, material: 'polyflex_tpu95' }, both), []);
  for (const bad of [[], ['nylon'], 'polylite_pla']) assert.equal(validateClassConfig({ materials: bad }).ok, false, JSON.stringify(bad));
});

test('materials: the file name says which filament, the locked rows show its temperatures', () => {
  assert.equal(gcodeFileName('', 'Jordan', 'Rocket', 'polylite_pla'), 'jordan-rocket.gcode');
  assert.equal(gcodeFileName('', 'Jordan', 'Rocket', 'polylite_petg'), 'jordan-rocket-petg.gcode');
  assert.equal(gcodeFileName('My Case', 'Jordan', 'x', 'polyflex_tpu95'), 'my-case-tpu.gcode');
  assert.equal(gcodeFileName('case-tpu', 'Jordan', 'x', 'polyflex_tpu95'), 'case-tpu.gcode');
  assert.ok(gcodeFileName('a'.repeat(40), '', '', 'polylite_petg').replace('.gcode', '').length <= 30);
  const rows = Object.fromEntries(lockedRows({ ...CLASS_DEFAULTS, material: 'polylite_petg' })[0].rows);
  assert.equal(rows.Filament, 'Polymaker PolyLite PETG, 2.85 mm');
  assert.equal(rows['Nozzle temperature'], '240 °C (240 °C first layer)');
  assert.equal(rows['Bed temperature'], '80 °C (75 °C first layer)');
  assert.match(summarize({ ...CLASS_DEFAULTS, material: 'polyflex_tpu95' }), /^TPU · /);
});

test('class phrases never use the words Dalton struck (giggle combos like "blue pancake")', () => {
  const words = PHRASE_WORDS.flat();
  for (const w of ['pancake', 'waffle', 'starfish', 'brown']) assert.ok(!words.includes(w), w);
});
