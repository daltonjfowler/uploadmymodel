// What students may change, and what they may not. One file, imported by both the student page
// (web/src/) and the Worker (src/worker.js), so the server checks exactly what the page offers.
//
// Every student setting is a choice from a short list or a stepped slider. There is no free text
// box anywhere: the Worker rejects any value that is not on the list (validateSettings below).
// Temperatures, speeds, cooling, retraction and start/end G-code are not settings at all. They come
// from the class profile on the server (profiles/current_lulzbot_9_18.json) and are only shown,
// greyed out, so students can see what the printer will do.
//
// Values come from Cura LulzBot Edition's own files for the Workhorse SE 0.50 mm + PolyLite PLA
// (resources/quality/taz_workhorse/se/, resources/definitions/lulzbot.def.json), checked against
// the school G-code (docs/HARDWARE.md).

export const PRINTER = {
  name: 'LulzBot TAZ Workhorse',
  toolHead: 'SE 0.50 mm',
  material: 'PolyLite PLA',
  filamentMm: 2.85,
  // Build volume in mm (Cura LE taz.def.json). The bed is drawn centred on 0,0; the slicer
  // later moves the model to printer coordinates (0..280).
  bed: { x: 280, y: 280, z: 285 },
  // Keep models this far from the bed edge. The skirt and the nozzle wipe need room. A guess until
  // checked on the printer; Cura LE uses a few mm of "disallowed" border on the Workhorse.
  edgeMarginMm: 5,
  // Cura's support_angle for LulzBot (lulzbot.def.json): faces leaning past 60° from upright get
  // support. It is the class default; students may change it (SUPPORT_ANGLE below). The page
  // paints faces past the chosen angle red, so "red" means what the slicer will hold up.
  supportAngleDeg: 60,
};

// The three Cura LE quality profiles for this tool head and filament. Picking a layer height picks
// the whole profile, like Cura's Recommended mode: speeds and first layer come with it.
export const QUALITIES = [
  {
    id: 'high_speed',
    curaName: 'High Speed',
    label: 'Fast',
    layerMm: 0.38,
    firstLayerMm: 0.4,
    topBottomMm: 1.4,
    // Nozzle °C from the 4.13.2 PolyLite PLA quality file (engine/res4132, the container's AppImage).
    nozzleC: 215,
    firstLayerNozzleC: 210,
    blurb: 'Thick layers. Prints fastest. You can see the lines.',
  },
  {
    id: 'standard',
    curaName: 'Standard',
    label: 'Standard',
    layerMm: 0.25,
    firstLayerMm: 0.35,
    topBottomMm: 1.25,
    nozzleC: 215,
    firstLayerNozzleC: 210,
    blurb: 'The class setting. Right for most prints: good looks, not too slow.',
  },
  {
    id: 'high_detail',
    curaName: 'High Detail',
    label: 'Fine detail',
    layerMm: 0.18,
    firstLayerMm: 0.35,
    topBottomMm: 1.05,
    nozzleC: 210,
    firstLayerNozzleC: 205,
    blurb: 'Thin layers for small details, like faces or tiny text. Takes much longer.',
  },
];

export const INFILL_PATTERNS = [
  { id: 'grid', label: 'Grid', blurb: 'Criss-cross lines. The class default. Strong and quick.' },
  { id: 'lines', label: 'Lines', blurb: 'Straight lines, turning each layer. Fast, a bit weaker.' },
  { id: 'triangles', label: 'Triangles', blurb: 'Triangles are stiff. Good for parts that get pushed on.' },
  { id: 'trihexagon', label: 'Tri-hexagon', blurb: 'Triangles and hexagons. Strong in every flat direction.' },
  { id: 'cubic', label: 'Cubic', blurb: 'Little tilted cubes stacked up. Strong in every direction.' },
  { id: 'gyroid', label: 'Gyroid', blurb: 'Wavy, like a sponge. Strong every way. Looks cool in the preview.' },
  // Lightning is in the 4.13.2 fdmprinter.def.json too (checked 2026-09-26, docs/ENGINE_OPTIONS.md).
  // Not yet test-printed.
  { id: 'lightning', label: 'Lightning', blurb: 'Tree-like, only holds up the top. Fastest and lightest, but weak.' },
];

export const SUPPORT_CHOICES = [
  { id: 'none', label: 'None', blurb: 'No supports. Fine if nothing hangs out in the air.' },
  { id: 'buildplate', label: 'Touching build plate', blurb: 'Tree supports grow only from the bed. The class default. Easy to snap off.' },
  { id: 'everywhere', label: 'Everywhere', blurb: 'Tree supports can also grow from your model. For tricky shapes. Harder to clean.' },
];

