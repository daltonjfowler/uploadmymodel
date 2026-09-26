// The "Print settings" card, top right, shaped like Cura's: a header with a one-line summary,
// then Recommended (four big controls) or Custom (every student setting, grouped, plus the
// teacher's locked settings greyed out). Both tabs edit the same settings object.

import {
  ADHESION_CHOICES, DEFAULT_CLASS_CONFIG, INFILL_PATTERNS, QUALITIES, SECTIONS, SETTINGS, SIMPLE_ADHESION, SIMPLE_QUALITIES, lockedRows,
  SUPPORT_CHOICES, TREE_SUPPORT_INFILL, applyClassLocks, isClassDefault, qualityById, summarize,
  validateClassConfig, validateSettings,
} from '../../shared/settings.js';
import { el, esc } from './dom.js';
import { patternIcon } from './pattern-icons.js';

// Only the settings the student changed are stored, so everything else follows the teacher's
// class defaults, even when the teacher changes them later.
const STORE_SETTINGS = 'umm.mySettings';
const STORE_MODE = 'umm.settingsMode';
const STORE_OPEN = 'umm.settingsOpen';
// Support advice thresholds, mm² of red (faces needing support) on the plate: under `none` counts
// as nothing (specks), under `tiny` prints fine without supports (a small tip, the top of a hole),
// from `lots` on, turning the model is worth a try.
const SUPPORT_RED = { none: 5, tiny: 25, lots: 1500 };

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: settings still work for this visit */ }
}

// What the infill number means, in plain words.
function infillWords(v) {
  if (v === 0) return 'Hollow: only walls, top and bottom. Weak.';
  if (v <= 10) return 'Very light. Good for display pieces.';
  if (v <= 25) return 'Normal. Right for most prints.';
  if (v <= 50) return 'Strong. Uses more plastic and time.';
  if (v < 100) return 'Very strong and heavy. Slow.';
  return 'Solid plastic. Heaviest and slowest.';
}

function angleWords(v) {
  if (v <= 45) return 'Lots of support. Even gentle slopes get held up. Uses more plastic.';
  if (v <= 55) return 'More support than normal. Better for tricky models.';
  if (v === 60) return "LulzBot's default. Right for most models.";
  if (v <= 70) return 'Less support. Steep slopes print on their own but may droop a little.';
  return 'Very little support. Only nearly flat overhangs get held up. Expect droop.';
}

const WORDS = { infillDensity: infillWords, supportAngle: angleWords };
const defOf = (id) => SETTINGS.find((d) => d.id === id);

/** A setting's value in words, e.g. "0.18 mm · Fine detail" or "20%". */
export function valueText(id, value) {
  const def = defOf(id);
  if (def.kind === 'range') return `${value}${def.unit}`;
  return def.options.find((o) => o.id === value)?.label ?? String(value);
}

export class SettingsPanel extends EventTarget {
  constructor(root, hint) {
    super();
    this.root = root;
    this.hint = hint;
    // The teacher's class setup; replaced by setClassConfig() once /api/class answers.
    this.config = DEFAULT_CLASS_CONFIG;
    const raw = load(STORE_SETTINGS, {});
    const stored = validateSettings(raw);
    // Keep only keys that were really stored (validateSettings fills the rest with defaults).
    this.mine = stored.ok ? Object.fromEntries(Object.keys(raw).filter((k) => k in stored.settings).map((k) => [k, stored.settings[k]])) : {};
    this.settings = applyClassLocks({ ...this.config.defaults, ...this.mine }, this.config);
    if (this.settings.support !== 'none') this.lastPlacement = this.settings.support;
    this.mode = load(STORE_MODE, 'recommended') === 'custom' ? 'custom' : 'recommended';
    this.open = load(STORE_OPEN, true) !== false;
    this.openSections = new Set(['quality', 'infill', 'support']);
    this.overhangs = 0; // mm² of red faces on the plate, from the viewer
    this.hasModels = false;
    this.render();
  }

