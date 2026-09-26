// The "Print settings" card, top right, shaped like Cura's: a header with a one-line summary,
// then Recommended (four big controls) or Custom (every student setting, grouped, plus the
// teacher's locked settings greyed out). Both tabs edit the same settings object.

import {
  ADHESION_CHOICES, DEFAULT_CLASS_CONFIG, INFILL_PATTERNS, LOCKED, QUALITIES, SECTIONS, SETTINGS,
  SUPPORT_CHOICES, TREE_SUPPORT_INFILL, applyClassLocks, isClassDefault, qualityById, summarize,
  validateClassConfig, validateSettings,
} from '../../shared/settings.js';
import { el, esc } from './dom.js';
import { patternIcon } from './pattern-icons.js';

const STORE_SETTINGS = 'umm.settings';
const STORE_MODE = 'umm.settingsMode';
const STORE_OPEN = 'umm.settingsOpen';

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
  if (v <= 55) return 'More support than normal. Safer for tricky models.';
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
    const stored = validateSettings(load(STORE_SETTINGS, {}));
    this.settings = stored.ok ? stored.settings : { ...this.config.defaults };
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
    save(STORE_SETTINGS, this.settings);
    this.render();
    this.dispatchEvent(new Event('change'));
  }

  /** The teacher's class setup: locked settings snap to the teacher's value. */
  setClassConfig(input) {
    const v = validateClassConfig(input);
    if (!v.ok) return;
    this.config = v.config;
    const before = JSON.stringify(this.settings);
    this.settings = applyClassLocks(this.settings, this.config);
    save(STORE_SETTINGS, this.settings);
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
    save(STORE_SETTINGS, this.settings);
    this.render();
    this.dispatchEvent(new Event('change'));
  }

  /** The viewer tells us how much of the plate hangs in the air, for the support advice. */
  setPlateInfo({ overhangs, hasModels }) {
    const was = `${this.overhangs > 25}|${this.hasModels}`;
    this.overhangs = overhangs;
    this.hasModels = hasModels;
    if (was !== `${this.overhangs > 25}|${this.hasModels}`) this.render();
  }

  // ---- Rendering ----------------------------------------------------------------------------

  render() {
    const scroll = this.root.querySelector('.settings-body')?.scrollTop ?? 0;
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
  }

  renderRecommended(body) {
    const s = this.settings;
    const q = qualityById(s.quality);

    // Print quality: three big buttons, like picking a Cura profile.
    const quality = this.block(body, 'Print quality', defOf('quality'));
    if (this.isLocked('quality')) quality.append(this.lockedLine('quality'));
    const seg = el('div', { class: 'seg quality' });
    for (const opt of QUALITIES) {
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
    const advice = this.supportAdvice();
    if (advice) support.append(advice);

    // Adhesion.
    const adhesion = this.block(body, 'Adhesion', defOf('adhesion'));
    adhesion.append(this.isLocked('adhesion') ? this.lockedLine('adhesion') : this.toggle('Brim', s.adhesion === 'brim',
      (on) => this.set('adhesion', on ? 'brim' : 'skirt'), ADHESION_CHOICES.find((a) => a.id === 'brim').blurb));
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
    for (const group of LOCKED) {
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
      on.append(el('span', { class: 'row-label' }, 'Generate support'), this.supportToggle(''));
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

  supportToggle(label = 'Tree supports') {
    const s = this.settings;
    return this.toggle(label, s.support !== 'none', (on) => {
      this.set('support', on ? (this.lastPlacement ?? 'buildplate') : 'none');
    }, label ? 'Hollow tree branches hold up parts that hang in the air.' : undefined);
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
    const input = el('input', { type: 'checkbox', role: 'switch' });
    input.checked = on;
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, el('span', { class: 'switch', 'aria-hidden': 'true' }), el('span', {}, label));
    if (help) this.hintOn(row, label, help);
    return row;
  }

  supportAdvice() {
    if (!this.hasModels) return null;
    const off = this.settings.support === 'none';
    if (off && this.overhangs > 25) {
      return el('p', { class: 'advice warn' }, 'Your model has red parts hanging in the air (click Below, bottom left, to see them). Turn on tree supports, or turn the model so less is red.');
    }
    if (!off && this.overhangs <= 25) {
      return el('p', { class: 'advice ok' }, 'Nothing on your plate is red, so it may not need supports. Turning them off saves plastic.');
    }
    return null;
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

