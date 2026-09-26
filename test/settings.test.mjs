// The student settings are the only thing a student can change, so the checks get tests.
// Run: npm test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLASS_DEFAULTS, INFILL_PATTERNS, PRINTER, SETTINGS, TREE_SUPPORT_INFILL, safeNamePart, summarize,
  toCuraOverrides, validateSettings,
} from '../shared/settings.js';
import { checkPlateSTL } from '../src/worker.js';

test('class defaults match the school profile current_lulzbot_9_18', () => {
  assert.deepEqual({ ...CLASS_DEFAULTS }, {
    quality: 'high_detail', infillDensity: 20, infillPattern: 'grid', walls: 2, support: 'buildplate', supportAngle: 60, adhesion: 'skirt',
  });
  assert.equal(CLASS_DEFAULTS.supportAngle, PRINTER.supportAngleDeg);
  assert.equal(validateSettings(CLASS_DEFAULTS).ok, true);
  assert.equal(summarize(CLASS_DEFAULTS), '0.18 mm · 20% · Tree support · Skirt');
  assert.equal(summarize({ support: 'everywhere', supportAngle: 45 }), '0.18 mm · 20% · Tree support everywhere 45° · Skirt');
  assert.equal(summarize({ support: 'none', supportAngle: 45 }), '0.18 mm · 20% · No support · Skirt');
});

test('missing keys take the class default; unknown keys are dropped', () => {
  const r = validateSettings({ infillDensity: 35, material_print_temperature: 300 });
  assert.equal(r.ok, true);
  assert.equal(r.settings.infillDensity, 35);
  assert.equal(r.settings.quality, 'high_detail');
  assert.equal('material_print_temperature' in r.settings, false);
});

test('values off the lists are refused, never fixed up', () => {
  for (const bad of [
    { infillDensity: 22 }, { infillDensity: 105 }, { infillDensity: -5 }, { infillDensity: '20' }, { infillDensity: 20.5 },
    { quality: 'ultra' }, { infillPattern: 'honeycomb' }, { support: 'normal' }, { adhesion: 'raft' }, { walls: 10 }, { walls: '2' },
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
  for (const k of keys) assert.doesNotMatch(k, /temperature|speed|retract|gcode|fan|material/);
  assert.equal(toCuraOverrides({ quality: 'high_speed' }).quality_type, 'high speed');
  assert.equal(toCuraOverrides(CLASS_DEFAULTS).support_angle, 60);
  assert.equal(validateSettings({ supportAngle: 45 }).settings.supportAngle, 45);
  assert.equal(toCuraOverrides({ supportAngle: 75 }).support_angle, 75);
  for (const p of INFILL_PATTERNS) assert.equal(toCuraOverrides({ infillPattern: p.id }).infill_pattern, p.id);
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