  get value() {
    return { ...this.settings };
  }

  set(id, value) {
    if (this.settings[id] === value) return;
    this.settings = { ...this.settings, [id]: value };
    // Back at the class default = not the student's own choice any more.
    if (value === this.config.defaults[id]) delete this.mine[id];
    else this.mine[id] = value;
    if (id === 'support' && value !== 'none') this.lastPlacement = value;
    save(STORE_SETTINGS, this.mine);
    this.render();
    this.dispatchEvent(new Event('change'));
  }

  /** The teacher's class setup: locked settings snap to the teacher's value. */
  setClassConfig(input) {
    const v = validateClassConfig(input);
    if (!v.ok) return;
    this.config = v.config;
    const before = JSON.stringify(this.settings);
    this.settings = applyClassLocks({ ...this.config.defaults, ...this.mine }, this.config);
    if (this.settings.support !== 'none') this.lastPlacement = this.settings.support;
    this.render();
    if (JSON.stringify(this.settings) !== before) this.dispatchEvent(new Event('change'));
  }

  isLocked(id) {
    return !this.config.open[id];
  }

  // One greyed-out line for a setting the teacher locked.
  lockedLine(id) {
    const def = defOf(id);
    const r = el('div', { class: 'locked-line' });
    r.innerHTML = `<span>🔒 ${esc(def.label)}</span><strong>${esc(valueText(id, this.settings[id]))}</strong>`;
    this.hintOn(r, def.label, `Your teacher set this for the class. ${def.help}`);
    return r;
  }

  reset() {
    this.settings = { ...this.config.defaults };
    this.mine = {};
    save(STORE_SETTINGS, this.mine);
    this.render();
    this.dispatchEvent(new Event('change'));
  }

  /**
   * The viewer tells us how much of the plate hangs in the air (mm² of red), and how much of that
   * is over the model rather than over the bed (overModel; null = not worked out yet), for the
   * support advice. Only re-renders when the advice would change.
   */
  setPlateInfo(info) {
    const was = this.adviceKind();
    if ('overhangs' in info) this.overhangs = info.overhangs;
    if ('overModel' in info) this.overModel = info.overModel;
    if ('hasModels' in info) this.hasModels = info.hasModels;
    if (was !== this.adviceKind()) this.render();
  }

  // ---- Rendering ----------------------------------------------------------------------------

  render() {
    const scroll = this.root.querySelector('.settings-body')?.scrollTop ?? 0;
    // Re-rendering replaces every control; give focus back to the same one afterwards, or the
    // next arrow key would go to the page (and move the model) instead of the slider.
    const active = this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active ? `${active.tagName}|${active.getAttribute('aria-label') ?? active.textContent.trim()}` : null;
    const changed = !isClassDefault(this.settings, this.config.defaults);
    this.root.classList.toggle('collapsed', !this.open);
    clearTimeout(this.hintTimer);
    this.hint.hidden = true; // its target is about to be replaced
    this.root.innerHTML = '';

    const header = el('button', { class: 'settings-head', type: 'button', 'aria-expanded': String(this.open) });
    header.innerHTML = `
      <span class="settings-icon" aria-hidden="true">⚙</span>
      <span class="settings-title">
        <strong>Print settings</strong>
        <span class="settings-summary">${esc(summarize(this.settings))}</span>
      </span>
      <span class="profile-tag ${changed ? 'changed' : ''}">${changed ? 'Changed' : 'Class settings'}</span>
      <span class="chev" aria-hidden="true">${this.open ? '▴' : '▾'}</span>`;
    header.addEventListener('click', () => {
      this.open = !this.open;
      save(STORE_OPEN, this.open);
      this.render();
    });
    this.root.append(header);
    if (!this.open) return;

    const tabs = el('div', { class: 'seg tabs', role: 'tablist' });
    for (const [id, label] of [['recommended', 'Recommended'], ['custom', 'Custom']]) {
      const b = el('button', { type: 'button', role: 'tab', class: this.mode === id ? 'on' : '', 'aria-selected': String(this.mode === id) }, label);
      b.addEventListener('click', () => {
        this.mode = id;
        save(STORE_MODE, id);
        this.render();
      });
      tabs.append(b);
    }
    this.root.append(tabs);

    const body = el('div', { class: 'settings-body' });
    if (this.config.message) {
      const note = el('p', { class: 'class-note' });
      note.append(el('strong', {}, 'From your teacher: '), document.createTextNode(this.config.message));
      body.append(note);
    }
    if (this.mode === 'recommended') this.renderRecommended(body);
    else this.renderCustom(body);
    this.root.append(body);

    const foot = el('div', { class: 'settings-foot' });
    const reset = el('button', { type: 'button', class: 'linkbtn', disabled: changed ? null : '' }, '↺ Back to class settings');
    reset.addEventListener('click', () => this.reset());
    foot.append(reset);
    this.root.append(foot);
    body.scrollTop = scroll;
    if (focusKey) {
      const again = [...this.root.querySelectorAll('button, input, select')]
        .find((n) => `${n.tagName}|${n.getAttribute('aria-label') ?? n.textContent.trim()}` === focusKey);
      again?.focus({ preventScroll: true });
    }
  }

