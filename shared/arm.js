// "Assistant to the Regional Manager": the third settings tab (Recommended | Custom | this).
// Many more Cura settings for the curious, behind a password (the ARM_KEY Worker secret, never in
// this public repo). Same rule as shared/settings.js: every value is a choice from a list, checked
// here, in the Worker AND in the slicer container (container/server.py ARM_VALUES). Never
// temperatures, speeds, flow, cooling, retraction, travel, acceleration, print sequence or
// start/end G-code: nothing here can hurt the printer. The slicer also refuses any file that moves
// outside the build volume, so a wide brim or a mold near the edge cannot drive the head into the
// frame. Every setting starts at 'profile' (= not sent: the LulzBot profile decides).

export const ARM_LABEL = 'Assistant to the Regional Manager';

const onOff = (on, off) => [
  { id: 'profile', label: 'Off', value: null, blurb: off },
  { id: 'on', label: 'On', value: true, blurb: on },
];
const opt = (id, label, value, blurb) => ({ id, label, value, blurb });
const profile = (label) => ({ id: 'profile', label, value: null, blurb: 'What the LulzBot profile does.' });

// The tab is Custom plus more: every Custom section with its extra rows added (`section` = a
// shared/settings.js SECTIONS id), then these sections only this tab has.
export const ARM_SECTIONS = [
  { id: 'pauses', label: 'Colour change pauses', icon: '🎨', first: true },
  { id: 'surface', label: 'Top surface', icon: '✨' },
  { id: 'special', label: 'Special modes', icon: '🏺' },
];

