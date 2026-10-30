// The student page: open a model, set it on the Workhorse bed, pick settings, Slice, save for the
// SD card. The pieces: viewer.js (3D plate), settings-panel.js (print settings), loaders.js
// (STL/OBJ/3MF), shared/settings.js (what may be changed; the Worker checks the same list).

import './style.css';
import { LIMITS, PRINTER, formatMinutes, gcodeFileName, materialById, summarize } from '../../shared/settings.js';
import { Vector3 } from 'three';
import { $, confirmDialog, el, esc, fmt } from './dom.js';
import { LINE_TYPES, filamentGrams, formatDuration, parseGcode } from './gcode.js';
import {
  DEFAULTS as PICTURE_DEFAULTS, KINDS as PICTURE_KINDS, PICTURE_ACCEPT, gridFor, grayGrid, inkOf, isPicture, picturePlate, plateSize, readPicture, stretch,
} from './image-plate.js';
import { ACCEPT, LoadError, baseName, loadModelFile, sampleModel } from './loaders.js';
import { meshHealth } from './mesh-health.js';
import { closeHolesIfBetter } from './mesh-repair.js';
import { PLANE_DIRS, planeAlong } from './plane-cut.js';
import { PrinterUsb, cardLines, sdName } from './printer-usb.js';
import { clearPlate, loadPlate, savePlate } from './plate-store.js';
import { SettingsPanel } from './settings-panel.js';
import { splitParts } from './split.js';
import { initThemeButton, isDark, onThemeChange } from './theme.js';
import { Viewer } from './viewer.js';

const STORE_NAME = 'umm.name';
const STORE_PHRASE = 'umm.phrase'; // this tab only (sessionStorage), like the sister sites
const PAGE_TITLE = document.title; // a place in line goes in front of it while waiting

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
  dialog.returnValue = ''; // Esc keeps the last value: without this, Esc after an earlier OK slices
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
if (new URLSearchParams(location.search).has('debug')) window.umm = { viewer, panel, servoState: () => servo, cutState: () => cut };

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
fileInput.accept = `${ACCEPT},${PICTURE_ACCEPT}`;
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
  const pictures = files.filter((f) => isPicture(f.name));
  files = files.filter((f) => !gcode.includes(f) && !pictures.includes(f));
  if (gcode.length) await openGcode(gcode.at(-1));
  if (pictures.length) openPicture(pictures.at(-1)); // the dialog waits on top while models load
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
      timeout: 15000,
      ...(openEdges ? { action: () => closeModelHoles(model), actionLabel: 'Close holes' } : {}),
    });
  }, { timeout: 3000 });
}

/** Fill the holes in an opened model (Dalton, 2026-10-28), one Undo step; it never makes things worse. */
function closeModelHoles(model) {
  if (!viewer.models.includes(model)) return;
  const r = closeHolesIfBetter(viewer.modelMm(model));
  if (!r.filled) {
    toast(`Could not close the holes in "${model.name}". Fix it in the program it came from, or export it again.`, { kind: 'warn', timeout: 10000 });
    return;
  }
  const made = viewer.replaceModel(model, r.positions, 'close holes');
  if (!made) return;
  const left = r.openAfter ? ' Some small gaps are still there.' : '';
  toast(`Closed ${r.filled === 1 ? 'a hole' : `${r.filled} holes`} in "${made.name}".${left}`, { kind: r.openAfter ? 'warn' : 'info', timeout: 8000 });
  checkHealth(made, { quiet: true });
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

// ---- Picture to plate (image-plate.js) ----------------------------------------------------------
// A picture becomes a raised or engraved plate, or a lithophane. It makes a new model, so unlike the
// tools above it needs nothing selected.

// kept: each kind's last values, so switching kinds and back keeps what the student typed.
const pic = { file: null, bitmap: null, o: { ...PICTURE_DEFAULTS.raised }, kept: {} };
const picInput = $('#picInput');
picInput.accept = PICTURE_ACCEPT;
picInput.addEventListener('change', () => {
  if (picInput.files[0]) setPicture(picInput.files[0]);
  picInput.value = '';
});
$('#picChoose').addEventListener('click', () => picInput.click());
$('#pictureBtn').addEventListener('click', () => openPicture());
$('#emptyPicture').addEventListener('click', () => openPicture());

function openPicture(file) {
  if (stage === 'preview') setStage('prepare');
  const dialog = $('#pictureDialog');
  renderPicture();
  dialog.returnValue = '';
  if (!dialog.open) dialog.showModal();
  if (file) setPicture(file);
  else $('#picChoose').focus();
}

async function setPicture(file) {
  try {
    const bitmap = await readPicture(file);
    pic.bitmap?.close();
    pic.bitmap = bitmap;
    pic.file = file;
    $('#picName').textContent = file.name;
    refreshPicture();
  } catch (err) {
    $('#picError').hidden = false;
    $('#picError').textContent = err instanceof LoadError ? err.message : `Could not open "${file.name}".`;
  }
}

function renderPicture() {
  const seg = $('#picKind');
  seg.innerHTML = '';
  for (const [kind, k] of Object.entries(PICTURE_KINDS)) {
    const b = button(esc(k.label), () => {
      if (kind === pic.o.kind) return;
      pic.kept[pic.o.kind] = pic.o;
      pic.o = pic.kept[kind] ?? { ...PICTURE_DEFAULTS[kind] };
      renderPicture();
    }, kind === pic.o.kind ? 'on' : '');
    b.setAttribute('aria-pressed', String(kind === pic.o.kind));
    seg.append(b);
  }
  $('#picBlurb').textContent = PICTURE_KINDS[pic.o.kind].blurb;
  const f = $('#picFields');
  f.innerHTML = '';
  const o = pic.o;
  f.append(picNumber('Width', 'width', 10, 250, 1));
  if (o.kind === 'lithophane') {
    f.append(picNumber('Thinnest', 'thin', 0.4, 3), picNumber('Thickest', 'thick', 0.8, 8), picNumber('Frame', 'border', 0, 20));
    f.append(picCheck('Stand it up on a foot (much sharper picture)', 'stand'));
  } else {
    f.append(
      picNumber('Plate', 'base', 0.6, 10),
      picNumber(o.kind === 'raised' ? 'Raised by' : 'Cut depth', 'depth', 0.2, 10),
      picNumber('Border', 'border', 0, 20),
    );
    const style = el('div', { class: 'seg', role: 'group', 'aria-label': 'Picture style' });
    for (const [id, label] of [['shape', 'Sharp shape'], ['shades', 'Shades']]) {
      style.append(button(label, () => {
        o.style = id;
        renderPicture();
      }, o.style === id ? 'on' : ''));
    }
    f.append(style);
    if (o.style === 'shape') {
      const row = el('label', { class: 'pic-row slider-row' });
      const range = el('input', { type: 'range', min: 5, max: 95, step: 1, 'aria-label': 'Dark cut-off' });
      range.value = String(Math.round(o.threshold * 100));
      range.addEventListener('input', () => {
        o.threshold = Number(range.value) / 100;
        refreshPicture();
      });
      row.append(el('span', {}, 'Cut-off'), range);
      f.append(row);
    }
    f.append(picCheck('Swap dark and light', 'swap'));
  }
  refreshPicture();
}

function picNumber(label, key, min, max, step = 0.1) {
  const row = el('label', { class: 'pic-row' });
  const input = el('input', { type: 'number', min, max, step, inputmode: 'decimal' });
  input.value = String(pic.o[key]);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (input.value !== '' && Number.isFinite(v)) pic.o[key] = Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
    input.value = String(pic.o[key]);
    refreshPicture();
  });
  // Enter would press the form's first button (Cancel): take the number instead.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  row.append(el('span', {}, label), input, el('span', { class: 'field-unit' }, 'mm'));
  return row;
}