  renderRecommended(body) {
    const s = this.settings;
    const q = qualityById(s.quality);

    // Print quality: big buttons, like picking a Cura profile. Fast and Standard here; Fine detail
    // lives in Custom (if a student picked it there, it shows here too).
    const quality = this.block(body, 'Print quality', defOf('quality'));
    if (this.isLocked('quality')) quality.append(this.lockedLine('quality'));
    const seg = el('div', { class: 'seg quality' });
    for (const opt of QUALITIES.filter((o) => SIMPLE_QUALITIES.includes(o.id) || o.id === s.quality)) {
      const b = el('button', { type: 'button', class: s.quality === opt.id ? 'on' : '' });
      b.innerHTML = `<strong>${esc(opt.label)}</strong><small>${opt.layerMm.toFixed(2)} mm</small>`;
      b.addEventListener('click', () => this.set('quality', opt.id));
      this.hintOn(b, opt.label, `${opt.layerMm.toFixed(2)} mm layers. ${opt.blurb}`);
      seg.append(b);
    }
    if (!this.isLocked('quality')) quality.append(seg, el('p', { class: 'note' }, q.blurb));

    // Infill slider.
    const infill = this.block(body, 'Infill', defOf('infillDensity'));
    infill.append(this.isLocked('infillDensity') ? this.lockedLine('infillDensity') : this.rangeSlider('infillDensity'));

    // Supports: on/off, then where they may grow and from what angle.
    const support = this.block(body, 'Support', defOf('support'));
    support.append(this.isLocked('support') ? this.lockedLine('support') : this.supportToggle());
    // Right under the switch, so it is seen without scrolling: do I need supports?
    const advice = this.supportAdvice();
    if (advice) support.append(advice);
    if (s.support !== 'none') {
      if (!this.isLocked('support')) support.append(this.placementPicker());
      if (this.isLocked('supportAngle')) support.append(this.lockedLine('supportAngle'));
      else {
        const angle = el('div', { class: 'sub-setting' });
        angle.append(el('span', { class: 'sub-label' }, 'Support overhang angle'));
        angle.append(this.rangeSlider('supportAngle', true));
        this.hintOn(angle, defOf('supportAngle').label, defOf('supportAngle').help);
        support.append(angle);
      }
    }

    // Adhesion: Skirt | Brim (Raft and None live in Custom; if one is picked there, it shows here too).
    const adhesion = this.block(body, 'Adhesion', defOf('adhesion'));
    if (this.isLocked('adhesion')) adhesion.append(this.lockedLine('adhesion'));
    else {
      adhesion.append(this.adhesionPicker(SIMPLE_ADHESION.includes(s.adhesion) ? SIMPLE_ADHESION : [...SIMPLE_ADHESION, s.adhesion]));
      adhesion.append(el('p', { class: 'note' }, ADHESION_CHOICES.find((a) => a.id === s.adhesion)?.blurb ?? ''));
    }
  }