export const ARM_SETTINGS = [
  { id: 'fuzzy', section: 'walls', label: 'Fuzzy skin', cura: 'magic_fuzzy_skin_enabled',
    options: onOff('The outside wall jiggles randomly: your print looks furry, or like rough stone.', 'Smooth walls.'),
    help: 'Makes the outside of your print rough and textured on purpose. Great for animals, rocks and monsters.' },
  { id: 'fuzzyAmount', section: 'walls', label: 'Fuzz amount', cura: 'magic_fuzzy_skin_thickness', needs: { fuzzy: 'on' },
    options: [profile('Normal (0.3 mm)'), opt('subtle', 'Subtle (0.15 mm)', 0.15, 'A light texture.'), opt('wild', 'Wild (0.5 mm)', 0.5, 'Very rough. Like a hairy monster.')],
    help: 'How far the fuzzy wall wiggles in and out.' },
  { id: 'ironing', section: 'surface', label: 'Ironing', cura: 'ironing_enabled',
    options: onOff('After the top layer, the hot nozzle glides over it again, barely pushing plastic, to make it smooth and shiny.', 'Normal top layer.'),
    help: 'Smooths flat tops, like ironing a shirt. Takes a bit longer.' },
  { id: 'ironTopOnly', section: 'surface', label: 'Iron only the very top', cura: 'ironing_only_highest_layer', needs: { ironing: 'on' },
    options: onOff('Only the highest flat surface gets ironed. Faster.', 'Every flat top gets ironed.'),
    help: 'Iron just the top of the whole print, or every flat top.' },
  { id: 'topPattern', section: 'surface', label: 'Top and bottom pattern', cura: 'top_bottom_pattern',
    options: [profile('Lines'), opt('concentric', 'Circles in circles', 'concentric', 'Rings that follow the outline. Pretty on round tops.'), opt('zigzag', 'Zigzag', 'zigzag', 'One long wiggly line.')],
    help: 'The pattern of the solid layers you can see on the top and bottom.' },
  { id: 'monotonic', section: 'surface', label: 'Neat top lines', cura: 'skin_monotonic',
    options: onOff('Top lines are all printed in the same direction, so the surface shines evenly.', 'Normal order.'),
    help: 'Called "monotonic" in Cura. Makes shiny tops look more even.' },
  { id: 'seam', section: 'walls', label: 'Seam position', cura: 'z_seam_type',
    options: [profile('Sharpest corner'), opt('back', 'At the back', 'back', 'The little bump where each layer starts goes at the back.'),
      opt('random', 'Random', 'random', 'Spread everywhere: no line, but tiny dots all over.'), opt('shortest', 'Shortest path', 'shortest', 'Fastest: the seam goes wherever is quickest.')],
    help: 'Every layer starts and ends somewhere, leaving a tiny bump. This picks where.' },
  { id: 'adaptive', section: 'quality', label: 'Adaptive layers', cura: 'adaptive_layer_height_enabled',
    options: onOff('Thinner layers on curvy parts, thicker on straight parts. Smooth and still quick.', 'Every layer the same height.'),
    help: 'Lets the slicer change the layer height as it goes up your model.' },

  { id: 'holes', section: 'walls', label: 'Hole size', cura: 'hole_xy_offset',
    options: [profile('As drawn'), opt('bigger', 'A bit bigger (+0.2 mm)', 0.2, 'Holes print a little bigger, so pins and screws fit.'),
      opt('bigger2', 'Bigger (+0.4 mm)', 0.4, 'For a loose fit.'), opt('smaller', 'A bit smaller (-0.2 mm)', -0.2, 'For a tight fit.')],
    help: 'Printed holes often come out a little small. This fixes it.' },
  { id: 'grow', section: 'walls', label: 'Outside size', cura: 'xy_offset',
    options: [profile('As drawn'), opt('plus', 'A bit bigger (+0.1 mm)', 0.1, 'The whole outline grows a little.'),
      opt('minus', 'A bit smaller (-0.1 mm)', -0.1, 'The whole outline shrinks a little. Good for parts that must slide into something.')],
    help: 'Grows or shrinks the outside of every layer by a tiny amount, for parts that fit together.' },
  { id: 'moreWalls', section: 'walls', label: 'More wall choices', cura: 'wall_line_count', overrides: 'walls', merged: true,
    options: [profile("Use Custom's wall count"), opt('1', '1 wall (0.5 mm)', 1, 'Super thin, and see-through when lit. Fragile!'),
      opt('5', '5 walls (2.5 mm)', 5, 'Tough.'), opt('6', '6 walls (3.0 mm)', 6, 'Tank mode.')],
    help: 'Wall counts that Custom does not offer.' },
  // The LulzBot quality files set top_thickness / bottom_thickness themselves, so set both (the
  // parent top_bottom_thickness would be ignored).
  { id: 'thickTops', section: 'quality', label: 'Top and bottom thickness', cura: ['top_thickness', 'bottom_thickness'],
    options: [profile('From the layer height'), opt('thin', 'Thin (0.8 mm)', 0.8, 'Less plastic. Tops may show the infill.'),
      opt('thick', 'Thick (2.0 mm)', 2, 'Strong, smooth tops.'), opt('extra', 'Extra thick (3.0 mm)', 3, 'Very strong tops and bottoms.')],
    help: 'How thick the solid top and bottom skins are.' },

  { id: 'morePatterns', section: 'infill', label: 'More infill patterns', cura: 'infill_pattern', overrides: 'infillPattern', merged: true,
    options: [profile("Use Custom's pattern"), opt('concentric', 'Concentric', 'concentric', 'Rings inside rings. Bendy!'),
      opt('zigzag', 'Zigzag', 'zigzag', 'One wiggly line per layer.'),
      opt('cross', 'Cross', 'cross', 'Squishy crosses. Makes bendy, soft prints.'),
      opt('cross_3d', 'Cross 3D', 'cross_3d', 'Crosses that change as they go up. Squishy in every direction.'),
      opt('quarter_cubic', 'Quarter cubic', 'quarter_cubic', 'Tilted cubes, a bit different from Cubic.'),
      opt('tetrahedral', 'Octet', 'tetrahedral', 'Pyramids and diamonds. Very strong.'),
      opt('cubicsubdiv', 'Cubic subdivision', 'cubicsubdiv', 'Big cubes in the middle, small ones near the walls. Saves plastic.')],
    help: 'Extra shapes for the inside of your print. Look at them in the Preview tab!' },
  { id: 'gradual', section: 'infill', label: 'Gradual infill', cura: 'gradual_infill_steps',
    options: [profile('Off'), opt('2', '2 steps', 2, 'Sparse at the bottom, denser near the top.'), opt('4', '4 steps', 4, 'Even more steps. Saves lots of plastic.')],
    help: 'Uses less infill low down and more just under the top, where it holds the top up.' },

  { id: 'vase', section: 'special', label: 'Vase mode', cura: 'magic_spiralize',
    options: onOff('One single wall that spirals up without stopping. No top, no infill: perfect vases and cups.', 'Normal print.'),
    help: 'Called "spiralize" in Cura. Only for simple shapes, and the model must be one piece.' },
  { id: 'mold', section: 'special', label: 'Mold maker', cura: 'mold_enabled',
    options: onOff('Prints a mold around your model instead of the model. Fill it with clay, plaster or chocolate!', 'Print the model itself.'),
    help: 'Turns your model into the hole inside a block. Ask your teacher what you can pour into it.' },
  { id: 'conical', section: 'special', label: 'Make overhangs printable', cura: 'conical_overhang_enabled',
    options: onOff('Changes your model so nothing hangs out too far: overhangs become slopes. Needs fewer supports.', 'Keep the shape exactly.'),
    help: 'An experimental Cura trick. Your print will not be exactly the shape you drew.' },

  { id: 'branchAngle', section: 'support', label: 'Branch angle', cura: 'support_tree_angle',
    options: [profile('Normal (40°)'), opt('upright', 'Upright (25°)', 25, 'Branches go more straight up. Sturdier.'), opt('wide', 'Wide (55°)', 55, 'Branches lean far out to reach. Uses less plastic.')],
    help: 'How far tree branches may lean while they grow. Only matters with supports on.' },
  { id: 'branchSize', section: 'support', label: 'Branch thickness', cura: 'support_tree_branch_diameter',
    options: [profile('Normal (2 mm)'), opt('thin', 'Thin (1.5 mm)', 1.5, 'Easy to snap off.'), opt('thick', 'Thick (3 mm)', 3, 'Stronger, for heavy parts.')],
    help: 'How thick the thinnest tree branches are. Only matters with supports on.' },
  // (Support brim is not here: the LulzBot profile already has it on.)

  // LulzBot sets the brim as a line count (0.5 mm lines), which wins over brim_width.
  { id: 'brimWidth', section: 'adhesion', label: 'Brim width', cura: 'brim_line_count', needsBase: { adhesion: 'brim' },
    options: [profile('Normal (5 mm, 10 lines)'), opt('4', 'Narrow (4 mm)', 8, 'Easy to peel.'), opt('12', 'Wide (12 mm)', 24, 'Holds better.'),
      opt('20', 'Huge (20 mm)', 40, 'For warping or tiny feet. Keep your model away from the edge of the bed.')],
    help: 'Only with a Brim (pick Brim in Recommended or Custom).' },
  { id: 'skirtLines', section: 'adhesion', label: 'Skirt lines', cura: 'skirt_line_count', needsBase: { adhesion: 'skirt' },
    options: [profile('2 lines'), opt('1', '1 line', 1, 'Just one loop.'), opt('3', '3 lines', 3, 'More plastic flowing before your print starts.'),
      opt('5', '5 lines', 5, 'Lots of priming. Good after a filament change.')],
    help: 'Only with a Skirt (the class default).' },
];