function picCheck(label, key) {
  const row = el('label', { class: 'check' });
  const box = el('input', { type: 'checkbox' });
  box.checked = !!pic.o[key];
  box.addEventListener('change', () => {
    pic.o[key] = box.checked;
    refreshPicture();
  });
  row.append(box, el('span', {}, label));
  return row;
}

/** Something about the numbers that cannot work, for the student, or null. */
function pictureProblem(o) {
  if (o.kind === 'lithophane') {
    if (o.thick < o.thin + 0.4) return 'Make Thickest at least 0.4 mm more than Thinnest, or the picture will not show.';
    if (o.stand && o.border < 2) return 'Standing up needs a Frame of 2 mm or more: the foot holds the frame.';
  } else if (o.width - 2 * o.border < 5) return 'The border leaves no room for the picture. Make the Border smaller.';
  return null;
}

function refreshPicture() {
  const o = pic.o;
  const size = pic.bitmap ? plateSize(pic.bitmap.width / pic.bitmap.height, o) : null;
  drawPicturePreview();
  const legend = { raised: 'Orange stands up.', engraved: 'Orange is cut in.', lithophane: 'How it looks with a light behind it.' }[o.kind];
  $('#picSize').textContent = size ? `${legend} ${mm(size.x)} × ${mm(size.y)} mm, ${mm(size.z)} mm tall.` : '';
  const bed = viewer.printer.bed;
  const tooBig = size && (size.x > bed.x || size.y > bed.y || size.z > bed.z);
  const error = pictureProblem(o) ?? (tooBig ? `That is bigger than the printer (${bed.x} × ${bed.y} mm). Make the Width smaller.` : null);
  $('#picError').hidden = !error;
  $('#picError').textContent = error ?? '';
  $('#picOk').disabled = !pic.bitmap || !!error;
  $('#picTip').textContent = {
    raised: `Two colours: ask your teacher for a filament-change pause at ${mm(o.base)} mm, where the picture starts.`,
    engraved: 'After printing, fill the cut with paint or a marker so the picture stands out.',
    lithophane: o.stand
      ? 'Print it in white. Ask your teacher about 100% infill so the light comes through evenly.'
      : 'Lying flat prints faster, but the shades come out in steps. Standing up gives a much sharper picture.',
  }[o.kind];
}

/** 80 → "80", 61.53 → "61.5" (fmt would say "80.0"). */
const mm = (n) => String(Math.round(n * 10) / 10);

function hexRgb(color, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

/** The plate face, drawn small: plate grey and orange for raised/engraved, light and dark for a lithophane. */
function drawPicturePreview() {
  const canvas = $('#picPreview');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!pic.bitmap) return;
  const o = pic.o;
  const aspect = pic.bitmap.width / pic.bitmap.height;
  const { W, H } = gridFor(aspect, o);
  const s = Math.min(canvas.width / (W + 2 * o.border), canvas.height / (H + 2 * o.border));
  const pw = Math.max(2, Math.round(W * s)), ph = Math.max(2, Math.round(H * s));
  const bx = Math.round(o.border * s), by = Math.round(o.border * s);
  const litho = o.kind === 'lithophane';
  const plate = [184, 191, 200];
  const ink = hexRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent'), [194, 65, 12]);
  const lit = [255, 243, 222], dark = [58, 48, 40];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  ctx.fillStyle = `rgb(${(litho ? dark : plate).join(',')})`;
  ctx.fillRect(0, 0, pw + 2 * bx, ph + 2 * by);
  let gray = grayGrid(pic.bitmap, pw, ph);
  if (litho) gray = stretch(gray);
  const img = ctx.createImageData(pw, ph);
  for (let i = 0; i < gray.length; i++) {
    const c = litho ? mix(lit, dark, inkOf(gray[i], o)) : mix(plate, ink, inkOf(gray[i], o));
    img.data.set([c[0], c[1], c[2], 255], i * 4);
  }
  ctx.putImageData(img, bx, by);
}

$('#pictureDialog').addEventListener('close', () => {
  if ($('#pictureDialog').returnValue === 'ok' && pic.bitmap) makePicturePlate();
});

async function makePicturePlate() {
  if (viewer.models.length >= LIMITS.maxObjects) {
    toast(`That is ${LIMITS.maxObjects} objects already, the most for one plate.`, { kind: 'error' });
    return;
  }
  const o = { ...pic.o };
  busy('Making the plate…');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const aspect = pic.bitmap.width / pic.bitmap.height;
    const { pc, pr } = gridFor(aspect, o);
    const positions = picturePlate(grayGrid(pic.bitmap, pc, pr), pc, pr, o, aspect);
    const plateTris = viewer.models.reduce((n, m) => n + m.triangles, 0);
    if (plateTris + positions.length / 9 > LIMITS.maxTriangles) {
      throw new LoadError(`With this plate there would be too much detail to slice (the most is ${fmt(LIMITS.maxTriangles)} triangles). Remove a model first.`);
    }
    const model = viewer.addModel(`${baseName(pic.file.name)}-${PICTURE_KINDS[o.kind].name}`, positions);
    viewer.select(model);
    if (!viewer.checkFit(model)) checkUnits(model);
  } catch (err) {
    toast(err instanceof LoadError ? err.message : 'Could not make a plate from that picture.', { kind: 'error', timeout: 10000 });
    if (!(err instanceof LoadError)) console.error(err);
  } finally {
    busy(null);
  }
}

// ---- Tools (left bar) and their panel ---------------------------------------------------------