export const ADHESION_CHOICES = [
  { id: 'skirt', label: 'Skirt', blurb: 'A line drawn around your model to get the plastic flowing. The class default.' },
  { id: 'brim', label: 'Brim', blurb: 'A flat rim stuck to the edge of your model, like a hat brim. Helps tall or tiny parts stay down. Peel it off after.' },
  { id: 'raft', label: 'Raft', blurb: 'A thick plastic mat printed under your whole model. Grips best for warped or wobbly bottoms, but uses more plastic and leaves a rougher underside. Peel it off after.' },
  { id: 'none', label: 'None', blurb: 'Nothing extra. The printer starts straight on your model, so the first line may be thin. Only for quick tests.' },
];

// Recommended shows these two as buttons; Custom has all four.
export const SIMPLE_ADHESION = ['skirt', 'brim'];

// Recommended shows these layer heights; Custom has all three (Fine detail is for the few who need it).
export const SIMPLE_QUALITIES = ['high_speed', 'standard'];

export const WALL_CHOICES = [
  { id: 2, label: '2 walls (1.0 mm)', blurb: 'The class default.' },
  { id: 3, label: '3 walls (1.5 mm)', blurb: 'Tougher outside. Takes a little longer.' },
  { id: 4, label: '4 walls (2.0 mm)', blurb: 'Very tough outside, for parts that get screwed or snapped.' },
];

// The class defaults. From the class profile current_lulzbot_9_18 (tree supports touching the
// plate, 20% infill, skirt, 2 walls; grid is Cura LE's LulzBot default pattern), except the layer
// height: LulzBot's Standard profile instead of the class profile's High Detail (Dalton 2026-09-26:
// most prints do not need fine detail).
export const CLASS_DEFAULTS = Object.freeze({
  quality: 'standard',
  infillDensity: 20,
  infillPattern: 'grid',
  walls: 2,
  support: 'buildplate',
  supportAngle: 60,
  adhesion: 'skirt',
});

export const INFILL = { min: 0, max: 100, step: 5 };

// Support overhang angle, measured from straight up. Cura LE warns below 40° (lulzbot.def.json);
// past 80° almost nothing gets support and overhangs droop.
export const SUPPORT_ANGLE = { min: 40, max: 80, step: 5 };

// Tree supports are always hollow: 0% support infill (Dalton's rule, 2026-09-25). Not a setting.
export const TREE_SUPPORT_INFILL = 0;

// Every student setting, in panel order. `section` groups them in Custom mode.
export const SETTINGS = [
  {
    id: 'quality', section: 'quality', label: 'Layer height', kind: 'choice',
    options: QUALITIES.map((q) => ({ id: q.id, label: `${q.layerMm.toFixed(2)} mm · ${q.label}`, blurb: q.blurb })),
    help: 'How thick each layer of plastic is. Thin layers look smoother but take longer.',
  },
  {
    id: 'walls', section: 'walls', label: 'Wall count', kind: 'choice', options: WALL_CHOICES,
    help: 'How many outlines go around the outside of your model. More walls make it stronger.',
  },
  {
    id: 'infillDensity', section: 'infill', label: 'Infill density', kind: 'range', unit: '%', tickStep: 20, ...INFILL,
    help: 'How full the inside is. 0% is hollow, 100% is solid. 15 to 25% is right for most prints.',
  },
  {
    id: 'infillPattern', section: 'infill', label: 'Infill pattern', kind: 'choice', options: INFILL_PATTERNS,
    help: 'The shape printed inside your model.',
  },
  {
    id: 'support', section: 'support', label: 'Tree supports', kind: 'choice', options: SUPPORT_CHOICES,
    help: 'Supports hold up parts that hang in the air, like a chin or an arm. They are shown red on your model.',
  },
  {
    id: 'supportAngle', section: 'support', label: 'Support overhang angle', kind: 'range', unit: '°', tickStep: 10, ...SUPPORT_ANGLE,
    help: 'Parts that lean further than this from straight up get supports. A smaller angle means more supports (safer, more plastic). A bigger angle means fewer supports (faster, but overhangs may droop). Watch the red on your model change.',
  },
  {
    id: 'adhesion', section: 'adhesion', label: 'Build plate adhesion', kind: 'choice', options: ADHESION_CHOICES,
    help: 'Helps the first layer stick to the bed.',
  },
];

