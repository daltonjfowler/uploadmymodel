// Turn a dropped file into one flat list of triangle corners (x, y, z, x, y, z, ...) in mm.
// Everything is read in the browser; nothing is uploaded until the student presses Slice.

import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

// .gcode opens in the Preview tab instead of on the plate (main.js handles it).
export const ACCEPT = '.stl,.obj,.3mf,.gcode';

export class LoadError extends Error {}

// 3MF units (3MF core spec) in mm.
const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** The unit named on the 3MF's <model> element ("millimeter" when missing). */
export function threeMfUnit(data) {
  try {
    const files = unzipSync(new Uint8Array(data), { filter: (f) => /\.model$/i.test(f.name) });
    for (const bytes of Object.values(files)) {
      const head = new TextDecoder().decode(bytes.subarray(0, 4096));
      const m = /<model\b[^>]*\bunit\s*=\s*["']([a-z]+)["']/i.exec(head);
      if (m) return m[1].toLowerCase();
    }
  } catch { /* not a zip: the 3MF loader reports it */ }
  return 'millimeter';
}

function extension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

/** File name without the extension, for the object list and the G-code file name. */
export function baseName(name) {
  return name.replace(/\.[a-z0-9]+$/i, '') || 'model';
}

// Collect every mesh in a three.js object tree into one triangle soup, with each mesh's own
// placement applied. Indexed geometry is unrolled so every 9 numbers are one triangle.
function flatten(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  let total = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry?.attributes?.position) return;
    let g = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    g.applyMatrix4(obj.matrixWorld);
    const arr = g.attributes.position.array;
    const usable = arr.length - (arr.length % 9);
    parts.push(arr.subarray(0, usable));
    total += usable;
    g.dispose();
  });
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function checkNumbers(positions) {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new LoadError('This file has broken numbers in it. Try exporting it again.');
  }
}

/** @returns {Promise<{ name: string, positions: Float32Array }>} */
export async function loadModelFile(file) {
  const ext = extension(file.name);
  let positions;
  try {
    if (ext === 'stl') {
      const geo = new STLLoader().parse(await file.arrayBuffer());
      positions = geo.index ? geo.toNonIndexed().attributes.position.array : geo.attributes.position.array;
    } else if (ext === 'obj') {
      positions = flatten(new OBJLoader().parse(await file.text()));
    } else if (ext === '3mf') {
      // 3MF is Z-up like the printer and our world, so no turning needed. three's loader ignores
      // the file's unit, so scale to mm here.
      const data = await file.arrayBuffer();
      positions = flatten(new ThreeMFLoader().parse(data));
      const k = UNIT_MM[threeMfUnit(data)] ?? 1;
      if (k !== 1) for (let i = 0; i < positions.length; i++) positions[i] *= k;
    } else {
      throw new LoadError(`uploadmymodel opens STL, OBJ and 3MF files. "${file.name}" is not one of those.`);
    }
  } catch (err) {
    if (err instanceof LoadError) throw err;
    console.error(err);
    throw new LoadError(`Could not read "${file.name}". It might be damaged. Try exporting it again.`);
  }
  if (!positions || positions.length < 9) throw new LoadError(`"${file.name}" has no shape in it.`);
  const out = positions instanceof Float32Array ? positions : new Float32Array(positions);
  checkNumbers(out);
  return { name: baseName(file.name), positions: out };
}

// ---- Sample model ---------------------------------------------------------------------------
// A little test piece: a base, a tower, and an arm sticking out. The underside of the arm shows up
// red, which is the quickest way to explain supports.

function box(out, x0, y0, z0, x1, y1, z1) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], // bottom, top
    [0, 1, 5, 4], [2, 3, 7, 6], // front, back
    [1, 2, 6, 5], [3, 0, 4, 7], // right, left
  ];
  for (const [a, b, c, d] of quads) out.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
}

export function sampleModel() {
  const t = [];
  box(t, -20, -12, 0, 20, 12, 5); // base
  box(t, -20, -8, 5, -6, 8, 40); // tower
  box(t, -6, -8, 30, 22, 8, 38); // arm: its underside hangs in the air
  return { name: 'support-test', positions: new Float32Array(t) };
}