function setTool(name) {
  tool = name;
  if (viewer.layFlatPicking) viewer.startLayFlatPick(false);
  if (!viewer.selection.size && viewer.models.length === 1) viewer.select(viewer.models[0]);
  viewer.setGizmo(tool === 'rotate' ? 'rotate' : null);
  renderTools();
  if (tool === 'servo' && !servo && viewer.selection.size === 1) startServo();
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
  p.append(splitPicker());
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
  if (cut && (count !== 1 || m !== cut.model || !viewer.models.includes(cut.model))) {
    cut = null; // picked something else: the planes go
    viewer.setCutPlanes(null);
  }
  // picked something else, or another tool (a turn or scale would leave the servo's spot behind)
  if (servo && (count !== 1 || m !== servo.model || !viewer.models.includes(servo.model) || tool !== servo.tool)) {
    servo = null;
    viewer.setGhost(null);
  }
  p.hidden = !count;
  if (!count) return;
  p.innerHTML = '';
  if (cut) {
    renderCutPanel(p, m);
    return;
  }
  if (servo) {
    renderServoPanel(p, m);
    return;
  }
  if (count > 1 || !m) {
    renderGroupPanel(p);
    return;
  }
  const title = el('div', { class: 'tp-title' });
  title.innerHTML = `<strong>${esc({ move: 'Move', scale: 'Scale', rotate: 'Rotate', mirror: 'Mirror', split: 'Split', servo: 'Servo (9 g)' }[tool])}</strong><span class="tp-model">${esc(m.name)}</span>`;
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

  // Split and Servo have their own buttons on the left (Dalton, 2026-10-28), not a corner of Move.
  if (tool === 'split') {
    for (const [v, label, run] of [
      ['parts', '✂ Separate parts <small>(space between them)</small>', () => splitSelected()],
      ['loose', '✂ Every loose piece <small>(even touching)</small>', () => splitSelected({ loose: true })],
      ['plane', '▤ By a plane… <small>(cut in two or more)</small>', () => startCut()],
    ]) {
      const b = button(label, run, 'wide');
      b.dataset.split = v;
      p.append(b);
    }
    p.append(el('p', { class: 'note' }, 'Separate parts pulls apart things with space between them. Every loose piece also splits shapes that touch. By a plane cuts through the model where you put the plane; each piece gets its cut face filled.'));
  }
  if (tool === 'servo') {
    p.append(button('⚙ Add a servo (9 g)…', () => startServo(), 'wide'));
    p.append(el('p', { class: 'note' }, 'A pocket, a mount or a horn for the 9 g servo in Arduino kits. Or right-click the model right where it should go.'));
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
        numberField(axis.toUpperCase(), s[axis], (v) => {
          if (!(v > 0)) return;
          // A flat model (0 mm on this axis) cannot be scaled to a size: v / 0 is Infinity.
          if (!(m.size[axis] > 0.0001)) {
            toast(`This model is flat in ${axis.toUpperCase()}, so its ${axis.toUpperCase()} size cannot change.`, { kind: 'warn' });
            renderTools();
            return;
          }
          apply(axis, v / m.size[axis]);
        }, { min: 0.1 }),
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
async function splitSelected({ loose = false } = {}) {
  const list = viewer.selectedList;
  if (!list.length) return;
  busy('Looking for separate parts…');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  let plan;
  try {
    plan = list.map((m) => ({ m, parts: splitParts(m.geometry.attributes.position.array, { keepOverlapping: !loose }) })).filter((p) => p.parts);
  } finally {
    busy(null);
  }
  if (!plan.length) {
    toast(list.length === 1
      ? (loose ? `"${list[0].name}" is all one piece. To cut it apart, use Split → By a plane.` : `"${list[0].name}" is all one piece, so there is nothing to split. (Parts that touch or overlap stay together: try Split → Every loose piece, or By a plane.)`)
      : 'Each of these is all one piece, so there is nothing to split.', { timeout: 8000 });
    return;
  }
  const total = viewer.models.length + plan.reduce((n, p) => n + p.parts.length - 1, 0);
  if (total > LIMITS.maxObjects) {
    toast(`Splitting makes ${total} objects, and the most for one plate is ${LIMITS.maxObjects}. Remove some first, or print this one as it is.`, { kind: 'error', timeout: 10000 });
    return;
  }
  const tris = viewer.models.reduce((n, m) => n + m.triangles, 0)
    + plan.reduce((n, { m, parts }) => n + parts.reduce((k, p) => k + p.positions.length / 9, 0) - m.triangles, 0);
  if (tris > LIMITS.maxTriangles) {
    toast(`Split, the plate would have too much detail to slice (${fmt(tris)} triangles, the most is ${fmt(LIMITS.maxTriangles)}). Remove a model first.`, { kind: 'error', timeout: 10000 });
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


// ---- Split by plane ---------------------------------------------------------------------------
// Dalton, 2026-10-09: big prints in parts. Add flat cut planes (X, Y, Z), see them on the model, then
// Cut: each piece gets its cut face filled (plane-cut.js) so it prints solid. Planes are in bed mm.

let cut = null; // { model, planes: [{ axis, at, tiltU, tiltV, du, dv, w, h }], active } while a split by plane is being set up
// (active: the plane the rings are on, and the one "Plane along this face" moves)
const AXIS_K = { x: 0, y: 1, z: 2 };
const AXIS_LABEL = { x: 'X (left | right)', y: 'Y (front | back)', z: 'Z (flat)' };

function startCut(axis = 'z', at = null, point = null) {
  const m = viewer.selected;
  if (!m || viewer.selection.size !== 1) {
    toast('Click one model first, then split it by plane.');
    return;
  }
  if (servo) {
    servo = null;
    viewer.setGhost(null);
  }
  tool = 'split';
  viewer.setGizmo(null);
  cut = { model: m, planes: [], active: 0 };
  addCutPlane(axis, at, point);
}

/** A plane flat across `axis`, whole, through the model's middle (or through `point`, bed mm). */
function newPlane(axis, at, point = null) {
  const b = viewer.worldBox(cut.model);
  const k = AXIS_K[axis];
  const mid = (b[k] + b[k + 3]) / 2;
  const pl = { axis, at: Math.round((at ?? mid) * 10) / 10, tiltU: 0, tiltV: 0, du: 0, dv: 0, w: null, h: null };
  if (point) { // made smaller later, the plane stays centred where the student clicked
    const [U, V] = PLANE_DIRS[axis];
    pl.du = Math.round((point[U] - (b[AXIS_K[U]] + b[AXIS_K[U] + 3]) / 2) * 10) / 10;
    pl.dv = Math.round((point[V] - (b[AXIS_K[V]] + b[AXIS_K[V] + 3]) / 2) * 10) / 10;
  }
  return pl;
}

function addCutPlane(axis = null, at = null, point = null) {
  if (!cut) return;
  if (cut.planes.length >= 6) {
    toast('Six planes is the most for one cut.');
    return;
  }
  const used = new Set(cut.planes.map((p) => p.axis));
  axis ??= ['z', 'x', 'y'].find((a) => !used.has(a)) ?? 'z';
  cut.planes.push(newPlane(axis, at, point));
  cut.active = cut.planes.length - 1;
  showCut();
}

/** The active plane lies along the face the student right-clicked, through that spot. */
function planeAlongFace(point, normal) {
  if (!cut) return;
  const pl = cut.planes[cut.active];
  Object.assign(pl, planeAlong(normal.toArray(), point.toArray(), viewer.worldBox(cut.model)), { more: true });
  showCut();
}

function showCut() {
  viewer.setCutPlanes(cut?.model ?? null, cut?.planes ?? [], cut?.active);
  renderTools();
}

// The rings on the plane were dragged: show the new tilt in the panel.
viewer.addEventListener('cutplanes', () => {
  if (cut) renderTools();
});

function endCut() {
  if (!cut) return;
  cut = null;
  viewer.setCutPlanes(null);
  renderTools();
}

async function applyCut() {
  if (!cut) return;
  const { model, planes } = cut;
  busy('Cutting…');
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  let result;
  try {
    result = viewer.cutModel(model, planes);
  } finally {
    busy(null);
  }
  const { made, open, missed, mended, triangles } = result;
  if (triangles) {
    // Checked before anything was cut: the plate is as it was.
    toast(`Cut, the plate would have too much detail to slice (${fmt(triangles)} triangles, the most is ${fmt(LIMITS.maxTriangles)}). Remove a model or use fewer planes.`, { kind: 'error', timeout: 10000 });
    return;
  }
  if (!made.length) {
    toast(missed
      ? 'Nothing was cut: a plane only cuts a part it covers all the way across. Make the plane bigger (Tilt and size) so its edge goes round the whole part.'
      : 'The planes miss the model, so nothing was cut. Slide a plane onto the model.', { timeout: 10000 });
    return;
  }
  endCut();
  const entry = viewer.undoStack.at(-1);
  if (viewer.models.length > LIMITS.maxObjects) {
    undo();
    toast(`That makes ${viewer.models.length + made.length - 1} objects, and the most for one plate is ${LIMITS.maxObjects}. Use fewer planes.`, { kind: 'error', timeout: 10000 });
    return;
  }
  for (const m of made) checkHealth(m, { quiet: true });
  const joined = missed ? ` ${missed === 1 ? 'One place' : `${missed} places`} the plane only partly covered stayed joined.` : '';
  const gaps = mended ? ` ${mended === 1 ? 'A gap' : `${mended} gaps`} in the model ${mended === 1 ? 'was' : 'were'} closed too.` : '';
  toast(`Cut into ${made.length} pieces. Each has its cut face filled, so it prints solid.${joined}${gaps}${open ?' Part of the cut could not be closed (the model has holes there): check the pieces.' : ''}`, {
    kind: open ? 'warn' : 'info',
    timeout: open ? 12000 : 6000,
    action: () => {
      if (viewer.undoStack.at(-1) === entry) undo();
      else toast('Something else changed since then. Use the Undo button to step back.', { key: 'history' });
    },
    actionLabel: 'Undo',
    key: 'history',
  });
}

function renderCutPanel(p, m) {
  const title = el('div', { class: 'tp-title' });
  title.innerHTML = `<strong>Split by plane</strong><span class="tp-model">${esc(m.name)}</span>`;
  p.append(title);
  const b = viewer.worldBox(m);
  // big enough for any tilt: sizes up to this are "whole", slides go half of it each way
  const diag = Math.ceil(Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) + 12);
  cut.planes.forEach((pl, i) => {
    const k = AXIS_K[pl.axis];
    const [lo, hi] = [b[k], b[k + 3]];
    const row = el('div', { class: `cutrow${i === cut.active && cut.planes.length > 1 ? ' active' : ''}` });
    // working on a plane moves the rings to it (no re-build: that would steal the focus)
    const pick = () => {
      if (cut.active === i) return;
      cut.active = i;
      for (const [j, r] of [...p.querySelectorAll('.cutrow')].entries()) r.classList.toggle('active', j === i);
      viewer.setCutPlanes(cut.model, cut.planes, cut.active);
    };
    row.addEventListener('focusin', pick);
    row.addEventListener('pointerdown', pick);
    const axis = el('select', { 'aria-label': `Plane ${i + 1} direction` });
    for (const a of ['x', 'y', 'z']) axis.append(new Option(AXIS_LABEL[a], a, false, a === pl.axis));
    axis.addEventListener('change', () => {
      Object.assign(pl, newPlane(axis.value, null), { more: pl.more });
      showCut();
    });
    const num = el('input', { type: 'number', step: 0.5, inputmode: 'decimal', 'aria-label': `Plane ${i + 1} position in mm` });
    num.value = String(pl.at);
    const range = el('input', { type: 'range', min: lo.toFixed(1), max: hi.toFixed(1), step: 0.1, 'aria-label': `Plane ${i + 1} position` });
    range.value = String(pl.at);
    range.addEventListener('input', () => {
      pl.at = Number(range.value);
      num.value = String(pl.at);
      viewer.setCutPlanes(cut.model, cut.planes, cut.active);
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (Number.isFinite(v)) pl.at = Math.round(v * 10) / 10;
      range.value = String(pl.at);
      viewer.setCutPlanes(cut.model, cut.planes, cut.active);
    });
    const rm = button('✕', () => {
      cut.planes.splice(i, 1);
      cut.active = Math.min(cut.active, cut.planes.length - 1);
      if (cut.planes.length) showCut();
      else endCut();
    }, 'iconbtn');
    rm.title = 'Remove this plane';
    row.append(axis, num, el('span', { class: 'unit' }, 'mm'), rm, range, cutMore(pl, i, diag));
    p.append(row);
  });
  p.append(button('＋ Add a plane', () => addCutPlane(), 'wide'));
  const go = el('div', { class: 'btn-row stick' }); // stays in sight however long the panel gets
  go.append(button('✂ Cut', applyCut, 'primary'), button('Cancel', endCut));
  p.append(go);
  p.append(el('p', { class: 'note' }, 'X cuts left from right, Y front from back, Z is a flat cut at a height above the bed. Every piece gets its cut face filled, so it prints solid; glue them after. Right-click the model to add a plane right where you click.'));
  p.append(el('p', { class: 'note tip' }, 'To tilt a plane, drag the coloured rings on it, or right-click a slanted face: Plane along this face. Tilt and size has the exact numbers, and makes a plane smaller so it cuts only the parts it covers all the way across (an arm, an ear).'));
}

/**
 * "Tilt and size" for one plane (Dalton's coworker, 2026-10-28): lean it round its two directions, make
 * it smaller so it cuts only what it covers, and slide it along itself. Sliders plus number boxes.
 */
const RING_COLOUR = { X: 'red', Y: 'green', Z: 'blue' }; // the rotate rings' colours

function cutMore(pl, i, diag) {
  const [U, V] = PLANE_DIRS[pl.axis].map((a) => a.toUpperCase());
  const box = el('details', { class: 'cutmore' });
  box.open = Boolean(pl.more);
  box.addEventListener('toggle', () => { pl.more = box.open; });
  box.append(el('summary', {}, 'Tilt and size'));
  const ctl = (label, { min, max, step, unit, get, set, whole = false, aria = label }) => {
    const name = `Plane ${i + 1} ${aria.toLowerCase()}`;
    const range = el('input', { type: 'range', min, max, step, 'aria-label': name });
    const num = el('input', { type: 'number', min, max, step, inputmode: 'decimal', 'aria-label': `${name}, number` });
    const tag = el('span', { class: 'unit' });
    const show = () => {
      const v = get() ?? max;
      range.value = String(v);
      num.value = String(v);
      tag.textContent = whole && get() == null ? `${unit} (whole)` : unit;
    };
    const put = (raw) => {
      const v = Math.round(Math.min(max, Math.max(min, Number(raw))) * 10) / 10;
      if (Number.isFinite(v)) set(whole && v >= max ? null : v);
      show();
      viewer.setCutPlanes(cut.model, cut.planes, cut.active);
    };
    range.addEventListener('input', () => put(range.value));
    num.addEventListener('change', () => put(num.value));
    show();
    const line = el('div', { class: 'cutctl' });
    line.append(el('span', { class: 'sub-label' }, label), range, num, tag);
    return line;
  };
  const half = Math.round(diag / 2);
  // A plane may be much bigger than the model (Dalton, 2026-10-28): up to 300 mm (past the 280 mm bed)
  // or twice the model, whichever is more. The top of the slider is "whole" (no edge at all).
  const biggest = Math.max(300, 2 * diag);
  box.append(
    ctl(`Tilt round ${U} (${RING_COLOUR[U]} ring)`, { aria: `Tilt round ${U}`, min: -80, max: 80, step: 1, unit: '°', get: () => pl.tiltU, set: (v) => { pl.tiltU = v; } }),
    ctl(`Tilt round ${V} (${RING_COLOUR[V]} ring)`, { aria: `Tilt round ${V}`, min: -80, max: 80, step: 1, unit: '°', get: () => pl.tiltV, set: (v) => { pl.tiltV = v; } }),
    ctl(`Size along ${U}`, { min: 2, max: biggest, step: 1, unit: 'mm', whole: true, get: () => pl.w, set: (v) => { pl.w = v; } }),
    ctl(`Size along ${V}`, { min: 2, max: biggest, step: 1, unit: 'mm', whole: true, get: () => pl.h, set: (v) => { pl.h = v; } }),
    ctl(`Slide along ${U}`, { min: -half, max: half, step: 0.5, unit: 'mm', get: () => pl.du, set: (v) => { pl.du = v; } }),
    ctl(`Slide along ${V}`, { min: -half, max: half, step: 0.5, unit: 'mm', get: () => pl.dv, set: (v) => { pl.dv = v; } }),
    button('Flat and whole again', () => {
      Object.assign(pl, { tiltU: 0, tiltV: 0, du: 0, dv: 0, w: null, h: null });
      showCut();
    }, 'wide'),
  );
  return box;
}

/** The split choices, as one dropdown (Dalton 2026-10-09). */
function splitPicker() {
  const s = el('select', { class: 'splitpick', 'aria-label': 'Split' });
  s.append(new Option('✂ Split…', '', true, true));
  s.options[0].disabled = true;
  s.append(new Option('Separate parts (space between them)', 'parts'));
  s.append(new Option('Every loose piece (even touching)', 'loose'));
  if (viewer.selection.size === 1) s.append(new Option('By a plane… (cut in two or more)', 'plane'));
  s.addEventListener('change', () => {
    const v = s.value;
    s.selectedIndex = 0;
    if (v === 'parts') splitSelected();
    else if (v === 'loose') splitSelected({ loose: true });
    else if (v === 'plane') startCut();
  });
  return s;
}

// ---- Servo pocket or mount (csg-tools.js) -----------------------------------------------------
// Dalton, 2026-10-28: a place for an Arduino kit's 9 g servo (SG90 / MG90S). Pocket: sunk into the
// model. Mount: a block on the surface with the pocket in its top, for thin parts. The CSG library is
// only loaded when a student asks for a servo, so the page stays light.

let csg = null; // csg-tools.js, once loaded
let servo = null; // { model, at, normal (model mm, bed frame), kind: 'pocket' | 'mount', spin } while placing one

// Which side of the model the servo goes on (Dalton, 2026-10-28: not just the top), as the
// direction it faces out. Front is -Y, the side nearest the "FRONT" on the floor.
const SERVO_SIDES = {
  top: ['Top', [0, 0, 1]],
  bottom: ['Bottom', [0, 0, -1]],
  front: ['Front', [0, -1, 0]],
  back: ['Back', [0, 1, 0]],
  left: ['Left', [-1, 0, 0]],
  right: ['Right', [1, 0, 0]],
};

/** Two directions along a face that faces `n`: left-right first, then up-down (or front-back on top). */
function faceDirs(n) {
  if (Math.abs(n.z) > 0.9) return [new Vector3(1, 0, 0), new Vector3(0, 1, 0)];
  const across = new Vector3(0, 0, 1).cross(n).normalize();
  return [across, n.clone().cross(across).normalize()];
}

/**
 * Where the servo sits for its side (or clicked spot) and slides: a ray from outside the model
 * toward that side, moved du / dv mm along the face. Sets servo.at and servo.normal; false on a miss.
 */
function aimServo() {
  const m = servo.model;
  const b = viewer.worldBox(m);
  let n, origin;
  if (servo.side === 'spot') {
    n = servo.spot.normal.clone();
    origin = servo.spot.at.clone().add(new Vector3(m.position.x, m.position.y, 0)).addScaledVector(n, 2);
  } else {
    n = new Vector3(...SERVO_SIDES[servo.side][1]);
    const far = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) + 20;
    origin = new Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2).addScaledVector(n, far);
  }
  const [a, c] = faceDirs(n);
  origin.addScaledVector(a, servo.du).addScaledVector(c, servo.dv);
  const hit = viewer.surfaceAt(m, origin, n.clone().negate());
  if (!hit) return false;
  servo.at = viewer.toModelMm(m, hit.point);
  servo.normal = hit.normal.clone().normalize();
  return true;
}

/**
 * The middle of that side missed (an L shape, a ring): the nearest spot on a 5 mm grid that hits the
 * model instead, so a side button never just does nothing.
 */
function aimNearest() {
  const b = viewer.worldBox(servo.model);
  const reach = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  const spots = [];
  for (let du = -reach; du <= reach; du += 5) for (let dv = -reach; dv <= reach; dv += 5) spots.push([du, dv]);
  spots.sort((p, q) => Math.hypot(...p) - Math.hypot(...q));
  for (const [du, dv] of spots) {
    Object.assign(servo, { du: Math.round(du * 2) / 2, dv: Math.round(dv * 2) / 2 });
    if (aimServo()) return true;
  }
  return false;
}

async function startServo(point = null, normal = null) {
  const m = viewer.selected;
  if (!m || viewer.selection.size !== 1) {
    toast('Click one model first, then add a servo to it.');
    return;
  }
  if (!csg) {
    busy('Loading…');
    try {
      csg = await import('./csg-tools.js');
    } catch {
      toast('Could not load the servo tool. Check the Wi-Fi and try again.', { kind: 'error' });
      return;
    } finally {
      busy(null);
    }
  }
  if (cut) endCut();
  tool = 'servo';
  viewer.setGizmo(null);
  const spot = point && normal ? { at: viewer.toModelMm(m, point), normal: normal.clone().normalize() } : null;
  servo = {
    model: m, tool, kind: servo?.kind ?? 'pocket', spin: servo?.spin ?? 0, fit: servo?.fit ?? 'normal',
    horn: servo?.horn ?? 'double', arm: servo?.arm ?? 16, through: servo?.through ?? true, closeIn: servo?.closeIn ?? true,
    side: spot ? 'spot' : 'top', spot, du: 0, dv: 0, at: null, normal: null,
  };
  if (!aimServo()) { // e.g. a ring: nothing straight down through its middle
    servo = null;
    toast('Right-click the model where the servo should go.');
    renderTools();
    return;
  }
  renderTools();
}

function endServo() {
  if (!servo) return;
  servo = null;
  viewer.setGhost(null);
  renderTools();
}

/** The solids for the servo as it is set up now: { adds, cuts }. */
/**
 * Is the spot right for the cut? `thin`: the model is not as thick as the cut is deep (it would break
 * through, or into a hollow); `hangs`: part of it is off the edge of the face. Raycasts, so it runs
 * when a slider is let go, not on every step.
 */
function servoCheck() {
  const m = servo.model;
  const off = new Vector3(m.position.x, m.position.y, 0);
  const clearance = csg.FITS[servo.fit];
  const horn = servo.kind === 'horn';
  const depth = viewer.depthAt(m, servo.at.clone().add(off), servo.normal);
  const need = horn ? csg.hornDepth(clearance) + 2 : csg.servoDepth({ ...csg.SERVO_9G, clearance }) + 1;
  const outline = csg.cutOutline(servo.at, servo.normal, servo.spin, { kind: servo.kind, horn: servo.horn, armLength: servo.horn === 'round' ? null : servo.arm, clearance });
  const down = servo.normal.clone().negate();
  const hangs = outline.some((p) => {
    const hit = viewer.surfaceAt(m, p.clone().add(off).addScaledVector(servo.normal, 3), down);
    return !hit || hit.distance > 4.5; // nothing under that point near the face: off the edge
  });
  return { depth, need, thin: servo.kind !== 'mount' && depth < need, hangs };
}

function servoSolids() {
  const { at, normal, kind, spin } = servo;
  const clearance = csg.FITS[servo.fit];
  const s = { ...csg.SERVO_9G, clearance };
  // too thin or hollow there: walls round the cut first, so it stays closed in (Dalton, 2026-10-28)
  const walls = servo.closeIn && servo.check?.thin;
  if (kind === 'horn') {
    // the middle hole just comes out of the far side (a hole 400 mm long would show past the bed)
    const m = servo.model;
    const depth = viewer.depthAt(m, at.clone().add(new Vector3(m.position.x, m.position.y, 0)), normal);
    const throughDepth = Number.isFinite(depth) ? depth + 2 : 400;
    const horn = { kind: servo.horn, armLength: servo.horn === 'round' ? null : servo.arm, through: servo.through, throughDepth, clearance };
    return { adds: walls ? [csg.hornSleeve(at, normal, spin, horn)] : [], cuts: csg.hornPocket(at, normal, spin, horn) };
  }
  if (kind === 'mount') return csg.servoMount(at, normal, spin, s);
  return { adds: walls ? [csg.servoSleeve(at, normal, spin, s)] : [], cuts: csg.servoPocket(at, normal, spin, s) };
}

const SERVO_DONE = {
  pocket: ['Cutting the servo pocket…', 'servo pocket', 'Servo pocket cut. A 9 g servo (SG90 or MG90S) pushes in; two small screws hold it.'],
  mount: ['Adding the servo mount…', 'servo mount', 'Servo mount added. A 9 g servo (SG90 or MG90S) pushes in; two small screws hold it.'],
  horn: ['Cutting the horn pocket…', 'horn pocket', 'Horn pocket cut. Press the horn in, flat side first; its small screws go in the pilot holes, and the middle hole lets the servo screw through.'],
};

function showServoGhost() {
  const { adds, cuts } = servoSolids();
  const m = servo.model;
  // the spin ring: round the servo (or horn), on the face
  const reach = servo.kind === 'horn' ? (servo.horn === 'round' ? 10.5 : servo.arm) : 17;
  const center = servo.at.clone().add(new Vector3(m.position.x, m.position.y, 0));
  viewer.setGhost(m, [...adds, ...cuts], { center, normal: servo.normal, radius: reach + 6 });
}

// Grabbing the see-through servo and dragging it (Tinkercad style): it goes where the pointer is,
// on whichever face; the spin ring turns it. Checks (thickness, edges) run when it is let go.
viewer.addEventListener('servomove', (e) => {
  if (!servo) return;
  const { point, normal } = e.detail;
  Object.assign(servo, { side: 'spot', spot: { at: viewer.toModelMm(servo.model, point), normal: normal.clone().normalize() }, du: 0, dv: 0 });
  if (aimServo()) showServoGhost();
});
viewer.addEventListener('servospin', (e) => {
  if (!servo) return;
  servo.spin = (((servo.spin + e.detail.delta) % 360) + 360) % 360;
  showServoGhost();
});
viewer.addEventListener('servodone', () => {
  if (servo) renderTools();
});

async function applyServo() {
  if (!servo) return;
  const { model, kind } = servo;
  busy(SERVO_DONE[kind][0]);
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  let out, mended = 0;
  servo.check = servoCheck();
  const walled = servo.closeIn && servo.check.thin;
  try {
    out = csg.combine(viewer.modelMm(model), servoSolids());
    // a cut can still leave gaps (a model that was never quite closed): fill them when that helps
    const fixed = closeHolesIfBetter(out);
    out = fixed.positions;
    mended = fixed.filled;
  } catch (err) {
    console.error(err);
    toast('The servo could not be added here. Try another spot, or check the model (it may have holes).', { kind: 'error', timeout: 10000 });
    return;
  } finally {
    busy(null);
  }
  const made = viewer.replaceModel(model, out, SERVO_DONE[kind][1]);
  if (!made) {
    toast(`With the servo, the plate would have too much detail to slice (the most is ${fmt(LIMITS.maxTriangles)} triangles). Remove a model first.`, { kind: 'error', timeout: 10000 });
    return;
  }
  servo = null;
  viewer.setGhost(null);
  renderTools();
  const entry = viewer.undoStack.at(-1);
  checkHealth(made, { quiet: true });
  const extra = `${walled ? ' The model is thin there, so walls were added round it.' : ''}${mended ? ` ${mended === 1 ? 'A gap' : `${mended} gaps`} in the model ${mended === 1 ? 'was' : 'were'} closed.` : ''}`;
  toast(SERVO_DONE[kind][2] + extra, {
    timeout: 8000,
    action: () => {
      if (viewer.undoStack.at(-1) === entry) undo();
      else toast('Something else changed since then. Use the Undo button to step back.', { key: 'history' });
    },
    actionLabel: 'Undo',
    key: 'history',
  });
}

function renderServoPanel(p, m) {
  const title = el('div', { class: 'tp-title' });
  title.innerHTML = `<strong>Servo (9 g)</strong><span class="tp-model">${esc(m.name)}</span>`;
  p.append(title);
  const kinds = el('div', { class: 'seg servokind', role: 'group', 'aria-label': 'Servo kind' });
  for (const [k, label] of [['pocket', 'Pocket (sunk in)'], ['mount', 'Mount (block on top)'], ['horn', 'Horn (fix a part to it)']]) {
    const b = button(label, () => {
      servo.kind = k;
      renderTools();
    }, servo.kind === k ? 'on' : '');
    b.setAttribute('aria-pressed', String(servo.kind === k));
    kinds.append(b);
  }
  p.append(kinds);

  // which horn, and how long its arms are (brands differ: measure yours)
  if (servo.kind === 'horn') {
    const horns = el('div', { class: 'seg', role: 'group', 'aria-label': 'Horn shape' });
    for (const [k, label] of [['single', 'One arm'], ['double', 'Two arms'], ['cross', 'Cross'], ['round', 'Round']]) {
      const b = button(label, () => {
        servo.horn = k;
        renderTools();
      }, servo.horn === k ? 'on' : '');
      b.setAttribute('aria-pressed', String(servo.horn === k));
      horns.append(b);
    }
    p.append(horns);
    if (servo.horn !== 'round') {
      const line = el('div', { class: 'cutctl' });
      const range = el('input', { type: 'range', min: 8, max: 25, step: 0.5, 'aria-label': 'Horn arm length' });
      const num = el('input', { type: 'number', min: 8, max: 25, step: 0.5, inputmode: 'decimal', 'aria-label': 'Horn arm length, number' });
      range.value = num.value = String(servo.arm);
      const put = (raw) => {
        const v = Math.round(Math.min(25, Math.max(8, Number(raw))) * 2) / 2;
        if (Number.isFinite(v)) servo.arm = v;
        range.value = num.value = String(servo.arm);
        showServoGhost();
      };
      range.addEventListener('input', () => put(range.value));
      num.addEventListener('change', () => put(num.value));
      for (const e of [range, num]) e.addEventListener('change', () => { showDepth(); showServoGhost(); });
      line.append(el('span', { class: 'sub-label' }, 'Arm length (middle of the horn to the tip)'), range, num, el('span', { class: 'unit' }, 'mm'));
      p.append(line);
    }
    const through = el('label', { class: 'check' });
    const box = el('input', { type: 'checkbox' });
    box.checked = servo.through;
    box.addEventListener('change', () => {
      servo.through = box.checked;
      showServoGhost();
    });
    through.append(box, document.createTextNode(' Hole through the middle, for the servo screw and a screwdriver'));
    p.append(through);
  }

  p.append(el('span', { class: 'sub-label' }, 'Fit'));
  const fits = el('div', { class: 'seg', role: 'group', 'aria-label': 'Fit' });
  for (const [k, label] of [['snug', 'Snug'], ['normal', 'Normal'], ['loose', 'Loose']]) {
    const b = button(label, () => {
      servo.fit = k;
      renderTools();
    }, servo.fit === k ? 'on' : '');
    b.setAttribute('aria-pressed', String(servo.fit === k));
    b.title = `${csg.FITS[k]} mm of room on every side`;
    fits.append(b);
  }
  p.append(fits);

  p.append(el('span', { class: 'sub-label' }, 'Side of the model'));
  const sides = el('div', { class: 'servosides', role: 'group', 'aria-label': 'Side of the model' });
  const choices = Object.entries(SERVO_SIDES).map(([k, [label]]) => [k, label]);
  if (servo.spot) choices.push(['spot', 'Where I clicked']);
  for (const [k, label] of choices) {
    const b = button(label, () => {
      const was = { side: servo.side, du: servo.du, dv: servo.dv };
      Object.assign(servo, { side: k, du: 0, dv: 0 });
      if (!aimServo() && !aimNearest()) {
        Object.assign(servo, was);
        toast(`Nothing to put a servo on from the ${label.toLowerCase()} here. Right-click the model where it should go.`);
      }
      renderTools();
    }, servo.side === k ? 'on' : '');
    b.setAttribute('aria-pressed', String(servo.side === k));
    sides.append(b);
  }
  p.append(sides);

  const depthNote = el('p');
  const edgeNote = el('p', { class: 'advice warn' }, 'Part of it hangs over the edge here, so the cut would break out through the side. Slide it in, or spin it.');
  const showDepth = () => {
    servo.check = servoCheck();
    edgeNote.hidden = !servo.check.hangs;
    depthNote.hidden = servo.kind === 'mount';
    if (depthNote.hidden) return;
    const horn = servo.kind === 'horn';
    const { depth, need, thin } = servo.check;
    const clearance = csg.FITS[servo.fit];
    const thick = Number.isFinite(depth) ? `${fmt(depth, 1)} mm` : 'very';
    depthNote.className = thin && !servo.closeIn ? 'advice warn' : 'note';
    if (thin && servo.closeIn) {
      depthNote.textContent = `Thin here (${thick}, the ${horn ? 'horn pocket' : 'pocket'} needs ${fmt(need, 0)} mm), so walls are added round it behind the surface. It stays closed in.`;
      return;
    }
    depthNote.textContent = horn
      ? (thin
        ? `Too thin here (${thick} thick, a horn pocket needs ${fmt(need, 0)} mm). Pick a thicker spot.`
        : `The model is ${thick} thick here; the horn sits ${fmt(csg.hornDepth(clearance), 1)} mm in.`)
      : (thin
        ? `Too thin here (${thick} thick, a pocket needs ${fmt(need, 0)} mm): it would go right through. Pick a thicker spot, or use Mount.`
        : `The model is ${thick} thick here; the pocket goes ${fmt(need - 1, 0)} mm in.`);
  };
  // slide along the face: re-aimed on every move, so it follows a curved or stepped side
  const box = viewer.worldBox(m);
  const reach = Math.ceil(Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]) / 2);
  for (const [key, label] of [['du', 'Slide ↔'], ['dv', 'Slide ↕']]) {
    const line = el('div', { class: 'cutctl' });
    const range = el('input', { type: 'range', min: -reach, max: reach, step: 0.5, 'aria-label': `Servo ${label.toLowerCase()}` });
    const num = el('input', { type: 'number', min: -reach, max: reach, step: 0.5, inputmode: 'decimal', 'aria-label': `Servo ${label.toLowerCase()}, number` });
    range.value = num.value = String(servo[key]);
    const move = (raw, check = true) => {
      const was = servo[key];
      const v = Math.round(Math.min(reach, Math.max(-reach, Number(raw))) * 2) / 2;
      if (Number.isFinite(v)) servo[key] = v;
      if (!aimServo()) servo[key] = was; // slid off the model: stay at the last spot on it
      range.value = num.value = String(servo[key]);
      if (check) showDepth(); // raycasts: when let go, not on every step (big models, slow laptops)
      showServoGhost();
    };
    range.addEventListener('input', () => move(range.value, false));
    range.addEventListener('change', () => move(range.value));
    num.addEventListener('change', () => move(num.value));
    line.append(el('span', { class: 'sub-label' }, label), range, num, el('span', { class: 'unit' }, 'mm'));
    p.append(line);
  }

  const row = el('div', { class: 'cutctl' });
  const range = el('input', { type: 'range', min: 0, max: 355, step: 5, 'aria-label': 'Servo spin' });
  const num = el('input', { type: 'number', min: 0, max: 355, step: 5, inputmode: 'decimal', 'aria-label': 'Servo spin, number' });
  range.value = num.value = String(servo.spin);
  const put = (raw) => {
    const v = ((Math.round(Number(raw)) % 360) + 360) % 360; // all the way round: 370 is 10
    if (Number.isFinite(v)) servo.spin = v;
    range.value = num.value = String(servo.spin);
    showServoGhost();
  };
  range.addEventListener('input', () => put(range.value));
  num.addEventListener('change', () => put(num.value));
  for (const e of [range, num]) e.addEventListener('change', () => { showDepth(); showServoGhost(); });
  row.append(el('span', { class: 'sub-label' }, 'Spin'), range, num, el('span', { class: 'unit' }, '°'));
  p.append(row);

  if (servo.kind !== 'mount') {
    const walls = el('label', { class: 'check' });
    const tick = el('input', { type: 'checkbox' });
    tick.checked = servo.closeIn;
    tick.addEventListener('change', () => {
      servo.closeIn = tick.checked;
      showDepth();
      showServoGhost();
    });
    walls.append(tick, document.createTextNode(' Close it in: add walls where it would break through (thin or hollow spots)'));
    p.append(walls);
  }
  showDepth();
  p.append(depthNote, edgeNote);
  const go = el('div', { class: 'btn-row stick' }); // stays in sight however long the panel gets
  go.append(button({ pocket: '⚙ Cut pocket', mount: '⚙ Add mount', horn: '⚙ Cut horn pocket' }[servo.kind], applyServo, 'primary'), button('Cancel', endServo));
  p.append(go);
  p.append(el('p', { class: 'note' }, 'For the 9 g micro servo in Arduino kits (SG90 or MG90S). The see-through shape shows what is cut away. It pushes in by hand, two small screws hold it, and a slot lets the wire out.'));
  p.append(el('p', { class: 'note tip' }, 'Grab the see-through servo and drag it onto any face. Drag the orange ring to turn it. Or pick a side and slide it here.'));
  showServoGhost();
}

