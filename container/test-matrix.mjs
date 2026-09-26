// Slice a test piece through the slicer container with every student choice and check the
// G-code (layer height, supports on/off, infill, first-layer temperature per quality file).
//   docker run --rm -p 8090:8080 uploadmymodel-slicer
//   node container/test-matrix.mjs [http://127.0.0.1:8090]
import { CLASS_DEFAULTS, INFILL_PATTERNS, toCuraOverrides } from '../shared/settings.js';
import { parseGcode } from '../web/src/gcode.js';
import { sampleModel } from './sample-model.mjs';

const SLICER = process.argv[2] || 'http://127.0.0.1:8090';
// The page's sample piece (base, tower, overhanging arm), in printer coordinates like the Worker sends.
const tris = sampleModel();
const stl = Buffer.alloc(84 + (tris.length / 9) * 50);
stl.writeUInt32LE(tris.length / 9, 80);
for (let t = 0; t < tris.length / 9; t++) {
  for (let k = 0; k < 9; k++) stl.writeFloatLE(tris[t * 9 + k] + (k % 3 === 2 ? 0 : 140), 84 + t * 50 + 12 + k * 4);
}
const cases = [
  { quality: 'high_speed' }, { quality: 'standard' }, { quality: 'high_detail' },
  ...INFILL_PATTERNS.map((p) => ({ infillPattern: p.id, infillDensity: 25 })),
  { infillDensity: 0 }, { infillDensity: 100 }, { walls: 4 }, { walls: 3 },
  { support: 'none' }, { support: 'everywhere' }, { supportAngle: 40 }, { supportAngle: 80 },
  { adhesion: 'brim' }, { quality: 'high_speed', adhesion: 'brim', support: 'everywhere', infillPattern: 'gyroid', walls: 4 },
];
let bad = 0;
for (const c of cases) {
  const s = { ...CLASS_DEFAULTS, ...c };
  const t0 = Date.now();
  const res = await fetch(`${SLICER}/slice`, { method: 'POST', body: stl, headers: { 'x-cura-settings': JSON.stringify(toCuraOverrides(s)) } });
  const text = await res.text();
  if (!res.ok) { console.log('FAIL', JSON.stringify(c), res.status, text.slice(0, 200)); bad++; continue; }
  const g = parseGcode(text);
  const lh = { high_speed: 0.38, standard: 0.25, high_detail: 0.18 }[s.quality];
  const types = ['WALL-OUTER', 'WALL-INNER', 'SKIN', 'FILL', 'SUPPORT', 'SKIRT'].map((_, i) => g.types[i].segments.length / 6);
  const problems = [];
  if (Math.abs(g.layerHeight - lh) > 1e-6) problems.push(`layer height ${g.layerHeight}`);
  if (s.support === 'none' && types[4] > 0) problems.push('support printed with supports off');
  if (s.support !== 'none' && types[4] === 0) problems.push('no support printed');
  if (s.infillDensity === 0 && types[3] > 0) problems.push('infill at 0%');
  if (s.infillDensity > 0 && s.infillDensity < 100 && types[3] === 0) problems.push('no infill');
  const firstC = s.quality === 'high_detail' ? 205 : 210; // 4.13.2 quality files
  if (!new RegExp('M109 R' + firstC + ' ').test(text)) problems.push('first-layer temp not ' + firstC);
  const brimLike = types[5];
  if (problems.length) bad++;
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${JSON.stringify(c).padEnd(70)} ${((Date.now() - t0) / 1000).toFixed(1)}s layers ${g.layers.length} time ${res.headers.get('x-print-time-s')}s ${res.headers.get('x-filament-g')}g skirt/brim lines ${brimLike} attempts ${res.headers.get('x-attempts')} ${problems.join('; ')}`);
}
console.log(bad ? `${bad} problem(s)` : 'all good');
process.exit(bad ? 1 : 0);
