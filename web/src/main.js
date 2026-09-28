// The student page: open a model, set it on the Workhorse bed, pick settings, Slice, save for the
// SD card. The pieces: viewer.js (3D plate), settings-panel.js (print settings), loaders.js
// (STL/OBJ/3MF), shared/settings.js (what may be changed; the Worker checks the same list).

import './style.css';
import { LIMITS, PRINTER, formatMinutes, gcodeFileName, summarize } from '../../shared/settings.js';
import { $, el, esc, fmt } from './dom.js';
import { LINE_TYPES, filamentGrams, formatDuration, parseGcode } from './gcode.js';
import { ACCEPT, LoadError, loadModelFile, sampleModel } from './loaders.js';
import { meshHealth } from './mesh-health.js';
import { PrinterUsb, cardLines, sdName } from './printer-usb.js';
import { clearPlate, loadPlate, savePlate } from './plate-store.js';
import { SettingsPanel } from './settings-panel.js';
import { splitParts } from './split.js';
import { initThemeButton, isDark, onThemeChange } from './theme.js';
import { Viewer } from './viewer.js';

const STORE_NAME = 'umm.name';
const STORE_PHRASE = 'umm.phrase'; // this tab only (sessionStorage), like the sister sites

// Is slicing open? Asked of the Worker (never the slicer, so it costs nothing): on load, every two
// minutes, and before each slice. engine=false means this site has no slicer, so no gate.
let slicing = { engine: false, open: false, until: null };
// Copy to the printer's SD card over USB: { state: 'idle' | 'working' | 'done' | 'error', ... }.
let usb = { state: 'idle' };
let usbAbort = null;
async function refreshSlicing() {
  try {
    const r = await fetch('/api/slicing', { cache: 'no-store' });
    if (r.ok) slicing = await r.json();
  } catch { /* offline: keep what we knew */ }
  return slicing;
}

function storedPhrase() {
  try {
    return sessionStorage.getItem(STORE_PHRASE) ?? '';
  } catch {
    return '';
  }
}

/** Ask for the class phrase. Resolves with it, or '' if they cancel. */
function askPhrase(error) {
  const dialog = $('#phraseDialog');
  const input = $('#phraseInput');
  input.value = error ? '' : storedPhrase();
  $('#phraseError').hidden = !error;
  $('#phraseError').textContent = error ?? '';
  dialog.showModal();
  input.focus();
  // Enter means "Slice" (the form's first button is Cancel).
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.close('ok');
    }
  };
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const phrase = dialog.returnValue === 'ok' ? input.value.trim() : '';
      if (phrase) {
        try {
          sessionStorage.setItem(STORE_PHRASE, phrase);
        } catch { /* fine: asked again next time */ }
      }
      resolve(phrase);
    }, { once: true });
  });
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const viewer = new Viewer($('#viewport'), PRINTER);
const panel = new SettingsPanel($('#settings'), $('#hint'));
// Browser tests reach the 3D view through this; only with ?debug in the address.
if (new URLSearchParams(location.search).has('debug')) window.umm = { viewer, panel };

let tool = 'move';
let stage = 'prepare'; // 'prepare' (plate + settings) or 'preview' (G-code layers)
let previewSource = null; // { kind: 'file' | 'slice', name }
let slice = { state: 'idle' }; // idle | slicing | done | error
let sliceAbort = null;

initThemeButton($('#theme'));
viewer.setTheme(isDark() ? 'dark' : 'light');
onThemeChange(() => viewer.setTheme(isDark() ? 'dark' : 'light'));

// ---- Toasts -----------------------------------------------------------------------------------

// `key`: a new toast with the same key replaces the old one (so ten quick Undos show one toast).
// One button: `action` + `actionLabel`. Several: `actions: [{ label, run }]`.
function toast(message, { kind = 'info', action, actionLabel, actions = [], timeout = 6000, key } = {}) {
  const box = $('#toasts');
  if (key) box.querySelector(`[data-key="${key}"]`)?.remove();
  while (box.children.length >= 3) box.firstElementChild.remove();
  if (action) actions = [{ label: actionLabel, run: action }, ...actions];
  // Several buttons go on their own row under the message.
  const cls = `toast ${kind}${actions.length > 1 ? ' many' : ''}`;
  const t = el('div', { class: cls, role: kind === 'error' ? 'alert' : 'status', 'data-key': key });
  t.append(el('span', {}, message));
  for (const a of actions) {
    const b = el('button', { type: 'button', class: 'toast-action' }, a.label);
    b.addEventListener('click', () => {
      a.run();
      t.remove();
    });
    t.append(b);
  }
  const x = el('button', { type: 'button', class: 'toast-x', 'aria-label': 'Close' }, '×');
  x.addEventListener('click', () => t.remove());
  t.append(x);
  box.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
}

function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busyText').textContent = text;
}

// ---- Opening files ----------------------------------------------------------------------------

const fileInput = $('#fileInput');
fileInput.accept = ACCEPT;
fileInput.addEventListener('change', () => {
  loadFiles([...fileInput.files]);
  fileInput.value = '';
});
const openPicker = () => fileInput.click();
$('#open').addEventListener('click', openPicker);
$('#emptyOpen').addEventListener('click', openPicker);
$('#sample').addEventListener('click', () => {
  const s = sampleModel();
  viewer.addModel(s.name, s.positions);
  toast('This test piece has an arm sticking out. Its underside hangs in the air, so it needs supports.', {
    action: () => viewer.setView('below'),
    actionLabel: 'Show me',
    timeout: 12000,
  });
});

async function openGcode(file) {
  if (file.size > 80 * 1048576) {
    toast(`"${file.name}" is too big to preview here.`, { kind: 'error' });
    return;
  }
  busy(`Reading ${file.name}…`);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const parsed = parseGcode(await file.text());
    if (!parsed.layers.length) {
      toast(`No layers found in "${file.name}". Is it a G-code file from Cura?`, { kind: 'error', timeout: 9000 });
      return;
    }
    showGcode(parsed, { kind: 'file', name: file.name });
    toast('Preview only: this shows the file, it does not change it.', { timeout: 5000 });
  } catch (err) {
    console.error(err);
    toast(`Could not read "${file.name}".`, { kind: 'error' });
  } finally {
    busy(null);
  }
}

