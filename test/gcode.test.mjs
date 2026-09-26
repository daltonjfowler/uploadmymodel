// The Preview tab's G-code reader, checked against the real school Benchy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LINE_TYPES, filamentGrams, formatDuration, parseGcode } from '../web/src/gcode.js';

const text = readFileSync(new URL('./golden/benchy_school_cura_4.13.2.gcode', import.meta.url), 'utf8');
const g = parseGcode(text);

test('header numbers match the school file', () => {
  assert.equal(g.timeS, 11371);
  assert.equal(g.filamentM, 2.76414);
  assert.equal(g.filamentG, 20.63);
  assert.equal(g.layerHeight, 0.18);
  assert.equal(g.flavor, 'Marlin');
  assert.equal(formatDuration(g.timeS), '3 h 10 min');
  assert.ok(Math.abs(filamentGrams(2.76414) - 20.63) < 0.2);
});

test('266 layers, first at 0.35 mm, then 0.18 mm steps, top at MAXZ 48.05', () => {
  assert.equal(g.layers.length, 266);
  assert.ok(Math.abs(g.layers[0] - 0.35) < 1e-4, String(g.layers[0]));
  assert.ok(Math.abs(g.layers[1] - 0.53) < 1e-4, String(g.layers[1]));
  assert.ok(Math.abs(g.layers.at(-1) - 48.05) < 1e-3, String(g.layers.at(-1)));
});

test('every line type the school file uses is found; printed lines stay inside the header bounds', () => {
  const byId = Object.fromEntries(LINE_TYPES.map((t, i) => [t.id, g.types[i].segments.length / 6]));
  for (const id of ['WALL-OUTER', 'WALL-INNER', 'SKIN', 'FILL', 'SUPPORT', 'SKIRT']) assert.ok(byId[id] > 0, id);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of g.types) {
    const s = t.segments;
    for (let i = 0; i < s.length; i += 3) {
      minX = Math.min(minX, s[i]); maxX = Math.max(maxX, s[i]);
      minY = Math.min(minY, s[i + 1]); maxY = Math.max(maxY, s[i + 1]);
    }
    assert.equal(t.layerStart.length, 267);
    assert.equal(t.layerStart[266], t.segments.length);
  }
  // ;MINX:104.051 ;MAXX:174.79 ;MINY:112.938 ;MAXY:166.598
  assert.ok(Math.abs(minX - 104.051) < 0.01 && Math.abs(maxX - 174.79) < 0.01, `${minX} ${maxX}`);
  assert.ok(Math.abs(minY - 112.938) < 0.01 && Math.abs(maxY - 166.598) < 0.01, `${minY} ${maxY}`);
});
