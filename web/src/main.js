// The student page: open a model, set it on the Workhorse bed, pick settings, Slice, save for the
// SD card. The pieces: viewer.js (3D plate), settings-panel.js (print settings), loaders.js
// (STL/OBJ/3MF), shared/settings.js (what may be changed; the Worker checks the same list).

import './style.css';
import { LIMITS, PRINTER, safeNamePart, summarize } from '../../shared/settings.js';
import { $, el, esc, fmt } from './dom.js';
import { ACCEPT, LoadError, loadModelFile, sampleModel } from './loaders.js';
import { SettingsPanel } from './settings-panel.js';
import { initThemeButton, isDark, onThemeChange } from './theme.js';
import { Viewer } from './viewer.js';

const STORE_NAME = 'umm.name';

const viewer = new Viewer($('#viewport'), PRINTER);
const panel = new SettingsPanel($('#settings'), $('#hint'));

let tool = 'move';
let slice = { state: 'idle' }; // idle | slicing | done | error
let sliceAbort = null;

initThemeButton($('#theme'));
viewer.setTheme(isDark() ? 'dark' : 'light');
onThemeChange(() => viewer.setTheme(isDark() ? 'dark' : 'light'));

// ---- Toasts -----------------------------------------------------------------------------------

function toast(message, { kind = 'info', action, actionLabel, timeout = 6000 } = {}) {
  const t = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' });
  t.append(el('span', {}, message));
  if (action) {
    const b = el('button', { type: 'button', class: 'toast-action' }, actionLabel);
    b.addEventListener('click', () => {
      action();
      t.remove();
    });
    t.append(b);
  }
  const x = el('button', { type: 'button', class: 'toast-x', 'aria-label': 'Close' }, '×');
  x.addEventListener('click', () => t.remove());
  t.append(x);
  $('#toasts').append(t);
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

async function loadFiles(files) {
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
      if (positions.length / 9 > LIMITS.maxTriangles) {
        throw new LoadError(`"${file.name}" has ${fmt(positions.length / 9)} triangles. The most is ${fmt(LIMITS.maxTriangles)}. Export it with lower detail.`);
      }
      const model = viewer.addModel(name, positions);
      checkUnits(model);
    } catch (err) {
      toast(err instanceof LoadError ? err.message : `Could not open "${file.name}".`, { kind: 'error', timeout: 10000 });
      if (!(err instanceof LoadError)) console.error(err);
    }
  }
  busy(null);
}