async function loadFiles(files) {
  const gcode = files.filter((f) => /\.gcode$/i.test(f.name));
  files = files.filter((f) => !gcode.includes(f));
  if (gcode.length) await openGcode(gcode.at(-1));
  if (files.length && stage === 'preview') setStage('prepare');
  for (const file of files) {
    if (viewer.models.length >= LIMITS.maxObjects) {
      toast(`That is ${LIMITS.maxObjects} objects already, the most for one plate.`, { kind: 'error' });
      break;
    }
    if (file.size > LIMITS.maxUploadBytes * 2) {
      toast(`"${file.name}" is ${fmt(file.size / 1048576)} MB. That is too big to slice here. Ask your teacher to use Cura.`, { kind: 'error', timeout: 10000 });
      continue;
    }
    busy(`Opening ${file.name}…`);
    // Let the spinner paint before a big file blocks the page.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      const { name, positions } = await loadModelFile(file);
      const plateTris = viewer.models.reduce((n, m) => n + m.triangles, 0);
      if (positions.length / 9 > LIMITS.maxTriangles) {
        throw new LoadError(`"${file.name}" has ${fmt(positions.length / 9)} triangles. The most is ${fmt(LIMITS.maxTriangles)}. Export it with lower detail.`);
      }
      if (plateTris + positions.length / 9 > LIMITS.maxTriangles) {
        throw new LoadError(`With "${file.name}" the plate would have too much detail to slice (${fmt(plateTris + positions.length / 9)} triangles, the most is ${fmt(LIMITS.maxTriangles)}). Remove a model first.`);
      }
      const model = viewer.addModel(name, positions);
      checkUnits(model);
      checkHealth(model);
    } catch (err) {
      toast(err instanceof LoadError ? err.message : `Could not open "${file.name}".`, { kind: 'error', timeout: 10000 });
      if (!(err instanceof LoadError)) console.error(err);
    }
  }
  busy(null);
}

// Holes and broken edges (see mesh-health.js), checked once per model when the browser is idle.
const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 300));
function checkHealth(model, { quiet = false } = {}) {
  idle(() => {
    if (!viewer.models.includes(model) || model.health) return;
    model.health = meshHealth(model.original);
    const { openEdges, badEdges } = model.health;
    if (!openEdges && !badEdges) return;
    renderObjects();
    if (quiet) return;
    toast(`"${model.name}" has holes or broken edges, so it may print with gaps. If the print looks wrong, fix the model or export it again.`, {
      kind: 'warn',
      timeout: 12000,
    });
  }, { timeout: 3000 });
}

// A model made in inches shows up 25.4 times too small, and one from Blender (meters) 1000 times
// too small; one made in the wrong units can also be huge. Offer the fix instead of guessing.
function checkUnits(model) {
  const s = model.size;
  const biggest = Math.max(s.x, s.y, s.z);
  if (biggest < 8) {
    const grow = (times, label) => () => viewer.models.includes(model) && viewer.transaction(label, () => {
      viewer.setScale(model, times * 100, times * 100, times * 100);
      viewer.moveToFreeSpot(model);
    });
    const actions = [{ label: 'Inches: ×25.4', run: grow(25.4, 'inches to mm') }];
    // Only offer meters when the result would still fit on the printer.
    const bed = viewer.printer.bed;
    const metersFits = s.x * 1000 <= bed.x && s.y * 1000 <= bed.y && s.z * 1000 <= bed.z;
    if (metersFits) actions.push({ label: 'Meters (Blender): ×1000', run: grow(1000, 'meters to mm') });
    const question = metersFits ? 'Was it made in inches, or in meters (Blender)?' : 'Was it made in inches?';
    toast(`"${model.name}" is tiny (${fmt(biggest, biggest < 1 ? 2 : 1)} mm). ${question}`, { actions, timeout: 15000 });
  } else if (!viewer.checkFit(model)) {
    toast(`"${model.name}" is bigger than the printer.`, {
      kind: 'warn',
      action: () => viewer.models.includes(model) && viewer.scaleToFit(model),
      actionLabel: 'Shrink to fit',
      timeout: 15000,
    });
  }
}

// Drag and drop anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('#drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#drop').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  if (e.dataTransfer?.files.length) loadFiles([...e.dataTransfer.files]);
});

// ---- Tools (left bar) and their panel ---------------------------------------------------------

function setTool(name) {
  tool = name;
  if (viewer.layFlatPicking) viewer.startLayFlatPick(false);
  if (!viewer.selection.size && viewer.models.length === 1) viewer.select(viewer.models[0]);
  viewer.setGizmo(tool === 'rotate' ? 'rotate' : null);
  renderTools();
}

for (const b of document.querySelectorAll('.tool[data-tool]')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}
// Copies count against the plate limits like opened files do.
function duplicateSelected() {
  const list = viewer.selectedList;
  const tris = viewer.models.reduce((n, m) => n + m.triangles, 0) + list.reduce((n, m) => n + m.triangles, 0);
  if (viewer.models.length + list.length > LIMITS.maxObjects) {
    toast(`That would be more than ${LIMITS.maxObjects} objects, the most for one plate.`, { kind: 'error' });
  } else if (tris > LIMITS.maxTriangles) {
    toast('That would be too much detail on one plate to slice. Copy fewer models.', { kind: 'error' });
  } else {
    viewer.duplicateSelected();
  }
}

$('#dupBtn').addEventListener('click', duplicateSelected);

// ---- Undo / redo ------------------------------------------------------------------------------

function undo() {
  const label = viewer.undo();
  if (label) toast(`Undid: ${label}`, { timeout: 2200, key: 'history' });
}

function redo() {
  const label = viewer.redo();
  if (label) toast(`Redid: ${label}`, { timeout: 2200, key: 'history' });
}

$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
viewer.addEventListener('history', () => {
  $('#undoBtn').disabled = !viewer.canUndo;
  $('#redoBtn').disabled = !viewer.canRedo;
});
$('#delBtn').addEventListener('click', () => viewer.removeSelected());

