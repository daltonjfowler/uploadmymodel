// Read Cura G-code into printed line segments, grouped by line type and layer, for the Preview
// tab. Cura marks layers with ";LAYER:n" and line types with ";TYPE:WALL-OUTER" and so on; only
// moves that push out plastic inside a layer are kept (the start/end sequences and travel moves
// are skipped). Coordinates stay in printer space (front-left corner = 0,0).

// Cura's names → our colour groups. Anything else lands in "other".
export const LINE_TYPES = [
  { id: 'WALL-OUTER', label: 'Outer wall', color: '#e5484d' },
  { id: 'WALL-INNER', label: 'Inner walls', color: '#30a46c' },
  { id: 'SKIN', label: 'Top / bottom', color: '#f5c518' },
  { id: 'FILL', label: 'Infill', color: '#f08c2e' },
  { id: 'SUPPORT', label: 'Supports', color: '#3fb9e0' },
  { id: 'SKIRT', label: 'Skirt / brim', color: '#a78bfa' },
  { id: 'other', label: 'Other', color: '#9aa4af' },
];

const TYPE_INDEX = new Map(LINE_TYPES.map((t, i) => [t.id, i]));
const typeIndex = (name) => {
  if (TYPE_INDEX.has(name)) return TYPE_INDEX.get(name);
  if (name.startsWith('SUPPORT')) return TYPE_INDEX.get('SUPPORT'); // SUPPORT-INTERFACE
  return TYPE_INDEX.get('other');
};

// A Float32Array that grows, so a big file does not build millions of JS numbers first.
class Grow {
  constructor() {
    this.a = new Float32Array(1 << 16);
    this.n = 0;
  }

  push6(a, b, c, d, e, f) {
    if (this.n + 6 > this.a.length) {
      const bigger = new Float32Array(this.a.length * 2);
      bigger.set(this.a);
      this.a = bigger;
    }
    const a0 = this.a;
    const n = this.n;
    a0[n] = a; a0[n + 1] = b; a0[n + 2] = c; a0[n + 3] = d; a0[n + 4] = e; a0[n + 5] = f;
    this.n = n + 6;
  }

  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * @returns {{
 *   types: { segments: Float32Array, layerStart: Uint32Array }[],  // per LINE_TYPES entry
 *   layers: number[],        // z of each layer (mm)
 *   timeS: number | null, filamentM: number | null, layerHeight: number | null, flavor: string | null,
 * }}
 * segments: x1,y1,z1,x2,y2,z2 per printed line. layerStart[i] = first float of layer i (length
 * layers + 1, so the last entry is the total).
 */
export function parseGcode(text) {
  const grows = LINE_TYPES.map(() => new Grow());
  const starts = LINE_TYPES.map(() => []);
  const layers = [];
  let x = 0, y = 0, z = 0, e = 0;
  let absXYZ = true, absE = true;
  let type = -1; // -1 = not in a printed section
  let inLayer = false;
  const info = { timeS: null, filamentM: null, filamentG: null, layerHeight: null, flavor: null };

  let pos = 0;
  const len = text.length;
  while (pos < len) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    let line = text.slice(pos, end);
    pos = end + 1;
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // \r

    if (line.charCodeAt(0) === 59) { // ';' comment line
      if (line.startsWith(';LAYER:')) {
        inLayer = true;
        layers.push(NaN); // set by the layer's first printed line
        for (let t = 0; t < grows.length; t++) starts[t].push(grows[t].n);
      } else if (line.startsWith(';TYPE:')) {
        type = typeIndex(line.slice(6).trim());
      } else if (line.startsWith(';TIME_ELAPSED:')) {
        type = -1; // end of a layer; the next layer names its type again
      } else if (line.startsWith(';TIME:')) {
        info.timeS = Number(line.slice(6)) || null;
      } else if (line.startsWith(';Filament used:')) {
        info.filamentM = parseFloat(line.slice(15)) || null;
      } else if (line.startsWith(';Filament weight = ~')) {
        info.filamentG = parseFloat(line.slice(20)) || null; // Cura LE's own estimate
      } else if (line.startsWith(';Layer height:')) {
        info.layerHeight = parseFloat(line.slice(14)) || null;
      } else if (line.startsWith(';FLAVOR:')) {
        info.flavor = line.slice(8).trim();
      }
      continue;
    }
    const semi = line.indexOf(';');
    if (semi >= 0) line = line.slice(0, semi);
    const c0 = line.charCodeAt(0);
    if (c0 !== 71 && c0 !== 77) continue; // G or M

    const words = line.trim().split(/\s+/);
    const cmd = words[0];
    if (cmd === 'G0' || cmd === 'G1') {
      let nx = x, ny = y, nz = z, ne = e, hasE = false;
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        const v = parseFloat(w.slice(1));
        if (Number.isNaN(v)) continue;
        switch (w.charCodeAt(0)) {
          case 88: nx = absXYZ ? v : x + v; break; // X
          case 89: ny = absXYZ ? v : y + v; break; // Y
          case 90: nz = absXYZ ? v : z + v; break; // Z
          case 69: ne = absE ? v : e + v; hasE = true; break; // E
          default: break;
        }
      }
      if (inLayer && type >= 0 && hasE && ne > e + 1e-6 && (nx !== x || ny !== y)) {
        grows[type].push6(x, y, nz, nx, ny, nz);
        if (Number.isNaN(layers[layers.length - 1])) layers[layers.length - 1] = nz;
      }
      x = nx; y = ny; z = nz; e = ne;
    } else if (cmd === 'G90') absXYZ = true;
    else if (cmd === 'G91') absXYZ = false;
    else if (cmd === 'M82') absE = true;
    else if (cmd === 'M83') absE = false;
    else if (cmd === 'G92') {
      for (let i = 1; i < words.length; i++) {
        const v = parseFloat(words[i].slice(1));
        if (Number.isNaN(v)) continue;
        const k = words[i].charCodeAt(0);
        if (k === 69) e = v;
        else if (k === 88) x = v;
        else if (k === 89) y = v;
        else if (k === 90) z = v;
      }
    } else if (cmd === 'G28') {
      // Homing: position unknown until the next absolute move; nothing is drawn outside layers.
    }
  }

  for (let i = 0; i < layers.length; i++) if (Number.isNaN(layers[i])) layers[i] = i ? layers[i - 1] : 0;
  const types = grows.map((g, t) => {
    const layerStart = new Uint32Array(layers.length + 1);
    starts[t].forEach((v, i) => { layerStart[i] = v; });
    layerStart[layers.length] = g.n;
    return { segments: g.done(), layerStart };
  });
  return { types, layers, ...info };
}

/** 11371 → "3 h 9 min". */
export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '?';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Grams for a length of 2.85 mm filament, when the file does not say. 1.17 g/cm³ is what the
 * school's Cura LE used for PolyLite PLA (20.63 g for 2.76414 m in the golden Benchy).
 */
export function filamentGrams(meters, diameterMm = 2.85) {
  if (!meters) return null;
  const area = Math.PI * (diameterMm / 20) ** 2; // cm²
  return area * meters * 100 * 1.17;
}