  renderCustom(body) {
    const s = this.settings;
    for (const sec of SECTIONS) {
      const open = this.openSections.has(sec.id);
      const wrap = el('section', { class: `cat ${open ? 'open' : ''}` });
      const head = el('button', { type: 'button', class: 'cat-head', 'aria-expanded': String(open) });
      head.innerHTML = `<span class="cat-icon" aria-hidden="true">${sec.icon}</span><span>${esc(sec.label)}</span><span class="chev" aria-hidden="true">${open ? '▴' : '▾'}</span>`;
      head.addEventListener('click', () => {
        if (open) this.openSections.delete(sec.id);
        else this.openSections.add(sec.id);
        this.render();
      });
      wrap.append(head);
      if (open) {
        const rows = el('div', { class: 'cat-rows' });
        if (sec.id === 'support') this.supportRows(rows, s);
        else for (const def of SETTINGS.filter((d) => d.section === sec.id)) rows.append(this.customRow(def));
        this.extraRows(sec.id, rows, s);
        wrap.append(rows);
      }
      body.append(wrap);
    }

    // Teacher-locked settings, shown so students can see (and learn) what the printer will do.
    const locked = el('section', { class: 'cat locked open' });
    locked.innerHTML = `<div class="cat-head static"><span class="cat-icon" aria-hidden="true">🔒</span><span>Set by your teacher</span></div>`;
    const rows = el('div', { class: 'cat-rows' });
    for (const group of lockedRows(this.settings)) {
      rows.append(el('div', { class: 'row-group' }, group.section));
      for (const [label, value] of group.rows) {
        const r = el('div', { class: 'row lockedrow' });
        r.innerHTML = `<span class="row-label">${esc(label)}</span><span class="row-value">${esc(value)}</span>`;
        this.hintOn(r, label, `${value}. This comes from the class printer profile, so every print on these printers works the same way. Ask your teacher if you think it needs to change.`);
        rows.append(r);
      }
    }
    locked.append(rows);
    body.append(locked);
  }

  extraRows(section, rows, s) {
    if (section === 'quality') {
      const q = qualityById(s.quality);
      rows.append(this.infoRow('First layer height', `${q.firstLayerMm.toFixed(2)} mm`, 'The first layer is thicker so it sticks to the bed. Comes with the layer height you pick.'));
      rows.append(this.infoRow('Top/bottom thickness', `${q.topBottomMm.toFixed(2)} mm`, 'How thick the solid top and bottom skins are. Comes with the layer height you pick.'));
    }
    if (section === 'support') {
      rows.append(this.infoRow('Support structure', 'Tree', 'Tree supports grow like branches and touch your model only in small spots, so they snap off cleanly.', true));
      rows.append(this.infoRow('Support infill', `${TREE_SUPPORT_INFILL}%`, 'Tree branches are always hollow (0% infill). They use less plastic and break away easily.', true));
      const advice = this.supportAdvice();
      if (advice) rows.append(advice);
    }
  }

  // Custom mode's Support section, laid out like Cura's: the switch, then the settings that only
  // matter when supports are on.
  supportRows(rows, s) {
    if (this.isLocked('support')) {
      rows.append(this.customRow(defOf('support')));
    } else {
      const on = el('div', { class: 'row' });
      on.append(el('span', { class: 'row-label' }, 'Generate support'), this.supportToggle('', 'Generate support'));
      this.hintOn(on, 'Generate support', defOf('support').help);
      rows.append(on);
      if (s.support !== 'none') {
        const place = el('div', { class: 'row wide' });
        place.append(el('span', { class: 'row-label' }, 'Support placement'), this.placementPicker());
        rows.append(place);
      }
    }
    if (s.support !== 'none') rows.append(this.customRow(defOf('supportAngle')));
  }