// A model made in inches shows up 25.4 times too small; one made in the wrong units can also be
// huge. Offer the fix instead of guessing.
function checkUnits(model) {
  const s = model.size;
  const biggest = Math.max(s.x, s.y, s.z);
  if (biggest < 8) {
    toast(`"${model.name}" is tiny (${fmt(biggest, 1)} mm). Was it made in inches?`, {
      action: () => {
        viewer.setScale(model, 2540, 2540, 2540);
        viewer.placeFree(model);
        viewer.changed();
      },
      actionLabel: 'Make it ×25.4',
      timeout: 15000,
    });
  } else if (!viewer.checkFit(model)) {
    toast(`"${model.name}" is bigger than the printer.`, {
      kind: 'warn',
      action: () => viewer.scaleToFit(model),
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
  if (!viewer.selected && viewer.models.length === 1) viewer.select(viewer.models[0]);
  renderTools();
}

for (const b of document.querySelectorAll('.tool[data-tool]')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}
$('#dupBtn').addEventListener('click', () => viewer.duplicate(viewer.selected));
$('#delBtn').addEventListener('click', () => viewer.remove(viewer.selected));

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

function renderTools() {
  const m = viewer.selected;
  for (const b of document.querySelectorAll('.tool[data-tool]')) {
    b.classList.toggle('on', b.dataset.tool === tool && !!m);
    b.disabled = !m;
  }
  $('#dupBtn').disabled = !m;
  $('#delBtn').disabled = !m;

  const p = $('#toolPanel');
  p.hidden = !m;
  if (!m) return;
  p.innerHTML = '';
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
    p.append(el('p', { class: 'note' }, 'Lay flat: click the side of your model that should touch the bed.'));
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
  toast(`Cleared ${removed} object${removed === 1 ? '' : 's'}.`);
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
    const li = el('li', { class: `${m === viewer.selected ? 'on' : ''} ${m.outside ? 'bad' : ''}` });
    const b = el('button', { type: 'button', title: m.outside ? `This model is ${m.fitProblem}.` : m.name });
    b.innerHTML = `<span class="obj-name">${m.outside ? '⚠ ' : ''}${esc(m.name)}</span><span class="obj-size">${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm</span>`;
    b.addEventListener('click', () => viewer.select(m));
    li.append(b);
    list.append(li);
  }
}

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

function fileName() {
  const model = viewer.models[0]?.name ?? 'model';
  const who = safeNamePart(studentName(), '');
  const what = safeNamePart(model, 'model');
  return `${who ? `${who}-` : ''}${what}`.slice(0, 40).replace(/-$/, '') + '.gcode';
}

function renderAction() {
  const card = $('#action');
  const models = viewer.models;
  const outside = models.filter((m) => m.outside);
  card.innerHTML = '';

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
    $('#fileNamePreview').textContent = fileName();
  });
  nameRow.append(input);
  card.append(nameRow);
  const fn = el('p', { class: 'file-name' });
  fn.innerHTML = `<span aria-hidden="true">💾</span> <span id="fileNamePreview">${esc(fileName())}</span>`;
  fn.title = 'The file name on the SD card. Your name also shows on the printer screen while it prints.';
  card.append(fn);

  const sum = el('p', { class: 'action-summary' }, summarize(panel.value));
  card.append(sum);

  if (outside.length) {
    const warn = el('p', { class: 'advice warn' });
    warn.textContent = outside.length === 1
      ? `"${outside[0].name}" is ${outside[0].fitProblem}. Move it or make it smaller.`
      : `${outside.length} objects do not fit on the bed. Try "Arrange all" or make them smaller.`;
    card.append(warn);
  }

  if (slice.state === 'slicing') {
    card.append(el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Slicing' }, ''));
    const cancel = el('button', { type: 'button', class: 'wide' }, 'Cancel');
    cancel.addEventListener('click', () => sliceAbort?.abort());
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
    return;
  } else if (slice.state === 'error') {
    card.append(el('p', { class: 'advice warn' }, slice.message));
  }

  const go = el('button', { type: 'button', class: 'primary big wide', disabled: outside.length ? '' : null }, 'Slice');
  go.addEventListener('click', () => runSlice());
  card.append(go);
}

function invalidateSlice() {
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
  form.append('modelName', viewer.models[0].name);
  sliceAbort = new AbortController();
  slice = { state: 'slicing' };
  renderAction();
  try {
    const res = await fetch('/api/slice', { method: 'POST', body: form, signal: sliceAbort.signal });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && !type.includes('json')) {
      // The real thing (Phase 1): G-code comes straight back.
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fileName();
      slice = { state: 'done', download: true, url: URL.createObjectURL(blob), fileName: name, stats: res.headers.get('x-print-summary') };
    } else {
      const body = type.includes('json') ? await res.json() : {};
      if (res.status === 501 && body.error === 'engine_not_ready') {
        slice = { state: 'done', notReady: true, fileName: body.fileName };
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

function downloadResult() {
  if (!slice.url) return;
  const a = el('a', { href: slice.url, download: slice.fileName });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---- Wiring -----------------------------------------------------------------------------------

function plateChanged() {
  invalidateSlice();
  const n = viewer.models.length;
  $('#empty').hidden = n > 0;
  panel.setPlateInfo({ overhangs: viewer.models.reduce((a, m) => a + m.overhangArea, 0), hasModels: n > 0 });
  renderObjects();
  renderAction();
}

viewer.addEventListener('change', () => {
  plateChanged();
  renderTools();
});
viewer.addEventListener('select', () => {
  renderTools();
  renderObjects();
});
viewer.addEventListener('dragging', () => {
  syncToolPanel();
  renderObjects();
});
viewer.addEventListener('layflatpick', () => {
  if (tool === 'rotate') renderTools();
});
panel.addEventListener('change', () => {
  invalidateSlice();
  renderAction();
});

$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#printerChip').addEventListener('click', () => $('#printerDialog').showModal());

// Keyboard shortcuts, like Cura's. Ignored while typing in a box.
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openPicker();
    return;
  }
  if (typing || document.querySelector('dialog[open]')) return;
  const m = viewer.selected;
  if (ctrl && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    viewer.duplicate(m);
  } else if (ctrl && e.key.toLowerCase() === 'r') {
    e.preventDefault();
    viewer.arrangeAll();
  } else if (ctrl) {
    return;
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    viewer.remove(m);
  } else if (e.key === 'Escape') {
    if (viewer.layFlatPicking) viewer.startLayFlatPick(false);
    else viewer.select(null);
  } else if (e.key === 't' || e.key === 'T') setTool('move');
  else if (e.key === 's' || e.key === 'S') setTool('scale');
  else if (e.key === 'r' || e.key === 'R') setTool('rotate');
  else if (e.key === 'm' || e.key === 'M') setTool('mirror');
  else if (e.key === 'f' || e.key === 'F') viewer.frameSelection();
});

// The settings card stops above the action card, however tall that is right now.
new ResizeObserver(() => {
  $('#stage').style.setProperty('--action-h', `${$('#action').offsetHeight + 12}px`);
}).observe($('#action'));

plateChanged();
renderTools();