function numberField(label, value, onCommit, { unit = 'mm', step = 1, min, disabled = false, digits = 1 } = {}) {
  const wrap = el('label', { class: `field ${disabled ? 'disabled' : ''}` });
  wrap.append(el('span', { class: 'field-axis' }, label));
  const input = el('input', { type: 'number', step, min, inputmode: 'decimal' });
  input.value = Number(value).toFixed(digits).replace(/\.0+$/, '');
  input.disabled = disabled;
  input.dataset.digits = digits;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onCommit(v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  wrap.append(input, el('span', { class: 'field-unit' }, unit));
  return wrap;
}

function button(label, onClick, cls = '') {
  const b = el('button', { type: 'button', class: cls });
  b.innerHTML = label;
  b.addEventListener('click', onClick);
  return b;
}

let uniformScale = true;

// Several models selected (Ctrl + click, Ctrl + A): one panel of actions for all of them.
function renderGroupPanel(p) {
  const list = viewer.selectedList;
  const title = el('div', { class: 'tp-title' });
  title.innerHTML = `<strong>${list.length} models selected</strong>`;
  p.append(title);
  p.append(el('p', { class: 'note' }, 'Drag any of them to move them all. Arrow keys nudge them all. Ctrl + click a model to add or remove it.'));
  const each = (label, fn) => () => viewer.forSelected(label, fn);
  const spin = el('div', { class: 'rot-row' });
  spin.append(el('span', {}, 'Spin each'), el('span', { class: 'axis-tag' }, 'Z'),
    button('↺ 90°', each('turn', (m) => viewer.rotate(m, 'z', 90))),
    button('↻ 90°', each('turn', (m) => viewer.rotate(m, 'z', -90))));
  p.append(spin);
  p.append(button('⬇ Lay each one flat', each('lay flat', (m) => viewer.layFlatAuto(m)), 'wide'));
  const scale = el('div', { class: 'btn-row' });
  for (const pct of [50, 100, 200]) {
    scale.append(button(`${pct}%`, each('scale', (m) => viewer.setScale(m, pct, pct, pct))));
  }
  scale.append(button('Fit bed', each('fit to bed', (m) => viewer.scaleToFit(m, { center: false }))));
  p.append(el('span', { class: 'sub-label' }, 'Scale each (from its file size)'), scale);
  p.append(button('⊕ Center the group on the bed', () => viewer.centerSelected(), 'wide'));
  p.append(button('▦ Arrange everything', () => viewer.arrangeAll(), 'wide'));
  p.append(button('✂ Split each into separate objects', splitSelected, 'linkbtn'));
}

function renderTools() {
  const m = viewer.selected;
  const count = stage === 'preview' ? 0 : viewer.selection.size;
  for (const b of document.querySelectorAll('.tool[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === tool && count === 1);
    b.disabled = count !== 1;
  }
  $('#dupBtn').disabled = !count;
  $('#delBtn').disabled = !count;

  const p = $('#toolPanel');
  p.hidden = !count;
  if (!count) return;
  p.innerHTML = '';
  if (count > 1 || !m) {
    renderGroupPanel(p);
    return;
  }
  const title = el('div', { class: 'tp-title' });
  title.innerHTML = `<strong>${esc({ move: 'Move', scale: 'Scale', rotate: 'Rotate', mirror: 'Mirror' }[tool])}</strong><span class="tp-model">${esc(m.name)}</span>`;
  p.append(title);

  if (tool === 'move') {
    const grid = el('div', { class: 'fields' });
    grid.append(
      numberField('X', m.position.x, (v) => viewer.setPosition(m, v, m.position.y)),
      numberField('Y', m.position.y, (v) => viewer.setPosition(m, m.position.x, v)),
      numberField('Z', 0, () => {}, { disabled: true }),
    );
    p.append(grid);
    p.append(el('p', { class: 'note' }, 'Drag the model to move it. It always sits on the bed. 0, 0 is the middle.'));
    p.append(button('⊕ Center on the bed', () => viewer.setPosition(m, 0, 0), 'wide'));
    p.append(button('✂ Split into separate objects', splitSelected, 'linkbtn'));
  }

  if (tool === 'scale') {
    const s = m.size;
    const sc = m.mesh.scale;
    const apply = (axis, factor) => {
      const cur = { x: sc.x * 100, y: sc.y * 100, z: sc.z * 100 };
      if (uniformScale) viewer.setScale(m, cur.x * factor, cur.y * factor, cur.z * factor);
      else {
        cur[axis] *= factor;
        viewer.setScale(m, cur.x, cur.y, cur.z);
      }
    };
    const grid = el('div', { class: 'fields two' });
    for (const axis of ['x', 'y', 'z']) {
      grid.append(
        numberField(axis.toUpperCase(), s[axis], (v) => v > 0 && apply(axis, v / m.size[axis]), { min: 0.1 }),
        numberField('', sc[axis] * 100, (v) => v > 0 && apply(axis, v / (sc[axis] * 100)), { unit: '%', min: 1, digits: 0 }),
      );
    }
    p.append(grid);
    const lock = el('label', { class: 'check' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = uniformScale;
    cb.addEventListener('change', () => { uniformScale = cb.checked; });
    lock.append(cb, el('span', {}, 'Keep the shape (scale evenly)'));
    p.append(lock);
    const quick = el('div', { class: 'btn-row' });
    for (const pct of [50, 100, 200]) {
      quick.append(button(`${pct}%`, () => viewer.setScale(m, pct, pct, pct)));
    }
    quick.append(button('Fit bed', () => viewer.scaleToFit(m)));
    p.append(quick);
    const vol = m.volume / 1000;
    p.append(el('p', { class: 'note' }, `Size: ${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)} mm · about ${fmt(vol, 1)} cm³ of model`));
  }

  if (tool === 'rotate') {
    const rows = [
      ['Spin', 'z', '↺', '↻'],
      ['Tip forward / back', 'x', '⤓', '⤒'],
      ['Roll left / right', 'y', '↶', '↷'],
    ];
    const box = el('div', { class: 'rot-rows' });
    for (const [label, axis, a, b] of rows) {
      const r = el('div', { class: 'rot-row' });
      r.append(el('span', {}, `${label}`), el('span', { class: 'axis-tag' }, axis.toUpperCase()));
      r.append(button(`${a} 90°`, () => viewer.rotate(m, axis, 90)), button(`${b} 90°`, () => viewer.rotate(m, axis, -90)));
      box.append(r);
    }
    p.append(box);
    const pick = button(viewer.layFlatPicking ? '✋ Click a face on your model…' : '🖐 Lay flat: pick a face', () => viewer.startLayFlatPick(!viewer.layFlatPicking), `wide ${viewer.layFlatPicking ? 'primary' : ''}`);
    p.append(pick);
    p.append(button('⬇ Biggest flat side down', () => viewer.layFlatAuto(m), 'wide'));
    p.append(el('p', { class: 'note' }, 'Lay flat: click the side of your model that should touch the bed. Or drag a coloured ring round the model to turn it (15° steps).'));
    p.append(button('↺ Undo all turns and mirrors', () => viewer.resetTurns(m), 'linkbtn'));
  }

  if (tool === 'mirror') {
    p.append(button('⇆ Flip left–right <span class="axis-tag">X</span>', () => viewer.mirror(m, 'x'), 'wide'));
    p.append(button('⇅ Flip front–back <span class="axis-tag">Y</span>', () => viewer.mirror(m, 'y'), 'wide'));
    p.append(button('⇵ Flip upside down <span class="axis-tag">Z</span>', () => viewer.mirror(m, 'z'), 'wide'));
    p.append(el('p', { class: 'note' }, 'Mirroring makes a left-hand version of a right-hand part. Text comes out backwards.'));
  }
}

// Keep the numbers in the tool panel up to date while dragging, without re-building it (that
// would steal focus from a box the student is typing in).
function syncToolPanel() {
  const m = viewer.selected;
  if (!m || tool !== 'move') return;
  const inputs = $('#toolPanel').querySelectorAll('input[type=number]');
  const vals = [m.position.x, m.position.y];
  inputs.forEach((input, i) => {
    if (i < 2 && document.activeElement !== input) input.value = String(Math.round(vals[i] * 10) / 10);
  });
}

// ---- Object list (bottom left) ----------------------------------------------------------------

let objectsOpen = true;
$('#objectsHead').addEventListener('click', () => {
  objectsOpen = !objectsOpen;
  renderObjects();
});
$('#arrange').addEventListener('click', () => viewer.arrangeAll());
$('#clearPlate').addEventListener('click', () => {
  if (!viewer.models.length) return;
  const removed = viewer.models.length;
  viewer.clear();
  const entry = viewer.undoStack.at(-1);
  toast(`Cleared ${removed} object${removed === 1 ? '' : 's'}.`, {
    action: () => {
      if (viewer.undoStack.at(-1) === entry) undo();
      else toast('Something else changed since then. Use the Undo button to step back.', { key: 'history' });
    },
    actionLabel: 'Undo',
    key: 'history',
  });
});

function renderObjects() {
  const list = $('#objectList');
  const n = viewer.models.length;
  $('#objects').hidden = n === 0;
  $('#objects').classList.toggle('closed', !objectsOpen);
  $('#objectsHead').setAttribute('aria-expanded', String(objectsOpen));
  $('#objCount').textContent = String(n);
  list.innerHTML = '';
  for (const m of viewer.models) {
    const s = m.size;
    const broken = m.health && (m.health.openEdges || m.health.badEdges);
    const li = el('li', { class: `${viewer.selection.has(m) ? 'on' : ''} ${m.outside ? 'bad' : ''}` });
    const title = m.outside ? `This model is ${m.fitProblem}.`
      : broken ? `${m.name} has holes or broken edges (${m.health.openEdges + m.health.badEdges}). It may print with gaps.`
        : `${m.name} (Ctrl + click to pick several)`;
    const b = el('button', { type: 'button', title });
    b.innerHTML = `<span class="obj-name">${m.outside ? '⚠ ' : ''}${esc(m.name)}${broken ? ' <span class="obj-flag">holes</span>' : ''}</span><span class="obj-size">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</span>`;
    b.addEventListener('click', (e) => (e.ctrlKey || e.metaKey ? viewer.toggleSelect(m) : viewer.select(m)));
    li.append(b);
    list.append(li);
  }
}

// ---- Split a model into its separate parts ------------------------------------------------------

// One STL with several things in it (a whole set of keychains) becomes one object per thing, so
// each can be moved, turned and laid flat on its own. See split.js for what counts as one thing.
async function splitSelected() {
  const list = viewer.selectedList;
  if (!list.length) return;
  busy('Looking for separate parts…');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  let plan;
  try {
    plan = list.map((m) => ({ m, parts: splitParts(m.geometry.attributes.position.array) })).filter((p) => p.parts);
  } finally {
    busy(null);
  }
  if (!plan.length) {
    toast(list.length === 1
      ? `"${list[0].name}" is all one piece, so there is nothing to split. (Parts that touch or overlap stay together.)`
      : 'Each of these is all one piece, so there is nothing to split.', { timeout: 8000 });
    return;
  }
  const total = viewer.models.length + plan.reduce((n, p) => n + p.parts.length - 1, 0);
  if (total > LIMITS.maxObjects) {
    toast(`Splitting makes ${total} objects, and the most for one plate is ${LIMITS.maxObjects}. Remove some first, or print this one as it is.`, { kind: 'error', timeout: 10000 });
    return;
  }
  const made = [];
  viewer.transaction('split', () => {
    for (const { m, parts } of plan) made.push(...viewer.splitModel(m, parts));
  });
  viewer.selectMany(made, made.at(-1));
  for (const m of made) checkHealth(m, { quiet: true });
  const entry = viewer.undoStack.at(-1);
  toast(`Split into ${made.length} objects.`, {
    action: () => {
      if (viewer.undoStack.at(-1) === entry) undo();
      else toast('Something else changed since then. Use the Undo button to step back.', { key: 'history' });
    },
    actionLabel: 'Undo',
    key: 'history',
  });
}

// ---- Right-click menu on the plate ------------------------------------------------------------

const menu = $('#ctxMenu');

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
}

function openMenu({ model, x, y }) {
  const count = viewer.selection.size;
  const items = model
    ? [
      ['✂', count > 1 ? 'Split each into separate objects' : 'Split into separate objects', splitSelected],
      null,
      ['⧉', 'Copy', duplicateSelected, 'Ctrl+D'],
      ['⬇', count > 1 ? 'Lay each one flat' : 'Biggest flat side down', () => viewer.forSelected('lay flat', (m) => viewer.layFlatAuto(m))],
      ['⊕', 'Center on the bed', () => viewer.centerSelected()],
      ['⌖', 'Zoom to it', () => viewer.frameSelection(), 'F'],
      null,
      ['🗑', count > 1 ? `Delete ${count} models` : 'Delete', () => viewer.removeSelected(), 'Del', 'danger'],
    ]
    : [
      ['📂', 'Open model', openPicker, 'Ctrl+O'],
      ...(viewer.models.length ? [
        ['▣', 'Select all', () => viewer.selectAll(), 'Ctrl+A'],
        ['▦', 'Arrange all', () => viewer.arrangeAll(), 'Ctrl+R'],
      ] : []),
    ];
  menu.innerHTML = '';
  for (const item of items) {
    if (!item) {
      menu.append(el('hr'));
      continue;
    }
    const [icon, label, run, keys, cls] = item;
    const b = el('button', { type: 'button', role: 'menuitem', class: cls });
    b.append(el('span', { class: 'ctx-icon', 'aria-hidden': 'true' }, icon), el('span', {}, label));
    if (keys) b.append(el('span', { class: 'ctx-key' }, keys));
    b.addEventListener('click', () => {
      closeMenu();
      run();
    });
    menu.append(b);
  }
  menu.hidden = false;
  // Keep it on screen: open up or left of the pointer when there is no room.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, x + r.width > innerWidth - 4 ? x - r.width : x)}px`;
  menu.style.top = `${Math.max(4, y + r.height > innerHeight - 4 ? y - r.height : y)}px`;
  menu.querySelector('button').focus({ preventScroll: true });
}

viewer.addEventListener('menu', (e) => openMenu(e.detail));
menu.addEventListener('keydown', (e) => {
  const buttons = [...menu.querySelectorAll('button')];
  const i = buttons.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    closeMenu();
  }
  e.stopPropagation(); // plate shortcuts (Delete, Escape, arrows) wait while the menu is open
});
// Escape closes it even when focus has wandered off it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || menu.hidden) return;
  e.stopPropagation();
  closeMenu();
}, true);
// Any press outside the menu, scrolling, resizing or leaving the page closes it.
window.addEventListener('pointerdown', (e) => {
  if (!menu.contains(e.target)) closeMenu();
}, true);
window.addEventListener('resize', closeMenu);
window.addEventListener('blur', closeMenu);
document.addEventListener('wheel', closeMenu, { passive: true, capture: true });