// Pauses for a filament (colour) change (container/pause.py: Cura LE's own Marlin "Pause at height").
export const ARM_PAUSES = { count: 3, minMm: 0.5, maxMm: 280, stepMm: 0.05 };

const armDef = (id) => ARM_SETTINGS.find((d) => d.id === id);
/** The Cura key(s) one ARM setting writes (a few set two, like top + bottom thickness). */
export const curaKeys = (def) => [def.cura].flat();

/**
 * Check the ARM part of a slice from the browser: { settings: { id: optionId }, pauses: [mm] }.
 * Settings left out, or at 'profile', are not sent to the slicer.
 * @returns {{ ok: true, arm: { settings: object, pauses: number[] } } | { ok: false, errors: string[] }}
 */
export function validateArm(input) {
  if (input == null) return { ok: true, arm: { settings: {}, pauses: [] } };
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['arm must be an object'] };
  const errors = [];
  const settings = {};
  const raw = input.settings ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) errors.push('arm.settings must be an object');
  else {
    for (const [id, value] of Object.entries(raw)) {
      const def = armDef(id);
      if (!def) { errors.push(`arm.${id}: not a setting`); continue; }
      const o = def.options.find((x) => x.id === value);
      if (!o) { errors.push(`arm.${id}: not one of the choices`); continue; }
      if (o.id !== 'profile') settings[id] = o.id;
    }
  }
  const pauses = [];
  const p = input.pauses ?? [];
  if (!Array.isArray(p) || p.length > ARM_PAUSES.count) errors.push(`arm.pauses: at most ${ARM_PAUSES.count}`);
  else {
    for (const h of p) {
      const steps = h / ARM_PAUSES.stepMm;
      const ok = typeof h === 'number' && Number.isFinite(h) && h >= ARM_PAUSES.minMm && h <= ARM_PAUSES.maxMm
        && Math.abs(Math.round(steps) - steps) < 1e-6;
      if (ok) pauses.push(Math.round(h * 100) / 100);
      else errors.push(`arm.pauses: heights from ${ARM_PAUSES.minMm} to ${ARM_PAUSES.maxMm} mm in steps of ${ARM_PAUSES.stepMm}`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, arm: { settings, pauses: [...new Set(pauses)].sort((a, b) => a - b) } };
}

/** Does this ARM part change anything (and so need the password)? */
export function armIsUsed(arm) {
  return !!arm && (Object.keys(arm.settings ?? {}).length > 0 || (arm.pauses ?? []).length > 0);
}

/** The ARM settings that apply with these base settings: one whose `needs` are not met is left out. */
export function activeArm(arm, base) {
  const s = arm?.settings ?? {};
  const out = {};
  for (const def of ARM_SETTINGS) {
    const v = s[def.id];
    if (!v || v === 'profile') continue;
    if (def.needs && Object.entries(def.needs).some(([k, want]) => s[k] !== want)) continue;
    if (def.needsBase && Object.entries(def.needsBase).some(([k, want]) => base?.[k] !== want)) continue;
    out[def.id] = v;
  }
  return out;
}

/** ARM choices as Cura keys, laid over toCuraOverrides(). */
export function toArmOverrides(arm, base) {
  const out = {};
  for (const [id, v] of Object.entries(activeArm(arm, base))) {
    const def = armDef(id);
    for (const key of curaKeys(def)) out[key] = def.options.find((o) => o.id === v).value;
  }
  return out;
}

/** Labels of ARM choices that replace a base setting the teacher locked (the Worker refuses those). */
export function armAgainstClass(arm, base, config) {
  return Object.keys(activeArm(arm, base))
    .map(armDef)
    .filter((d) => d.overrides && config?.open && !config.open[d.overrides])
    .map((d) => d.label);
}

/** { curaKey: [allowed values] } for the slicer's own check (container/arm_values.json). */
export function armValues() {
  const out = {};
  for (const d of ARM_SETTINGS) {
    for (const key of curaKeys(d)) {
      out[key] = [...new Set([...(out[key] ?? []), ...d.options.filter((o) => o.value !== null).map((o) => o.value)])];
    }
  }
  return out;
}

/** Short words for the settings header, e.g. "Fuzzy skin · Ironing · 2 pauses". */
export function summarizeArm(arm, base) {
  const on = Object.keys(activeArm(arm, base)).map((id) => armDef(id).label);
  const n = arm?.pauses?.length ?? 0;
  if (n) on.push(`${n} pause${n === 1 ? '' : 's'}`);
  return on.join(' · ');
}