export const SECTIONS = [
  { id: 'quality', label: 'Quality', icon: '▤' },
  { id: 'walls', label: 'Walls', icon: '▢' },
  { id: 'infill', label: 'Infill', icon: '▦' },
  { id: 'support', label: 'Support', icon: '⟟' },
  { id: 'adhesion', label: 'Build plate adhesion', icon: '▭' },
];

// Shown greyed out with a lock. Temperatures follow the layer height's Cura quality profile
// (High Detail matches the school G-code, docs/HARDWARE.md). The server never reads these: the
// frozen profile files are the only source.
export function lockedRows(settings) {
  const q = qualityById(settings?.quality);
  return [
  { section: 'Material', rows: [
    ['Filament', 'Polymaker PolyLite PLA, 2.85 mm'],
    ['Nozzle temperature', `${q.nozzleC} °C (${q.firstLayerNozzleC} °C first layer)`],
    ['Bed temperature', '60 °C (65 °C first layer)'],
  ] },
  { section: 'Speed', rows: [
    ['Print speed', 'Set by the layer height you pick'],
    ['First layer', 'Slow, so it sticks'],
  ] },
  { section: 'Cooling', rows: [
    ['Part fan', 'Off on layer 1, full from layer 5'],
  ] },
  { section: 'Printer', rows: [
    ['Start', 'Wipe nozzle, probe bed, prime'],
    ['End', 'Cool bed to 35 °C, present the print'],
  ] },
  ];
}

const byId = (list, id) => list.find((o) => o.id === id);

export function qualityById(id) {
  return byId(QUALITIES, id) ?? byId(QUALITIES, CLASS_DEFAULTS.quality);
}

/**
 * Check a settings object from the browser. Unknown keys are dropped; any known key with a value
 * that is not allowed is an error (never silently fixed, so a bug shows up instead of printing
 * something the student did not pick). Missing keys take the class default.
 * @returns {{ ok: true, settings: object } | { ok: false, errors: string[] }}
 */
