// Teacher page: the key, then which settings students may change and what they start at, then a
// note to students. Saves to /api/teacher/class; the Worker checks it with the same rules
// (shared/settings.js validateClassConfig) and the student page follows it.

import './style.css';
import {
  CLASS_DEFAULTS, DEFAULT_CLASS_CONFIG, MAX_CLASS_MESSAGE, PRINT_LIMITS, SETTINGS, formatMinutes, summarize,
} from '../../shared/settings.js';
import { $, el } from './dom.js';
import { initThemeButton } from './theme.js';

const KEY_STORAGE = 'umm.teacherKey';

initThemeButton($('#theme'));

let config = structuredClone(DEFAULT_CLASS_CONFIG);

function say(text, tone = 'plain') {
  const s = $('#status');
  s.textContent = text;
  s.dataset.tone = tone;
}

// ---- Key ----------------------------------------------------------------------------------------

const keyInput = $('#key');
try {
  const saved = localStorage.getItem(KEY_STORAGE);
  if (saved) {
    keyInput.value = saved;
    $('#remember').checked = true;
  }
} catch { /* storage blocked: type the key each time */ }

function rememberKey() {
  try {
    if ($('#remember').checked) localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* fine */ }
}

$('#forget').addEventListener('click', () => {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch { /* fine */ }
  keyInput.value = '';
  $('#remember').checked = false;
  $('#setup').hidden = true;
  say('Key forgotten on this computer.');
});

async function api(method, body) {
  const key = keyInput.value.trim();
  if (!key) throw new Error('Type the teacher key first.');
  let r;
  try {
    r = await fetch('/api/teacher/class', {
      method,
      headers: { 'x-teacher-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Check the network.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('That teacher key was refused. Check it and try again.');
  if (!r.ok) throw new Error(j.message ?? `Something went wrong (${r.status}).`);
  return j;
}

// ---- The settings table ---------------------------------------------------------------------------

function control(def) {
  const value = config.defaults[def.id];
  const select = el('select', { 'aria-label': `${def.label}: starts at` });
  const options = def.kind === 'range'
    ? Array.from({ length: (def.max - def.min) / def.step + 1 }, (_, i) => {
      const v = def.min + i * def.step;
      return { id: v, label: `${v}${def.unit}` };
    })
    : def.options;
  for (const opt of options) {
    const o = el('option', { value: String(opt.id) }, opt.id === CLASS_DEFAULTS[def.id] ? `${opt.label} (school)` : opt.label);
    if (opt.id === value) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => {
    const opt = options.find((o) => String(o.id) === select.value);
    config.defaults = { ...config.defaults, [def.id]: opt.id };
    renderSummary();
  });
  return select;
}

function renderRows() {
  const body = $('#rows');
  body.innerHTML = '';
  for (const def of SETTINGS) {
    const tr = el('tr');
    const name = el('td');
    name.append(el('strong', {}, def.label), el('small', {}, def.help));
    const openCell = el('td');
    const toggle = el('label', { class: 'toggle' });
    const cb = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `Students can change ${def.label}` });
    cb.checked = config.open[def.id];
    const word = el('span', {}, cb.checked ? 'Yes' : 'Locked 🔒');
    cb.addEventListener('change', () => {
      config.open = { ...config.open, [def.id]: cb.checked };
      word.textContent = cb.checked ? 'Yes' : 'Locked 🔒';
      tr.classList.toggle('is-locked', !cb.checked);
    });
    toggle.append(cb, el('span', { class: 'switch', 'aria-hidden': 'true' }), word);
    openCell.append(toggle);
    const valueCell = el('td');
    valueCell.append(control(def));
    tr.classList.toggle('is-locked', !cb.checked);
    tr.append(name, openCell, valueCell);
    body.append(tr);
  }
  $('#message').value = config.message;
  $('#count').textContent = String(config.message.length);
  const max = $('#maxPrint');
  max.innerHTML = '';
  for (const m of PRINT_LIMITS) {
    const o = el('option', { value: String(m) }, m ? formatMinutes(m) : 'No limit');
    if (m === (config.maxPrintMinutes ?? 0)) o.selected = true;
    max.append(o);
  }
  renderSummary();
}

$('#maxPrint').addEventListener('change', () => {
  config.maxPrintMinutes = Number($('#maxPrint').value);
});

function renderSummary() {
  $('#summary').textContent = `Students start at: ${summarize(config.defaults)}.`;
}

$('#message').maxLength = MAX_CLASS_MESSAGE;
$('#message').addEventListener('input', () => {
  config.message = $('#message').value;
  $('#count').textContent = String(config.message.length);
});

// ---- Load / save ----------------------------------------------------------------------------------

$('#load').addEventListener('click', async () => {
  say('Opening…');
  try {
    config = await api('GET');
    rememberKey();
    renderRows();
    $('#setup').hidden = false;
    $('#warmCard').hidden = false;
    say('Class setup loaded.', 'ok');
  } catch (e) {
    say(e.message, 'error');
  }
});
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#load').click();
});

$('#school').addEventListener('click', () => {
  config = structuredClone(DEFAULT_CLASS_CONFIG);
  config.message = $('#message').value;
  renderRows();
  say('Back to the school profile with everything open. Press Save to keep it.');
});

$('#save').addEventListener('click', async () => {
  say('Saving…');
  try {
    config = await api('PUT', { ...config, message: $('#message').value });
    renderRows();
    const locked = SETTINGS.filter((d) => !config.open[d.id]).map((d) => d.label);
    say(locked.length ? `Saved. Locked for students: ${locked.join(', ')}.` : 'Saved. Students can change every setting.', 'ok');
  } catch (e) {
    say(e.message, 'error');
  }
});

$('#warmup').addEventListener('click', async () => {
  $('#warmStatus').textContent = 'Waking the slicer…';
  try {
    const r = await fetch('/api/teacher/warmup', { method: 'POST', headers: { 'x-teacher-key': keyInput.value.trim() } });
    const j = await r.json().catch(() => ({}));
    $('#warmStatus').textContent = r.ok ? `Ready (${j.engine ?? 'slicer'}, answered in ${j.seconds} s).` : (j.message ?? `Not ready (${r.status}).`);
  } catch {
    $('#warmStatus').textContent = 'Could not reach the server.';
  }
});

if (keyInput.value) $('#load').click();