// ---- Views ------------------------------------------------------------------------------------

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => (b.dataset.view === 'frame' ? viewer.frameSelection() : viewer.setView(b.dataset.view)));
}

// ---- Action card (bottom right): name, Slice, result ------------------------------------------

function studentName() {
  try {
    return localStorage.getItem(STORE_NAME) ?? '';
  } catch {
    return '';
  }
}

// The student's own name for the file ('' = use "name-model"). Kept until the plate is emptied.
let customFileName = '';

function fileName() {
  return gcodeFileName(customFileName, studentName(), viewer.models[0]?.name ?? 'model');
}

// What the plate is called: the first model's file name (parts split from one file keep it).
function plateName() {
  const m = viewer.models[0];
  return m ? (m.fileBase ?? m.name) : 'model';
}

function defaultFileName() {
  return gcodeFileName('', studentName(), plateName()).replace(/\.gcode$/, '');
}

function renderAction() {
  const card = $('#action');
  const models = viewer.models;
  const outside = models.filter((m) => m.outside);
  card.innerHTML = '';

  if (stage === 'preview' && previewSource?.kind === 'file') {
    const p = el('p', { class: 'action-empty' });
    p.append('Previewing ', el('strong', {}, previewSource.name), ' from this computer. It is not changed.');
    card.append(p);
    const back = el('button', { type: 'button', class: 'wide' }, '← Back to Prepare');
    back.addEventListener('click', () => setStage('prepare'));
    card.append(back);
    return;
  }

  if (!models.length) {
    card.innerHTML = `<p class="action-empty">Open a model to start.</p>`;
    card.append(el('button', { type: 'button', class: 'primary big wide', disabled: '' }, 'Slice'));
    return;
  }

  // Name → file name and the message on the printer screen.
  const nameRow = el('label', { class: 'name-field' });
  nameRow.append(el('span', {}, 'Your name'));
  const input = el('input', { type: 'text', maxlength: LIMITS.maxNameLength, placeholder: 'First name', autocomplete: 'given-name', spellcheck: 'false' });
  input.value = studentName();
  input.addEventListener('input', () => {
    try {
      localStorage.setItem(STORE_NAME, input.value);
    } catch { /* fine */ }
    $('#fileNameInput').placeholder = defaultFileName();
    $('#fileNamePreview').textContent = fileName();
  });
  nameRow.append(input);
  card.append(nameRow);

  // The file name on the SD card: filled in for them, theirs to change.
  const fileRow = el('label', { class: 'name-field file-field' });
  fileRow.append(el('span', {}, 'File name'));
  const fileWrap = el('span', { class: 'file-input' });
  const fileInput = el('input', {
    type: 'text', id: 'fileNameInput', maxlength: LIMITS.maxFileNameLength + 6, placeholder: defaultFileName(),
    spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'fileNamePreview',
  });
  fileInput.value = customFileName;
  fileInput.addEventListener('input', () => {
    customFileName = fileInput.value;
    $('#fileNamePreview').textContent = fileName();
  });
  fileWrap.append(fileInput, el('span', { class: 'file-ext', 'aria-hidden': 'true' }, '.gcode'));
  fileRow.append(fileWrap);
  card.append(fileRow);
  const fn = el('p', { class: 'file-name' });
  fn.innerHTML = `<span aria-hidden="true">💾</span> Saved as <span id="fileNamePreview">${esc(fileName())}</span>`;
  fn.title = 'Letters, numbers and dashes only. Short names are easiest to find on the printer screen.';
  card.append(fn);

  const sum = el('p', { class: 'action-summary' }, summarize(panel.value));
  card.append(sum);
  if (panel.config.maxPrintMinutes) {
    card.append(el('p', { class: 'note' }, `Your teacher's limit: prints up to ${formatMinutes(panel.config.maxPrintMinutes)}.`));
  }

  if (outside.length) {
    const warn = el('p', { class: 'advice warn' });
    warn.textContent = outside.length === 1
      ? `"${outside[0].name}" is ${outside[0].fitProblem}. Move it or make it smaller.`
      : `${outside.length} objects do not fit on the bed. Try "Arrange all" or make them smaller.`;
    card.append(warn);
  }

  if (slice.state === 'slicing') {
    card.append(el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Slicing' }, ''));
    // Supported models can take a minute on the school's slicer: show that it is still working.
    const status = el('p', { class: 'note slicing-note' });
    const tick = () => {
      // Waiting for a free slicer (other students' models are ahead): say where in line.
      const line = slice.line;
      if (line?.state === 'waiting') {
        const wait = line.startsInSeconds >= 60 ? `about ${Math.round(line.startsInSeconds / 60)} min` : `about ${Math.max(5, Math.round(line.startsInSeconds / 5) * 5)} s`;
        status.textContent = line.ahead === 0
          ? `You are next in line for the slicer. Starting in ${wait}.`
          : `In line for the slicer: ${line.ahead} ${line.ahead === 1 ? 'model' : 'models'} ahead of you. Starting in ${wait}.`;
        return;
      }
      const s = Math.round((Date.now() - (slice.slicingSince ?? slice.startedAt)) / 1000);
      const usesSupport = panel.value.support !== 'none';
      status.textContent = `Slicing… ${s} s.${s >= 8 && usesSupport ? ' Supports take the longest, up to a minute or two.' : ''}`;
    };
    tick();
    clearInterval(slice.timer);
    slice.timer = setInterval(() => (status.isConnected ? tick() : clearInterval(slice.timer)), 1000);
    card.append(status);
    const cancel = el('button', { type: 'button', class: 'wide' }, 'Cancel');
    cancel.addEventListener('click', () => {
      // Give the place in line to the next student at once.
      if (slice.ticket) fetch(`/api/slice/line?ticket=${slice.ticket}`, { method: 'DELETE' }).catch(() => {});
      sliceAbort?.abort();
    });
    card.append(cancel);
    return;
  }

  if (slice.state === 'done' && slice.notReady) {
    const r = el('div', { class: 'result pending' });
    r.innerHTML = `
      <strong>✓ Settings checked by the server</strong>
      <p>The slicing engine is not connected yet. It is the next thing being built. Soon this button makes
      <code>${esc(slice.fileName ?? fileName())}</code> for the SD card.</p>`;
    card.append(r);
  } else if (slice.state === 'done' && slice.download) {
    const r = el('div', { class: 'result ok' });
    r.innerHTML = `<strong>✓ Ready for the SD card</strong>${slice.stats ? `<p>${esc(slice.stats)}</p>` : ''}`;
    card.append(r);
    const save = el('button', { type: 'button', class: 'primary big wide' }, '💾 Save to SD card');
    save.addEventListener('click', () => downloadResult());
    card.append(save);
    card.append(el('p', { class: 'note' }, 'Save it onto the SD card, then eject the card before you pull it out.'));
    if (panel.config.usbCopy !== false && 'serial' in navigator) card.append(usbBox());
    return;
  } else if (slice.state === 'error') {
    card.append(el('p', { class: 'advice warn' }, slice.message));
  }

  const closed = slicing.engine && !slicing.open;
  if (slicing.engine) {
    card.append(el('p', { class: `slicing-status ${closed ? 'closed' : 'open'}` }, closed
      ? 'Slicing is closed right now. Your teacher opens it during class. You can still set up your model.'
      : `Slicing is open until ${clockTime(slicing.until)}.`));
  }
  const go = el('button', { type: 'button', class: 'primary big wide', disabled: outside.length || closed ? '' : null }, 'Slice');
  go.addEventListener('click', () => runSlice());
  card.append(go);
}

// ---- Copy to the printer over USB ---------------------------------------------------------------

function usbBox() {
  const box = el('div', { class: 'usb-copy', id: 'usbBox' });
  if (usb.state === 'working') {
    box.append(el('p', { class: 'note', id: 'usbStatus' }, usb.status ?? 'Connecting…'));
    const bar = el('progress', { id: 'usbBar', max: '1', value: String(usb.progress ?? 0), class: 'wide' });
    box.append(bar);
    const cancel = el('button', { type: 'button', class: 'wide' }, 'Stop copying');
    cancel.addEventListener('click', () => usbAbort?.abort());
    box.append(cancel);
    return box;
  }
  if (usb.state === 'done') box.append(el('p', { class: 'advice' }, usb.message));
  if (usb.state === 'error') box.append(el('p', { class: 'advice warn' }, usb.message));
  if (usb.details) {
    const d = el('details', { class: 'usb-details' });
    d.append(el('summary', {}, 'Details for Dalton'));
    const pre = el('pre', { class: 'note' }, usb.details);
    pre.style.cssText = 'max-height:14em;overflow:auto;white-space:pre-wrap;font-size:11px';
    const copy = el('button', { type: 'button' }, 'Copy details');
    copy.addEventListener('click', () => navigator.clipboard?.writeText(usb.details).then(() => { copy.textContent = 'Copied'; }, () => {}));
    d.append(pre, copy);
    box.append(d);
  }
  const go = el('button', { type: 'button', class: 'wide' }, '🔌 Copy to printer (USB)');
  go.addEventListener('click', () => copyToPrinter());
  box.append(go);
  box.append(el('p', { class: 'note' }, "Or plug in the printer's USB cable and copy it straight onto the printer's SD card. It does not start the print: your teacher does that on the printer."));
  return box;
}

function paintUsb() {
  const status = $('#usbStatus');
  if (status) status.textContent = usb.status;
  const bar = $('#usbBar');
  if (bar) bar.value = usb.progress ?? 0;
}

async function copyToPrinter() {
  if (!slice.blob || usb.state === 'working') return;
  let lines;
  try {
    lines = cardLines(await slice.blob.text());
  } catch (err) {
    usb = { state: 'error', message: err.message };
    renderAction();
    return;
  }
  let port;
  try {
    port = await navigator.serial.requestPort({});
  } catch {
    return; // no printer picked
  }
  const printer = new PrinterUsb(port);
  usbAbort = new AbortController();
  usb = { state: 'working', status: 'Connecting to the printer… (it restarts, about 5 seconds)', progress: 0 };
  renderAction();
  let name = '';
  try {
    await printer.open();
    usb.status = 'Checking the SD card…';
    paintUsb();
    const card = await printer.cardState();
    if (card.printing) throw new Error('The printer is printing from its SD card right now. Wait until it is done.');
    name = sdName(fileName().replace(/\.gcode$/i, ''), card.files);
    const t0 = Date.now();
    await printer.copy(lines, name, {
      signal: usbAbort.signal,
      onProgress(done, total) {
        const s = (Date.now() - t0) / 1000;
        const rate = s > 2 ? done / s : 0;
        const left = rate ? (total - done) / rate : 0;
        usb.progress = done / total;
        usb.status = `Copying as ${name}: ${Math.round((done / total) * 100)}%`
          + (rate ? `, ${fmt(rate / 1024)} KB/s, about ${left >= 60 ? `${Math.round(left / 60)} min` : `${Math.max(1, Math.round(left))} s`} left` : '');
        paintUsb();
      },
    });
    const s = Math.round((Date.now() - t0) / 1000);
    usb = { state: 'done', message: `✓ Saved on the printer as ${name} (${s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`}). Tell your teacher it is ready to print.` };
    console.info(`USB copy: ${name}, ${lines.length} lines, ${s} s`);
  } catch (err) {
    const half = name ? ` Part of the file may be on the card as ${name}: tell your teacher not to print it.` : '';
    usb = err.name === 'AbortError'
      ? { state: 'error', message: `Stopped.${half}` }
      : { state: 'error', message: `${err.message}${half}`, details: printer.log.join('\n') };
    console.warn('USB copy failed', err, printer.log);
  } finally {
    usbAbort = null;
    await printer.close();
  }
  renderAction();
}

function invalidateSlice() {
  if (usb.state === 'working') return; // never drop the file in the middle of a copy
  usb = { state: 'idle' };
  if (slice.state === 'slicing') sliceAbort?.abort();
  if (slice.url) URL.revokeObjectURL(slice.url);
  slice = { state: 'idle' };
}

async function runSlice() {
  if (!viewer.models.length || viewer.models.some((m) => m.outside)) return;
  const stl = viewer.exportPlateSTL();
  if (stl.byteLength > LIMITS.maxUploadBytes) {
    slice = { state: 'error', message: `Your plate is ${fmt(stl.byteLength / 1048576)} MB. The most is ${fmt(LIMITS.maxUploadBytes / 1048576)} MB. Remove a model or use a simpler file.` };
    renderAction();
    return;
  }
  const form = new FormData();
  form.append('model', new Blob([stl], { type: 'model/stl' }), 'plate.stl');
  form.append('settings', JSON.stringify(panel.value));
  form.append('name', studentName());
  form.append('modelName', plateName());
  form.append('fileName', customFileName);
  // A random id for this browser, only for the slicer's fair-use limit (a school shares one IP).
  let clientId = '';
  try {
    clientId = localStorage.getItem('umm.client') ?? '';
    if (!clientId) localStorage.setItem('umm.client', (clientId = crypto.randomUUID()));
  } catch { /* no storage: the server falls back to the IP */ }
  // The class gate (only when this site has a slicer).
  await refreshSlicing();
  let phrase = '';
  if (slicing.engine) {
    if (!slicing.open) {
      renderAction();
      toast('Slicing is closed right now. Your teacher opens it during class.', { kind: 'warn' });
      return;
    }
    phrase = storedPhrase() || await askPhrase();
    if (!phrase) return;
  }
  sliceAbort = new AbortController();
  // The ticket is this slice's place in the line for the slicer (src/line.js on the server).
  const ticket = crypto.randomUUID();
  slice = { state: 'slicing', startedAt: Date.now(), ticket };
  renderAction();
  watchLine(ticket);
  try {
    const headers = { 'x-slice-ticket': ticket };
    if (clientId) headers['x-client-id'] = clientId;
    if (phrase) headers['x-class-phrase'] = phrase;
    const res = await fetch('/api/slice', { method: 'POST', body: form, signal: sliceAbort.signal, headers });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && !type.includes('json')) {
      // The real thing (Phase 1): G-code comes straight back.
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fileName();
      slice = { state: 'done', download: true, blob, url: URL.createObjectURL(blob), fileName: name, stats: decodeURIComponent(res.headers.get('x-print-summary') ?? '') };
      try {
        const parsed = parseGcode(await blob.text());
        if (parsed.layers.length) showGcode(parsed, { kind: 'slice', name });
      } catch (err) {
        console.error(err); // the file is still there to save; only the preview failed
      }
    } else {
      const body = type.includes('json') ? await res.json() : {};
      if (res.status === 501 && body.error === 'engine_not_ready') {
        slice = { state: 'done', notReady: true, fileName: body.fileName };
      } else if (res.status === 403 && body.error === 'phrase') {
        try {
          sessionStorage.removeItem(STORE_PHRASE);
        } catch { /* fine */ }
        slice = { state: 'idle' };
        sliceAbort = null;
        renderAction();
        if (await askPhrase(body.message)) runSlice();
        return;
      } else if (res.status === 403 && body.error === 'closed') {
        await refreshSlicing();
        slice = { state: 'error', message: body.message };
      } else {
        slice = { state: 'error', message: body.message ?? `The server said no (${res.status}). Try again in a minute.` };
      }
    }
  } catch (err) {
    slice = err.name === 'AbortError'
      ? { state: 'idle' }
      : { state: 'error', message: 'Could not reach the server. Check the Wi-Fi and try again.' };
  }
  sliceAbort = null;
  renderAction();
}

// While a slice runs, ask the server every 2 s where it is in the line. Asking also keeps the
// place: a page that stops asking (tab closed) is dropped so the line moves on.
async function watchLine(ticket) {
  const current = () => slice.state === 'slicing' && slice.ticket === ticket;
  while (current()) {
    try {
      const res = await fetch(`/api/slice/line?ticket=${ticket}`, { cache: 'no-store' });
      const line = res.ok ? await res.json() : null;
      if (!current()) return;
      if (line?.state === 'none') return; // no line on this server (local dev without one)
      if (line?.state !== 'waiting' && slice.line?.state === 'waiting') slice.slicingSince = Date.now();
      slice.line = line;
    } catch { /* Wi-Fi blip: try again next time */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Save the G-code under the name in the File name box (it may have changed since slicing). Chrome
// (Chromebooks too) shows a real save dialog, so the student picks the SD card and sees the name;
// other browsers download it.
async function downloadResult() {
  if (!slice.url) return;
  const name = fileName();
  if (window.showSaveFilePicker && slice.blob) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'G-code for the printer', accept: { 'text/plain': ['.gcode'] } }],
      });
      const out = await handle.createWritable();
      await out.write(slice.blob);
      await out.close();
      toast(`Saved ${handle.name}. Eject the SD card before you pull it out.`, { kind: 'info', timeout: 9000 });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return; // they pressed Cancel
      console.warn('save dialog failed; downloading instead', err);
    }
  }
  const a = el('a', { href: slice.url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---- Wiring -----------------------------------------------------------------------------------

function plateChanged() {
  invalidateSlice();
  const n = viewer.models.length;
  if (!n) customFileName = ''; // a new plate gets a new name
  $('#empty').hidden = n > 0;
  panel.setPlateInfo({ overhangs: viewer.models.reduce((a, m) => a + m.overhangArea, 0), hasModels: n > 0 });
  renderObjects();
  renderAction();
}

viewer.addEventListener('change', () => {
  plateChanged();
  renderTools();
  scheduleSave();
});

// Save the plate in this browser a moment after it stops changing (not mid-drag).
let saveTimer = null;
let restoring = true; // no saving until the saved plate (if any) is back
function scheduleSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (viewer.busy) return scheduleSave();
    savePlate(viewer.snapshot());
  }, 1500);
}
viewer.addEventListener('select', () => {
  renderTools();
  renderObjects();
});
viewer.addEventListener('dragging', () => {
  syncToolPanel();
  renderObjects();
});
// Red parts over the model need supports "everywhere" (viewer.js checkSupport, for the advice).
viewer.addEventListener('supportinfo', (e) => panel.setPlateInfo({ overhangs: e.detail.red, overModel: e.detail.overModel }));
panel.addEventListener('showred', () => viewer.setView('below'));
viewer.addEventListener('layflatpick', () => {
  if (tool === 'rotate') renderTools();
});
// The support angle decides which faces are red. Follow the slider live while it is dragged.
function syncSupportAngle(angle = panel.value.supportAngle) {
  viewer.setSupportAngle(angle);
  panel.setPlateInfo({ overhangs: viewer.models.reduce((a, m) => a + m.overhangArea, 0), hasModels: viewer.models.length > 0 });
}

// Live: repaint only. The panel's advice updates on release, so the slider is not rebuilt mid-drag.
panel.addEventListener('preview', (e) => {
  if ('supportAngle' in e.detail) viewer.setSupportAngle(e.detail.supportAngle);
});
panel.addEventListener('change', () => {
  syncSupportAngle();
  invalidateSlice();
  renderAction();
});
syncSupportAngle();

$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#printerChip').addEventListener('click', () => $('#printerDialog').showModal());

// Keyboard shortcuts, like Cura's. Ignored while typing in a box.
window.addEventListener('keydown', (e) => {
  // Typing = a text box or a list. A focused checkbox or button must not swallow shortcuts; a
  // focused slider keeps its own arrow keys.
  const active = document.activeElement;
  const tag = active?.tagName;
  const inputType = tag === 'INPUT' ? active.type : '';
  const typing = tag === 'SELECT' || tag === 'TEXTAREA' || inputType === 'range'
    || (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(inputType));
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openPicker();
    return;
  }
  if (typing || document.querySelector('dialog[open]')) return;
  if (viewer.busy) return; // mid-drag: finish the drag first
  if (stage === 'preview') {
    if (ctrl) return; // the plate is hidden: no undo, copy or arrange on it from here
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: 10, PageDown: -10 };
    if (e.key in moves) {
      e.preventDefault();
      setLayer(viewer.previewLayer + moves[e.key]);
    } else if (e.key === 'Home') setLayer(0);
    else if (e.key === 'End') setLayer(Infinity);
    else if (e.key === 'Escape') setStage('prepare');
    return;
  }
  const m = viewer.selected;
  const any = viewer.selection.size > 0;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (ctrl && key === 'd') {
    e.preventDefault();
    duplicateSelected();
  } else if (ctrl && key === 'a') {
    e.preventDefault();
    viewer.selectAll();
  } else if (ctrl && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    viewer.arrangeAll();
  } else if (ctrl) {
    return;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    viewer.removeSelected();
  } else if (e.key === 'Escape') {
    if (viewer.layFlatPicking) viewer.startLayFlatPick(false);
    else viewer.select(null);
  } else if (e.key.startsWith('Arrow') && any) {
    // Nudge like Cura: 1 mm, or 10 mm with Shift. Up is toward the back of the bed.
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    viewer.forSelected('move', (sel) => viewer.nudge(sel, d[0], d[1]));
    syncToolPanel();
  } else if (e.key === 't' || e.key === 'T') setTool('move');
  else if (e.key === 's' || e.key === 'S') setTool('scale');
  else if (e.key === 'r' || e.key === 'R') setTool('rotate');
  else if (e.key === 'm' || e.key === 'M') setTool('mirror');
  else if (e.key === 'f' || e.key === 'F') viewer.frameSelection();
});

// ---- Stages: Prepare (plate + settings) and Preview (G-code layers) ------------------------------

function setStage(next) {
  if (next === 'preview' && !viewer.preview) return;
  stage = next;
  viewer.setStage(next);
  document.body.dataset.stage = next;
  for (const b of document.querySelectorAll('.stage[data-stage]')) {
    const on = b.dataset.stage === next;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
  }
  $('#settings').hidden = next === 'preview';
  $('#previewCard').hidden = next !== 'preview';
  if (viewer.layFlatPicking) viewer.startLayFlatPick(false);
  renderPreviewCard();
  renderTools();
  renderAction();
}

for (const b of document.querySelectorAll('.stage[data-stage]')) {
  b.addEventListener('click', () => setStage(b.dataset.stage));
}

function showGcode(parsed, source) {
  viewer.setPreview(parsed);
  previewSource = source;
  const btn = document.querySelector('.stage[data-stage="preview"]');
  btn.disabled = false;
  btn.title = 'See the layers of the sliced file.';
  setStage('preview');
}

function layerLabel() {
  const g = viewer.preview;
  const n = viewer.previewLayer;
  return `Layer ${n + 1} of ${g.layers.length} · ${fmt(g.layers[n], 2)} mm`;
}

function setLayer(n) {
  viewer.setPreviewLayer(n);
  const slider = $('#layerSlider');
  if (slider) {
    slider.value = String(viewer.previewLayer);
    slider.style.setProperty('--pct', `${(viewer.previewLayer / Math.max(1, viewer.preview.layers.length - 1)) * 100}%`);
    $('#layerLabel').textContent = layerLabel();
  }
}

function renderPreviewCard() {
  const card = $('#previewCard');
  const g = viewer.preview;
  if (!g || stage !== 'preview') return;
  card.innerHTML = '';
  const head = el('div', { class: 'settings-head static' });
  head.innerHTML = `<span class="settings-icon" aria-hidden="true">▤</span>
    <span class="settings-title"><strong>Layer preview</strong><span class="settings-summary"></span></span>`;
  head.querySelector('.settings-summary').textContent = previewSource?.name ?? '';
  card.append(head);

  const body = el('div', { class: 'settings-body' });
  const grams = g.filamentG ?? filamentGrams(g.filamentM);
  const stats = el('dl', { class: 'stats' });
  const stat = (label, value) => stats.append(el('dt', {}, label), el('dd', {}, value));
  stat('Print time', g.timeS ? `${formatDuration(g.timeS)} (Cura's guess)` : 'not in the file');
  stat('Filament', g.filamentM ? `${fmt(g.filamentM, 2)} m · about ${fmt(grams)} g` : 'not in the file');
  stat('Layers', `${g.layers.length}${g.layerHeight ? ` · ${fmt(g.layerHeight, 2)} mm each` : ''}`);
  body.append(stats);

  const sliderWrap = el('div', { class: 'slider layer-slider' });
  const label = el('p', { class: 'layer-label', id: 'layerLabel' }, layerLabel());
  const row = el('div', { class: 'layer-row' });
  const down = el('button', { type: 'button', 'aria-label': 'One layer down' }, '▼');
  const slider = el('input', {
    type: 'range', id: 'layerSlider', min: 0, max: g.layers.length - 1, step: 1, value: viewer.previewLayer, 'aria-label': 'Layer',
  });
  const up = el('button', { type: 'button', 'aria-label': 'One layer up' }, '▲');
  slider.addEventListener('input', () => setLayer(Number(slider.value)));
  down.addEventListener('click', () => setLayer(viewer.previewLayer - 1));
  up.addEventListener('click', () => setLayer(viewer.previewLayer + 1));
  row.append(down, slider, up);
  sliderWrap.append(label, row, el('p', { class: 'note' }, 'Drag, or use ↑ ↓ (Shift for 10 at a time).'));
  body.append(sliderWrap);

  const legend = el('div', { class: 'legend' });
  LINE_TYPES.forEach((t, i) => {
    if (!g.types[i].segments.length) return;
    const item = el('label', { class: 'legend-item' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = viewer.previewParts[i]?.lines.visible ?? true;
    cb.addEventListener('change', () => viewer.setPreviewTypeVisible(i, cb.checked));
    const sw = el('span', { class: 'swatch', 'aria-hidden': 'true' });
    sw.style.background = t.color;
    item.append(cb, sw, el('span', {}, t.label));
    legend.append(item);
  });
  body.append(legend);
  body.append(el('p', { class: 'note' }, 'Shows where plastic goes on each layer. Moves without plastic are hidden.'));
  card.append(body);

  const foot = el('div', { class: 'settings-foot' });
  const back = el('button', { type: 'button', class: 'linkbtn' }, '← Back to Prepare');
  back.addEventListener('click', () => setStage('prepare'));
  foot.append(back);
  card.append(foot);
  setLayer(viewer.previewLayer);
}

// The teacher's class setup: which settings are locked, the class defaults, a note. If the
// server cannot be reached the page still works with the school profile (everything open).
fetch('/api/class')
  .then((r) => (r.ok ? r.json() : null))
  .then((config) => {
    if (!config) return;
    panel.setClassConfig(config);
    renderAction(); // the teacher's print-time limit shows there
  })
  .catch(() => {});

// Whether slicing is open, now and every two minutes (the teacher may open or close it).
refreshSlicing().then(() => renderAction());
setInterval(() => {
  const before = JSON.stringify(slicing);
  refreshSlicing().then(() => {
    if (JSON.stringify(slicing) !== before && slice.state !== 'slicing') renderAction();
  });
}, 120_000);

// The settings card stops above the action card, however tall that is right now.
new ResizeObserver(() => {
  $('#stage').style.setProperty('--action-h', `${$('#action').offsetHeight + 12}px`);
}).observe($('#action'));

plateChanged();
viewer.setGizmo(tool === 'rotate' ? 'rotate' : null);
renderTools();

// Bring back the plate from last time (a reloaded or crashed tab).
loadPlate().then((saved) => {
  if (saved && !viewer.models.length) {
    viewer.restore(saved.items);
    for (const m of viewer.models) checkHealth(m, { quiet: true });
    const n = saved.items.length;
    toast(`Your plate from last time is back (${n} object${n === 1 ? '' : 's'}).`, {
      action: () => {
        viewer.clear();
        clearPlate();
      },
      actionLabel: 'Start fresh',
      timeout: 9000,
    });
  }
}).finally(() => {
  restoring = false;
});