export function validateSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['settings must be an object'] };
  }
  const settings = { ...CLASS_DEFAULTS };
  const errors = [];
  for (const def of SETTINGS) {
    if (!(def.id in input)) continue;
    const value = input[def.id];
    if (def.kind === 'choice') {
      const option = def.options.find((o) => o.id === value);
      if (option) settings[def.id] = option.id;
      else errors.push(`${def.id}: not one of the choices`);
    } else if (def.kind === 'range') {
      const okNumber = typeof value === 'number' && Number.isInteger(value);
      if (okNumber && value >= def.min && value <= def.max && (value - def.min) % def.step === 0) {
        settings[def.id] = value;
      } else {
        errors.push(`${def.id}: must be ${def.min} to ${def.max} in steps of ${def.step}`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings };
}

/**
 * The student's choices as Cura setting keys, layered on top of the frozen quality profile by the
 * slicer (Phase 1). Only these keys ever come from the student.
 */
export function toCuraOverrides(settings) {
  const s = { ...CLASS_DEFAULTS, ...settings };
  const supportOn = s.support !== 'none';
  return {
    quality_type: qualityById(s.quality).curaName.toLowerCase(),
    wall_line_count: s.walls,
    infill_sparse_density: s.infillDensity,
    infill_pattern: s.infillPattern,
    support_enable: supportOn,
    support_structure: 'tree',
    support_type: s.support === 'everywhere' ? 'everywhere' : 'buildplate',
    support_infill_rate: TREE_SUPPORT_INFILL,
    support_angle: s.supportAngle,
    adhesion_type: s.adhesion,
  };
}

/** Short summary for the settings header, like Cura's "Fine detail · 20% · Tree · Skirt". */
export function summarize(settings) {
  const s = { ...CLASS_DEFAULTS, ...settings };
  const q = qualityById(s.quality);
  let support = s.support === 'none' ? 'No support' : 'Tree support';
  if (s.support === 'everywhere') support += ' everywhere';
  if (s.support !== 'none' && s.supportAngle !== CLASS_DEFAULTS.supportAngle) support += ` ${s.supportAngle}°`;
  const adhesion = s.adhesion === 'none' ? 'No skirt' : byId(ADHESION_CHOICES, s.adhesion).label;
  return `${q.layerMm.toFixed(2)} mm · ${s.infillDensity}% · ${support} · ${adhesion}`;
}

export function isClassDefault(settings, defaults = CLASS_DEFAULTS) {
  return Object.keys(CLASS_DEFAULTS).every((k) => settings[k] === defaults[k]);
}

// Model limits the Worker enforces before any slicing (PLAN.md §4). Teacher-set later.
export const LIMITS = {
  maxUploadBytes: 40 * 1024 * 1024,
  // For the whole plate. 40 MB of binary STL at 50 bytes per triangle is ~838k; keep under it.
  maxTriangles: 800_000,
  maxObjects: 12,
  maxNameLength: 24,
  // A whole G-code file name, without ".gcode". Short names are easier to find on the printer screen.
  maxFileNameLength: 30,
};

/** Student name → safe file name part: lowercase letters, digits, dashes. */
export function safeNamePart(text, fallback = 'model', max = LIMITS.maxNameLength) {
  const cleaned = String(text ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
  return cleaned || fallback;
}

/**
 * The file name for the SD card. The student's own name for the file if they typed one, else
 * "student-model". Always plain letters, digits and dashes, and it always ends in ".gcode".
 */
export function gcodeFileName(custom, student, model) {
  const own = safeNamePart(String(custom ?? '').replace(/\.gcode$/i, ''), '', LIMITS.maxFileNameLength);
  if (own) return `${own}.gcode`;
  const who = safeNamePart(student, '');
  const what = safeNamePart(model, 'model');
  return `${safeNamePart(`${who ? `${who}-` : ''}${what}`, 'model', LIMITS.maxFileNameLength)}.gcode`;
}

// ---- The teacher's class setup (stored in KV, set on /teacher/) -------------------------------
// The teacher picks which settings students may change and what every setting starts at. A
// setting students may not change is locked to the teacher's value: the page shows it greyed out
// and the Worker refuses a request that changed it.

export const MAX_CLASS_MESSAGE = 160;

// Longest print the teacher allows, in minutes (0 = no limit). A short list, like every setting.
export const PRINT_LIMITS = [0, 30, 45, 60, 90, 120, 180, 240, 300, 480];

export const DEFAULT_CLASS_CONFIG = Object.freeze({
  // Everything open by default, so the site works the same before a teacher ever saves.
  open: Object.freeze(Object.fromEntries(SETTINGS.map((d) => [d.id, true]))),
  defaults: CLASS_DEFAULTS,
  message: '',
  maxPrintMinutes: 0,
});

/** 150 -> "2 h 30 min", 45 -> "45 min". */
export function formatMinutes(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

/**
 * Check a class setup from the teacher page (or from KV). Same rule as student settings: anything
 * off the lists is an error, never fixed up.
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function validateClassConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['must be an object'] };
  const errors = [];
  const open = { ...DEFAULT_CLASS_CONFIG.open };
  if (input.open !== undefined) {
    if (input.open === null || typeof input.open !== 'object' || Array.isArray(input.open)) errors.push('open: must be an object');
    else {
      for (const def of SETTINGS) {
        if (!(def.id in input.open)) continue;
        if (typeof input.open[def.id] === 'boolean') open[def.id] = input.open[def.id];
        else errors.push(`open.${def.id}: must be true or false`);
      }
    }
  }
  let defaults = { ...CLASS_DEFAULTS };
  if (input.defaults !== undefined) {
    const d = validateSettings(input.defaults);
    if (d.ok) defaults = d.settings;
    else errors.push(...d.errors.map((e) => `defaults.${e}`));
  }
  let message = '';
  if (input.message !== undefined) {
    if (typeof input.message !== 'string') errors.push('message: must be text');
    else message = input.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (message.length > MAX_CLASS_MESSAGE) errors.push(`message: at most ${MAX_CLASS_MESSAGE} characters`);
  }
  let maxPrintMinutes = 0;
  if (input.maxPrintMinutes !== undefined) {
    if (PRINT_LIMITS.includes(input.maxPrintMinutes)) maxPrintMinutes = input.maxPrintMinutes;
    else errors.push('maxPrintMinutes: not one of the choices');
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: { open, defaults, message, maxPrintMinutes } };
}

/** Student settings checked against the class setup: locked settings must equal the teacher's. */
export function checkAgainstClass(settings, config) {
  const locked = SETTINGS.filter((d) => !config.open[d.id] && settings[d.id] !== config.defaults[d.id]);
  return locked.map((d) => d.label);
}

/** A student's saved settings, with every locked setting put back to the teacher's value. */
export function applyClassLocks(settings, config) {
  const out = { ...config.defaults, ...settings };
  for (const d of SETTINGS) if (!config.open[d.id]) out[d.id] = config.defaults[d.id];
  return out;
}