  supportToggle(label = 'Tree supports', ariaLabel) {
    const s = this.settings;
    return this.toggle(label, s.support !== 'none', (on) => {
      this.set('support', on ? (this.lastPlacement ?? 'buildplate') : 'none');
    }, label ? 'Hollow tree branches hold up parts that hang in the air.' : ariaLabel);
  }

  adhesionPicker(ids) {
    const seg = el('div', { class: 'seg adhesion', role: 'radiogroup', 'aria-label': 'Build plate adhesion' });
    for (const id of ids) {
      const opt = ADHESION_CHOICES.find((a) => a.id === id);
      const on = this.settings.adhesion === id;
      const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '' }, opt.label);
      b.addEventListener('click', () => this.set('adhesion', id));
      this.hintOn(b, opt.label, opt.blurb);
      seg.append(b);
    }
    return seg;
  }

  placementPicker() {
    const seg = el('div', { class: 'seg placement', role: 'radiogroup', 'aria-label': 'Support placement' });
    for (const opt of SUPPORT_CHOICES.filter((o) => o.id !== 'none')) {
      const on = this.settings.support === opt.id;
      const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '' }, opt.label);
      b.addEventListener('click', () => {
        this.lastPlacement = opt.id;
        this.set('support', opt.id);
      });
      this.hintOn(b, opt.label, opt.blurb);
      seg.append(b);
    }
    return seg;
  }

  customRow(def) {
    if (this.isLocked(def.id)) {
      return this.infoRow(def.label, valueText(def.id, this.settings[def.id]), `Your teacher set this for the class. ${def.help}`, true);
    }
    const row = el('div', { class: 'row' });
    const label = el('span', { class: 'row-label' }, def.label);
    row.append(label);
    const value = this.settings[def.id];
    if (def.kind === 'range') {
      row.classList.add('wide');
      row.append(this.rangeSlider(def.id, true));
    } else if (def.id === 'infillPattern') {
      row.classList.add('wide');
      row.append(this.patternPicker());
    } else {
      const select = el('select', { 'aria-label': def.label });
      for (const opt of def.options) {
        const o = el('option', { value: String(opt.id) }, opt.label);
        if (opt.id === value) o.selected = true;
        select.append(o);
      }
      select.addEventListener('change', () => {
        const opt = def.options.find((o) => String(o.id) === select.value);
        if (opt) this.set(def.id, opt.id);
      });
      row.append(select);
    }
    const current = def.options?.find((o) => o.id === value);
    this.hintOn(row, def.label, def.help + (current?.blurb ? `\n\n${current.label}: ${current.blurb}` : ''));
    return row;
  }

  infoRow(label, value, help, locked = false) {
    const r = el('div', { class: `row info ${locked ? 'lockedrow' : ''}` });
    r.innerHTML = `<span class="row-label">${esc(label)}</span><span class="row-value">${locked ? '🔒 ' : ''}${esc(value)}</span>`;
    this.hintOn(r, label, help);
    return r;
  }

  // A stepped slider for a 'range' setting. While it is being dragged it sends 'preview' events,
  // so the 3D view can follow along (the support angle repaints the red live).
  rangeSlider(id, compact = false) {
    const def = defOf(id);
    const v = this.settings[id];
    const describe = WORDS[id] ?? (() => '');
    const pct = (x) => `${((x - def.min) / (def.max - def.min)) * 100}%`;
    const wrap = el('div', { class: `slider ${compact ? 'compact' : ''}` });
    const input = el('input', {
      type: 'range', min: def.min, max: def.max, step: def.step, value: v, 'aria-label': def.label,
    });
    input.style.setProperty('--pct', pct(v));
    const out = el('output', { class: 'slider-value' }, `${v}${def.unit}`);
    input.addEventListener('input', () => {
      const x = Number(input.value);
      out.textContent = `${x}${def.unit}`;
      input.style.setProperty('--pct', pct(x));
      words.textContent = describe(x);
      this.dispatchEvent(new CustomEvent('preview', { detail: { [id]: x } }));
    });
    input.addEventListener('change', () => this.set(id, Number(input.value)));
    const top = el('div', { class: 'slider-row' });
    top.append(input, out);
    wrap.append(top);
    if (!compact) {
      const ticks = el('div', { class: 'ticks', 'aria-hidden': 'true' });
      for (let t = def.min; t <= def.max; t += def.tickStep) ticks.append(el('span', {}, `${t}`));
      wrap.append(ticks);
    }
    const words = el('p', { class: 'note' }, describe(v));
    wrap.append(words);
    return wrap;
  }

  patternPicker() {
    const grid = el('div', { class: 'patterns', role: 'radiogroup', 'aria-label': 'Infill pattern' });
    for (const p of INFILL_PATTERNS) {
      const on = this.settings.infillPattern === p.id;
      const b = el('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: on ? 'on' : '' });
      b.innerHTML = `${patternIcon(p.id)}<span>${esc(p.label)}</span>`;
      b.addEventListener('click', () => this.set('infillPattern', p.id));
      this.hintOn(b, `${p.label} infill`, p.blurb);
      grid.append(b);
    }
    if (this.settings.infillDensity === 0) {
      grid.append(el('p', { class: 'note span' }, 'Infill is 0%, so there is no pattern inside.'));
    }
    return grid;
  }

  toggle(label, on, onChange, help) {
    const row = el('label', { class: 'toggle' });
    // No visible text (the Custom row shows its label beside it): name it for screen readers.
    const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label ? null : help ?? 'Generate support' });
    input.checked = on;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, el('span', { class: 'switch', 'aria-hidden': 'true' }), el('span', {}, label));
    if (help) this.hintOn(row, label, help);
    return row;
  }

  // ---- Do I need supports? ------------------------------------------------------------------
  // Red on the model = hangs in the air past the support angle (viewer.js paint). A few mm² of red
  // (a tiny tip, the edge of a hole) prints fine without supports; a red face with the model under
  // it cannot be reached by supports that only grow from the bed (viewer.js checkSupport).

  /** Which piece of advice fits the plate and the support setting now (null = none). */
  adviceKind() {
    if (!this.hasModels) return null;
    const red = this.overhangs;
    const level = red < SUPPORT_RED.none ? 'none' : red < SUPPORT_RED.tiny ? 'tiny' : 'some';
    // Over the model: a real share of the red, and more than a tiny bit.
    const over = this.overModel == null ? null
      : this.overModel >= SUPPORT_RED.tiny && this.overModel >= red * 0.15;
    const support = this.settings.support;
    if (support === 'none') {
      if (level === 'some') return over ? 'off-need-everywhere' : 'off-need';
      return level === 'tiny' ? 'off-tiny' : 'off-none';
    }
    if (level !== 'some') return `on-${level}`;
    if (support === 'buildplate') {
      if (over) return 'plate-cannot-reach';
      return red >= SUPPORT_RED.lots ? 'on-lots' : 'on-good';
    }
    if (over === false) return 'everywhere-not-needed';
    return 'everywhere-good';
  }

  supportAdvice() {
    const kind = this.adviceKind();
    if (!kind) return null;
    const locked = this.isLocked('support');
    const turnOn = { label: 'Turn on tree supports', run: () => this.set('support', this.lastPlacement ?? 'buildplate') };
    const turnOff = { label: 'Turn supports off', run: () => this.set('support', 'none') };
    const everywhere = { label: 'Use Everywhere', run: () => this.set('support', 'everywhere') };
    const plate = { label: 'Use Touching build plate', run: () => this.set('support', 'buildplate') };
    const show = { label: 'Show me the red', run: () => this.dispatchEvent(new Event('showred')), quiet: true };
    const advice = {
      'off-need': ['warn', 'Red parts hang in the air. Without supports they droop or fall. Turn on supports, or turn your model so less is red.', [turnOn, show]],
      'off-need-everywhere': ['warn', 'Red parts hang in the air, some above your model, not the bed. Turn on supports Everywhere so they can reach.', [everywhere, show]],
      'off-tiny': ['ok', 'Only a tiny bit is red. Small overhangs like that usually print fine without supports.', [show]],
      'off-none': ['ok', 'Nothing hangs in the air, so no supports needed.', []],
      'on-none': ['ok', 'Nothing on your model is red, so it does not need supports. Turn them off to save plastic and time.', [turnOff]],
      'on-tiny': ['ok', 'Only a tiny bit is red. It will probably print fine without supports, and save plastic.', [turnOff, show]],
      'on-good': ['ok', 'Good: tree supports will hold up the red parts.', [show]],
      'on-lots': ['ok', 'Good: tree supports will hold up the red parts. A lot is red, though. Turning your model (Rotate, then Biggest flat side down) might need fewer supports and print faster.', [show]],
      'plate-cannot-reach': ['warn', 'Some red parts are above your model, not the bed (like inside an arch). Supports from the bed cannot reach them. Pick Everywhere.', [everywhere, show]],
      'everywhere-not-needed': ['ok', 'Every red part is above the bed, so Touching build plate is enough. Those supports are easier to clean off.', [plate]],
      'everywhere-good': ['ok', 'Good: supports can grow from your model to reach the red parts above it.', [show]],
    }[kind];
    const [tone, text, actions] = advice;
    const box = el('div', { class: `advice ${tone}` });
    box.append(el('p', {}, locked ? `${text} (Your teacher sets supports.)` : text));
    const shown = actions.filter((a) => a.quiet || !locked);
    if (shown.length) {
      const row = el('div', { class: 'advice-actions' });
      for (const a of shown) {
        const b = el('button', { type: 'button', class: a.quiet ? 'linkbtn' : '' }, a.label);
        b.addEventListener('click', a.run);
        row.append(b);
      }
      box.append(row);
    }
    return box;
  }

  block(body, title, def) {
    const b = el('div', { class: 'rec-block' });
    const h = el('div', { class: 'rec-title' });
    h.innerHTML = `<span>${esc(title)}</span>`;
    b.append(h);
    this.hintOn(h, def.label, def.help);
    body.append(b);
    return b;
  }

  // ---- Hover help (Cura shows a card beside the panel; so do we) ----------------------------

  hintOn(target, title, text) {
    const show = () => {
      clearTimeout(this.hintTimer);
      this.hintTimer = setTimeout(() => {
        this.hint.innerHTML = `<strong>${esc(title)}</strong>${esc(text).split('\n\n').map((p) => `<p>${p}</p>`).join('')}`;
        this.hint.hidden = false;
        const r = target.getBoundingClientRect();
        const panel = this.root.getBoundingClientRect();
        const h = this.hint.getBoundingClientRect();
        this.hint.style.left = `${Math.max(8, panel.left - h.width - 10)}px`;
        this.hint.style.top = `${Math.min(window.innerHeight - h.height - 8, Math.max(8, r.top))}px`;
      }, 350);
    };
    const hide = () => {
      clearTimeout(this.hintTimer);
      this.hint.hidden = true;
    };
    target.addEventListener('mouseenter', show);
    target.addEventListener('mouseleave', hide);
    target.addEventListener('focusin', show);
    target.addEventListener('focusout', hide);
  }
}

