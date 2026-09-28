// Slice the sample piece through a real slicer container once for every "Assistant to the Regional
// Manager" choice (shared/arm.js), plus colour-change pauses and the build-volume guard.
//   docker build -f container/Dockerfile -t uploadmymodel-slicer . && docker run --rm -p 8090:8080 uploadmymodel-slicer
//   node container/test-arm.mjs [http://127.0.0.1:8090]
import { ARM_SETTINGS, toArmOverrides } from '../shared/arm.js';
import { CLASS_DEFAULTS, toCuraOverrides } from '../shared/settings.js';
import { sampleModel } from './sample-model.mjs';

const SLICER = process.argv[2] || 'http://127.0.0.1:8090';
const tris = sampleModel();

function stlAt(dx, dy) {
  const stl = Buffer.alloc(84 + (tris.length / 9) * 50);
  stl.writeUInt32LE(tris.length / 9, 80);
  for (let t = 0; t < tris.length / 9; t++) {
    for (let k = 0; k < 9; k++) stl.writeFloatLE(tris[t * 9 + k] + (k % 3 === 0 ? dx : k % 3 === 1 ? dy : 0), 84 + t * 50 + 12 + k * 4);
  }
  return stl;
}

async function slice(base, arm, { pauses, stl = stlAt(140, 140) } = {}) {
  const headers = { 'content-type': 'model/stl', 'x-cura-settings': JSON.stringify({ ...toCuraOverrides(base), ...toArmOverrides(arm, base) }) };
  if (pauses) headers['x-pauses'] = JSON.stringify(pauses);
  const t = Date.now();
  const res = await fetch(`${SLICER}/slice`, { method: 'POST', body: stl, headers });
  const text = await res.text();
  return { status: res.status, text, s: ((Date.now() - t) / 1000).toFixed(1), done: res.headers.get('x-pauses-done') };
}

let failed = 0;
const report = (ok, name, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? `: ${extra}` : ''}`);
};

// The moves only (no ;comments, no ;SETTING footer), to see that a choice really changed the print.
const moves = (text) => text.split('\n').filter((l) => /^G[01] /.test(l)).join('\n');
const plain = {};
for (const def of ARM_SETTINGS) {
  for (const o of def.options.filter((x) => x.value !== null)) {
    const settings = { [def.id]: o.id };
    for (const [k, v] of Object.entries(def.needs ?? {})) settings[k] = v;
    const base = { ...CLASS_DEFAULTS, ...(def.needsBase ?? {}) };
    const key = JSON.stringify(base);
    plain[key] ??= moves((await slice(base, { settings: Object.fromEntries(Object.entries(def.needs ?? {})) })).text);
    const r = await slice(base, { settings });
    // The sample piece has no holes, and its seam already sits at the back: those two cannot change it.
    const changed = moves(r.text) !== plain[key] || def.id === 'holes' || (def.id === 'seam' && o.id === 'back');
    const ok = r.status === 200 && r.text.includes(';LAYER:0') && changed;
    report(ok, `${def.id}=${o.id}`, ok ? `${r.s} s` : `${r.status} ${changed ? '' : '(no change in the moves) '}${r.text.slice(0, 100)}`);
  }
}

const p = await slice(CLASS_DEFAULTS, { settings: {} }, { pauses: [5, 15, 200] });
const m0 = (p.text.match(/^M0 /gm) ?? []).length;
report(p.status === 200 && m0 === 2 && /^5@\d+,15@\d+$/.test(p.done ?? ''), 'pauses at 5 and 15 mm (200 mm is above the model)', `M0 x${m0}, x-pauses-done=${p.done}`);

// A 20 mm brim on a model 8 mm from the bed edge would print past it: refused, never sent.
const edge = await slice({ ...CLASS_DEFAULTS, adhesion: 'brim' }, { settings: { brimWidth: '20' } }, { stl: stlAt(-8, 140) });
report(edge.status === 400 && edge.text.includes('outside'), 'huge brim at the bed edge is refused', `${edge.status} ${edge.text.slice(0, 80)}`);

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exitCode = failed ? 1 : 0;