// ---- Right-click menu on the plate ------------------------------------------------------------

const menu = $('#ctxMenu');

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = '';
}

function openMenu({ model, point, normal, x, y }) {
  const count = viewer.selection.size;
  const here = cut && model === cut.model && point;
  const items = model
    ? [
      ...(servo && model === servo.model && point && normal ? [['⚙', 'Move the servo here', () => startServo(point, normal)], null] : []),
      ...(here ? [
        ...(normal ? [['∠', 'Plane along this face', () => planeAlongFace(point, normal)]] : []),
        ['＋', 'Cut plane here: flat (Z)', () => addCutPlane('z', point.z, point)],
        ['＋', 'Cut plane here: left | right (X)', () => addCutPlane('x', point.x, point)],
        ['＋', 'Cut plane here: front | back (Y)', () => addCutPlane('y', point.y, point)],
        null,
      ] : []),
      ['✂', count > 1 ? 'Split each into separate objects' : 'Split into separate objects', () => splitSelected()],
      ['✂', 'Split every loose piece', () => splitSelected({ loose: true })],
      ...(count === 1 && !cut ? [['▤', 'Split by plane…', () => startCut('z', point?.z ?? null, point ?? null)]] : []),
      ...(count === 1 && !servo && point && normal ? [['⚙', 'Servo here (9 g)…', () => startServo(point, normal)]] : []),
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
  return gcodeFileName(customFileName, studentName(), viewer.models[0]?.name ?? 'model', panel.value.material);
}

// What the plate is called: the first model's file name (parts split from one file keep it).
function plateName() {
  const m = viewer.models[0];
  return m ? (m.fileBase ?? m.name) : 'model';
}

function defaultFileName() {
  return gcodeFileName('', studentName(), plateName(), panel.value.material).replace(/\.gcode$/, '');
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
    // Dalton, 2026-10-29: your place in line, big enough to see from across the room. Only while
    // other students' models are ahead (src/line.js); the tab title says it too, for another tab.
    const place = el('div', { class: 'line-place', role: 'status', hidden: '' });
    const placeBig = el('strong', {});
    const placeSmall = el('span', {});
    place.append(placeBig, placeSmall);
    card.append(place);
    card.append(el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Slicing' }, ''));
    // Supported models can take a minute on the school's slicer: show that it is still working.
    const status = el('p', { class: 'note slicing-note' });
    const show = (node, text) => {
      if (node.textContent !== text) node.textContent = text; // unchanged text is not read out again
    };
    const tick = () => {
      // Waiting for a free slicer (other students' models are ahead): say where in line.
      const line = slice.line;
      if (line?.state === 'waiting') {
        const wait = line.startsInSeconds >= 60 ? `about ${Math.round(line.startsInSeconds / 60)} min` : `about ${Math.max(5, Math.round(line.startsInSeconds / 5) * 5)} s`;
        place.hidden = false;
        show(placeBig, line.ahead === 0 ? 'You are next' : `#${line.ahead + 1} in line`);
        show(placeSmall, line.ahead === 0
          ? `Starting in ${wait}.`
          : `${line.ahead} ${line.ahead === 1 ? 'model' : 'models'} ahead of you. Starting in ${wait}.`);
        show(status, 'Waiting for a free slicer. Keep this tab open: you keep your place.');
        document.title = `(${line.ahead === 0 ? 'Next' : `#${line.ahead + 1}`} in line) ${PAGE_TITLE}`;
        return;
      }
      place.hidden = true;
      document.title = PAGE_TITLE;
      const s = Math.round((Date.now() - (slice.slicingSince ?? slice.startedAt)) / 1000);
      const usesSupport = panel.value.support !== 'none';
      show(status, `Slicing… ${s} s.${s >= 120 ? ' A big plate can take up to 8 minutes. Keep this tab open.' : s >= 8 && usesSupport ? ' Supports take the longest, up to a minute or two.' : ''}`);
    };
    tick();
    slice.tick = tick; // watchLine shows a new place at once, not on the next second
    clearInterval(slice.timer);
    // Each timer stops ITSELF once its card is gone. (It used to stop slice.timer, which by then
    // was the next slice's timer: every slice after the first froze on "Slicing… 0 s".)
    const timer = setInterval(() => {
      if (status.isConnected) return tick();
      clearInterval(timer);
      if (slice.state !== 'slicing') document.title = PAGE_TITLE;
    }, 1000);
    slice.timer = timer;
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
  } else if (slice.state === 'done' && slice.download && slice.stale) {
    // The plate or settings changed during a USB copy: this file is the OLD one. The copy keeps
    // going (stopping it is the student's choice), but it cannot be saved again, and it is
    // dropped when the copy ends (copyToPrinter).
    card.append(el('p', { class: 'advice warn' }, 'Your model or settings changed. This file is the old one, so slice again after the copy.'));
    card.append(usbBox());
    return;
  } else if (slice.state === 'done' && slice.download) {
    const r = el('div', { class: 'result ok' });
    r.innerHTML = `<strong>✓ Ready for the SD card</strong>${slice.stats ? `<p>${esc(slice.stats)}</p>` : ''}${slice.pauses?.text ? `<p>🎨 ${esc(slice.pauses.text)}</p>` : ''}`;
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
  if (!slice.blob || slice.stale || usb.state === 'working') return;
  const blob = slice.blob;
  let lines;
  try {
    lines = cardLines(await blob.text());
  } catch (err) {
    usb = { state: 'error', message: err.message };
    renderAction();
    return;
  }
  // Opening the USB port restarts the Workhorse, which would stop a running print, and nothing can
  // ask the printer before that restart. So the student says it is idle first. Cancel changes nothing.
  if (!(await confirmDialog($('#usbRestartDialog')))) return;
  if (slice.blob !== blob || slice.stale || usb.state === 'working') return; // changed meanwhile
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
  if (slice.stale) {
    // The plate changed during the copy: drop the old file now, but keep the copy's answer.
    const { state, message } = usb;
    invalidateSlice();
    toast(`${message} Your model changed during the copy: slice again for a new file.`, { kind: state === 'error' ? 'warn' : 'info', timeout: 15000 });
  }
  renderAction();
}

// A random id for this browser: the slicer's fair-use limit and the wrong-guess lockout count per
// device (a school shares one IP). No storage: the server falls back to the IP.
function browserId() {
  try {
    let id = localStorage.getItem('umm.client') ?? '';
    if (!id) localStorage.setItem('umm.client', (id = crypto.randomUUID()));
    return id;
  } catch {
    return '';
  }
}

/** "5@25,12.5@60" from the slicer -> words for the result card. */
function pausesDone(header, asked) {
  const done = String(header ?? '').split(',').filter(Boolean).map((p) => p.split('@').map(Number));
  if (!asked.length) return null;
  const list = done.map(([h, layer]) => `${fmt(h)} mm (layer ${layer})`).join(', ');
  const skipped = asked.length - done.length;
  let text = done.length ? `Colour change pause${done.length === 1 ? '' : 's'} at ${list}. The printer stops there so you can change the filament, then waits for the knob.` : '';
  if (skipped > 0) text += `${text ? ' ' : ''}${skipped === 1 ? 'One pause is' : `${skipped} pauses are`} above the top of your model, so ${skipped === 1 ? 'it was' : 'they were'} left out.`;
  return { done, text };
}

// Unlocking the third settings tab: the server checks the password (and counts wrong ones).
panel.addEventListener('armunlock', async (e) => {
  const { key, done } = e.detail;
  try {
    const res = await fetch('/api/arm', { method: 'POST', headers: { 'x-arm-key': key, 'x-client-id': browserId() } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      done();
      panel.unlockArm(key);
      toast('Assistant to the Regional Manager tab unlocked.', { kind: 'info' });
    } else done(body.message ?? `Something went wrong (${res.status}).`);
  } catch {
    done('Could not reach the server. Check the Wi-Fi and try again.');
  }
});

function invalidateSlice() {
  if (usb.state === 'working') {
    // Never drop the file in the middle of a copy, but mark it old: no saving it, and
    // copyToPrinter drops it when the copy ends.
    if (slice.state === 'done') slice.stale = true;
    return;
  }
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
  const clientId = browserId();
  // The "Assistant to the Regional Manager" tab: its extras and password, only when it changes something.
  const arm = panel.armValue;
  if (arm) form.append('arm', JSON.stringify(arm));
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
    if (arm) headers['x-arm-key'] = panel.armKey;
    const res = await fetch('/api/slice', { method: 'POST', body: form, signal: sliceAbort.signal, headers });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && !type.includes('json')) {
      // The real thing (Phase 1): G-code comes straight back.
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fileName();
      slice = {
        state: 'done', download: true, blob, url: URL.createObjectURL(blob), fileName: name, stats: decodeURIComponent(res.headers.get('x-print-summary') ?? ''),
        pauses: pausesDone(res.headers.get('x-pauses-done'), arm?.pauses ?? []),
      };
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
      } else if (res.status === 429 && body.error === 'locked') {
        // Too many wrong phrases from this browser: the server did not even check this one, so
        // keep the stored phrase and do not ask again (no loop). The student waits and presses Slice.
        slice = { state: 'error', message: body.message ?? `Too many wrong tries. Wait ${body.retryAfter ?? 5} seconds and try again.` };
      } else if (res.status === 403 && body.error === 'arm') {
        panel.lockArm(); // wrong or changed password: ask again next time
        slice = { state: 'error', message: body.message };
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
      slice.tick?.();
    } catch { /* Wi-Fi blip: try again next time */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Save the G-code under the name in the File name box (it may have changed since slicing). Chrome
// (Chromebooks too) shows a real save dialog, so the student picks the SD card and sees the name;
// other browsers download it.
async function downloadResult() {
  if (!slice.url || slice.stale) return;
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
// The title-bar chip names the filament this file is for.
function syncMaterialChip() {
  const small = document.querySelector('#printerChip .chip-text small');
  if (small) small.textContent = `SE 0.50 mm · ${materialById(panel.value.material).name.replace(/^Polymaker /, '')}`;
}
panel.addEventListener('change', () => {
  syncSupportAngle();
  syncMaterialChip();
  invalidateSlice();
  renderAction();
});
syncSupportAngle();
syncMaterialChip();

$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#about').addEventListener('click', () => $('#aboutDialog').showModal()); // what the site is for (Dalton, 2026-10-28)
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
  if (cut && e.key === 'Escape') {
    e.preventDefault();
    endCut();
    return;
  }
  if (servo && e.key === 'Escape') {
    e.preventDefault();
    endServo();
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
  else if (e.key === 'p' || e.key === 'P') setTool('split');
  else if (e.key === 'v' || e.key === 'V') setTool('servo');
  else if (!ctrl && (e.key === 'i' || e.key === 'I')) openPicture();
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
