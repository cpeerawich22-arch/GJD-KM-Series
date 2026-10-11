'use strict';

/* ---------- constants ---------- */

const PRESETS = [
  { id: 'red', name: 'Red', rgb: [255, 0, 0] },
  { id: 'orange', name: 'Orange', rgb: [255, 80, 0] },
  { id: 'yellow', name: 'Yellow', rgb: [255, 255, 0] },
  { id: 'green', name: 'Green', rgb: [0, 255, 0] },
  { id: 'cyan', name: 'Cyan', rgb: [0, 255, 255] },
  { id: 'blue', name: 'Blue', rgb: [0, 0, 255] },
  { id: 'purple', name: 'Purple', rgb: [255, 0, 255] },
  { id: 'white', name: 'White', rgb: [128, 128, 128], swatch: '#ffffff' },
];
const LEVELS = [51, 102, 153, 204, 255]; // keyboard brightness steps (0x33 each)
// Effects whose colors are built into the keyboard firmware (0-based mode index).
// Color settings are ignored there, so the color panel is locked for them.
const FIXED_COLOR = { 0: 'rainbow', 2: 'rainbow', 9: 'random', 14: 'rainbow' };
const fixedColor = (s) => (s && s.connected ? FIXED_COLOR[s.mode] : undefined);
const POLL_MS = 1000;

// 75% layout in key units. Numbers between keys are gaps.
const ROWS = [
  [0, [['Esc', 1, 'esc'], 0.25, ['F1'], ['F2'], ['F3'], ['F4'], 0.25, ['F5'], ['F6'], ['F7'], ['F8'], 0.25, ['F9'], ['F10'], ['F11'], ['F12'], 0.25, ['Del']]],
  [1.25, [['`'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8'], ['9'], ['0'], ['-'], ['='], ['Backspace', 2], 0.25, ['Home']]],
  [2.25, [['Tab', 1.5, 'tab'], ['Q'], ['W'], ['E'], ['R'], ['T'], ['Y'], ['U'], ['I'], ['O'], ['P'], ['['], [']'], ['\\', 1.5, 'bslash'], 0.25, ['PgUp']]],
  [3.25, [['Caps Lock', 1.75], ['A'], ['S'], ['D'], ['F'], ['G'], ['H'], ['J'], ['K'], ['L'], [';'], ["'"], ['Enter', 2.25], 0.25, ['PgDn']]],
  [4.25, [['Shift', 2.25], ['Z'], ['X'], ['C'], ['V'], ['B'], ['N'], ['M'], [','], ['.'], ['/'], ['Shift', 1.75], 0.25, ['↑', 1, 'up'], ['End']]],
  [5.25, [['Ctrl', 1.25], ['Win', 1.25], ['Alt', 1.25], ['', 6.25, 'space'], ['Alt'], ['Fn', 1, 'fn'], ['Ctrl'], 0.25, ['←'], ['↓', 1, 'down'], ['→']]],
];
// Keycap colorway of the real KM005 (white alphas, light pink mods, deep pink accents)
const ACCENT_KEYS = new Set(['Esc', 'Enter', '←', '↑', '↓', '→']);
const MOD_KEYS = new Set(['F5', 'F6', 'F7', 'F8', 'Backspace', 'Tab', 'Caps Lock', 'Shift', 'Ctrl', 'Win', 'Alt', 'Fn', 'Del', 'Home', 'PgUp', 'PgDn', 'End']);
const capTone = (label, id) => (id === 'space' || ACCENT_KEYS.has(label) ? 'accent' : MOD_KEYS.has(label) ? 'mod' : '');
const PAD = 0.45;
const KB_W = 16.25 + PAD * 2;
const KB_H = 6.25 + PAD * 2;

/* ---------- state ---------- */

let state = null;          // last state from the keyboard (or optimistic copy)
let queued = null;         // pending partial write, merged
let inflight = false;
let renaming = -1;
let dragHue = false;
let toastTimer = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const $ = (id) => document.getElementById(id);
const app = $('app');

/* ---------- api ---------- */

// web build: the keyboard is reached through WebHID (km-hid.js) instead of the local server
const api = (path, body) => KM.api(path, body);

function sendState(partial) {
  queued = { ...(queued || {}), ...partial };
  flush();
}

async function flush() {
  if (inflight || !queued) return;
  const body = queued;
  queued = null;
  inflight = true;
  try {
    const next = await api('/api/state', body);
    if (!queued) applyState(next);
    if (!next.connected) showToast('Keyboard not found. The change was not sent.');
  } catch {
    showToast('Could not reach the keyboard. Try again.');
  } finally {
    inflight = false;
    if (queued) flush();
  }
}

async function post(path, body) {
  try {
    applyState(await api(path, body));
  } catch {
    showToast('Could not save. Try again.');
    poll();
  }
}

async function poll() {
  if (inflight || queued || renaming >= 0 || dragHue) return;
  try {
    applyState(await api('/api/state'));
  } catch {
    applyState({ connected: false, serverDown: true, supported: KM.supported, names: state?.names || [] });
  }
}

/* ---------- color helpers ---------- */

const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

function parseHex(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hueToRgb(h) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

function rgbToHue([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

const sameRgb = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function colorName(s) {
  const fixed = fixedColor(s);
  if (fixed === 'rainbow') return 'Built-in rainbow';
  if (fixed === 'random') return 'Built-in random colors';
  if (s.rainbow) return 'Rainbow';
  const p = PRESETS.find((x) => sameRgb(x.rgb, s.rgb));
  return p ? p.name : toHex(s.rgb);
}

/* ---------- keyboard render ---------- */

const keys = [];
let knob = null;

function buildKeyboard() {
  const kb = $('kb');
  const pct = (v, total) => `${(v / total) * 100}%`;
  for (const [y, items] of ROWS) {
    let x = 0;
    for (const item of items) {
      if (typeof item === 'number') { x += item; continue; }
      const [label, w = 1, id] = item;
      const el = document.createElement('div');
      el.className = 'key';
      Object.assign(el.style, {
        left: pct(x + PAD, KB_W), top: pct(y + PAD, KB_H),
        width: pct(w, KB_W), height: pct(1, KB_H),
      });
      const cap = document.createElement('div');
      cap.className = `cap ${capTone(label, id)}`;
      const legend = document.createElement('span');
      legend.textContent = label;
      cap.append(legend);
      el.append(cap);
      if (id) el.dataset.id = id;
      kb.append(el);
      // seed: a stable per-key hue for the random-color effect (golden-angle spread)
      keys.push({ el, cap, cx: (x + w / 2) / 16.25, cy: (y + 0.5) / 6.25, seed: (keys.length * 137.508) % 360 });
      x += w;
    }
  }
  // snake order: row by row, alternating direction (zig-zag)
  const rows = [...new Set(keys.map((k) => k.cy))].sort((a, b) => a - b);
  let n = 0;
  rows.forEach((cy, r) => {
    const row = keys.filter((k) => k.cy === cy).sort((a, b) => a.cx - b.cx);
    if (r % 2) row.reverse();
    for (const k of row) k.ord = n++;
  });
  for (const k of keys) k.ord /= n;

  knob = document.createElement('div');
  knob.className = 'knob';
  knob.dataset.id = 'knob';
  knob.title = 'Scroll the mouse wheel here to change brightness';
  knob.innerHTML = '<span class="knob-face"></span><span class="knob-dial"><i></i></span>';
  Object.assign(knob.style, {
    left: pct(15.2 + PAD, KB_W), top: pct(PAD - 0.08, KB_H),
    width: pct(1.1, KB_W), height: pct(1.1, KB_H),
  });
  kb.append(knob);
  knob.addEventListener('wheel', onKnobWheel, { passive: false });

  // three status LEDs between Enter and the right-hand column
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('div');
    dot.className = 'status-led';
    Object.assign(dot.style, {
      left: pct(15.04 + PAD, KB_W), top: pct(2.55 + i * 0.32 + PAD, KB_H),
      width: pct(0.14, KB_W), height: pct(0.12, KB_H),
    });
    kb.append(dot);
  }
}

// Pick a preview animation from the user's effect name (first match wins)
function effectKind(name) {
  const n = (name || '').toLowerCase();
  if (/static|นิ่ง/.test(n)) return 'static';
  if (/breat|หายใจ/.test(n)) return 'breathe';
  if (/pinwheel|กังหัน/.test(n)) return 'pinwheel';
  if (/spiral|เกลียว/.test(n)) return 'spiral';
  if (/snake|งู/.test(n)) return 'snake';
  if (/trigger|react|กระพริบ|กะพริบ/.test(n)) return 'trigger';
  if (/ocean|ทะเล/.test(n)) return 'ocean';
  if (/vertical|แนวตั้ง/.test(n)) return 'waveV';
  if (/horizon|แนวนอน/.test(n)) return 'waveH';
  if (/circle|ripple|วง/.test(n)) return 'ripple';
  if (/wave|คลื่น/.test(n)) return 'waveH';
  return 'flow';
}

// key unit aspect: x spans 16.25 units, y 6.25, so stretch x for round shapes
const ASPECT = 16.25 / 6.25;
const angleOf = (k) => Math.atan2(k.cy - 0.5, (k.cx - 0.5) * ASPECT) / TAU + 0.5; // 0..1
const frac = (v) => ((v % 1) + 1) % 1;

const TAU = Math.PI * 2;
const wave = (p) => 0.5 + 0.5 * Math.sin(p * TAU);

// preview time runs faster or slower with the effect speed (UI level 1..6)
const SPEED_FACTOR = [0.45, 0.65, 0.9, 1.2, 1.6, 2.1];
let lastFrame = 0;
let animT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = now - lastFrame;
  if (dt < 33) return;
  lastFrame = now;
  if (!state || !state.connected) return;

  if (!reducedMotion.matches) animT += (Math.min(dt, 100) / 1000) * SPEED_FACTOR[speedLevel(state.speed) - 1];
  const t = reducedMotion.matches ? 0 : animT;
  const fixed = fixedColor(state);
  const look = fixed || (state.rainbow ? 'rainbow' : 'solid');
  const kind = fixed === 'random' ? 'static' : effectKind(state.names?.[state.mode]);
  const level = state.bright / 255;
  const [r, g, b] = state.rgb || [255, 255, 255];
  let breathe = 1;
  if (kind === 'breathe') breathe = reducedMotion.matches ? 1 : 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(t * 2.2));

  const solid = look === 'solid';
  for (const k of keys) {
    let p, amp = 1;
    switch (kind) {
      case 'static': p = k.cx * 0.85; break;
      case 'breathe': p = k.cx * 0.85; amp = breathe; break;
      case 'waveV': p = k.cy * 0.9 - t * 0.28; amp = solid ? 0.3 + 0.7 * wave(p) : 1; break;
      case 'waveH': p = k.cx - t * 0.28; amp = solid ? 0.3 + 0.7 * wave(p) : 1; break;
      case 'ripple': {
        const d = Math.hypot((k.cx - 0.5) * 1.6, k.cy - 0.5);
        p = d * 1.1 - t * 0.3; amp = solid ? 0.3 + 0.7 * wave(p) : 1;
        break;
      }
      case 'pinwheel': {
        // four blades sweeping around the center
        const a = angleOf(k);
        p = a - t * 0.25;
        amp = solid ? 0.2 + 0.8 * Math.pow(wave(a * 4 - t * 1), 2) : 1;
        break;
      }
      case 'spiral': {
        const d = Math.hypot((k.cx - 0.5) * 1.6, k.cy - 0.5);
        p = angleOf(k) + d * 1.6 - t * 0.35;
        amp = solid ? 0.25 + 0.75 * wave(p) : 1;
        break;
      }
      case 'snake': {
        // a head running along the zig-zag key order with a fading tail
        const behind = frac(t * 0.22 - k.ord);
        const tail = 0.14;
        p = k.ord;
        amp = behind < tail ? Math.pow(1 - behind / tail, 1.5) : 0.04;
        break;
      }
      case 'trigger': {
        // keys flash at their own random moments, then fade like a key press
        const phase = frac(t * 0.45 + k.seed / 360 * 7.3);
        p = k.seed / 360;
        amp = phase < 0.3 ? Math.pow(1 - phase / 0.3, 2) : 0.03;
        break;
      }
      case 'ocean': {
        // a slow swell with a smaller chop on top
        p = k.cx * 0.7 - t * 0.12 + 0.08 * Math.sin(k.cy * 7 + t * 1.3);
        amp = solid ? 0.3 + 0.55 * wave(p) + 0.15 * wave(k.cx * 3 + k.cy * 2 - t * 0.6) : 1;
        break;
      }
      default: p = (k.cx + k.cy * 0.35) * 0.75 - t * 0.12; amp = solid ? 0.55 + 0.45 * wave(p) : 1;
    }
    paintKey(k.cap, look === 'random' ? k.seed / 360 : p, amp * level, r, g, b, look);
  }
  paintKey(knob, 0.95 - t * 0.12, level * (kind === 'breathe' ? breathe : 1), r, g, b, look);
  paintAmbient(look === 'random' ? 0 : t, level * (kind === 'breathe' ? 0.4 + 0.6 * breathe : 1), r, g, b, look);
}

// LEDs sit under opaque keycaps, so the light shows as a halo around each cap.
// look: 'solid' (state RGB), 'rainbow' (hue from phase p) or 'random' (hue from per-key seed in p)
function paintKey(el, p, a, r, g, b, look) {
  const alpha = (Math.min(1, a) * 0.9).toFixed(3);
  el.style.setProperty('--glow', look === 'solid'
    ? `rgb(${r} ${g} ${b} / ${alpha})`
    : `hsl(${(((p % 1) + 1) % 1) * 360} 100% 55% / ${alpha})`);
}

function paintAmbient(t, a, r, g, b, look) {
  const root = document.documentElement.style;
  let solid, soft;
  if (look !== 'solid') {
    const h = ((t * 40) % 360 + 360) % 360;
    solid = `hsl(${h} 100% 60%)`;
    soft = `linear-gradient(90deg, hsl(${h} 100% 55% / ${0.45 * a}), hsl(${(h + 120) % 360} 100% 55% / ${0.45 * a}), hsl(${(h + 240) % 360} 100% 55% / ${0.45 * a}))`;
    root.setProperty('--led-soft', `hsl(${h} 100% 55% / ${0.3 * a})`);
  } else {
    solid = `rgb(${r} ${g} ${b})`;
    soft = `rgb(${r} ${g} ${b} / ${0.4 * a})`;
    root.setProperty('--led-soft', soft);
  }
  root.setProperty('--led', a > 0.02 ? solid : 'oklch(0.45 0 0)');
  $('kbGlow').style.background = soft;
}

function onKnobWheel(e) {
  e.preventDefault();
  if (!state?.connected) return;
  const i = levelIndex(state.bright);
  const next = Math.max(-1, Math.min(LEVELS.length - 1, i + (e.deltaY < 0 ? 1 : -1)));
  setBrightness(next < 0 ? 0 : LEVELS[next]);
}

/* ---------- effects list ---------- */

const PENCIL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L5 14H2v-3z"/><path d="M9 4l3 3"/></svg>';

// Two groups: effects that take the chosen color, and effects with built-in colors.
// Numbers stay the keyboard's own order (what Fn+\ cycles through).
const EFFECT_GROUPS = [
  { id: 'free', label: 'Custom color', test: (i) => !FIXED_COLOR[i] },
  { id: 'fixed', label: 'Built-in color', test: (i) => !!FIXED_COLOR[i] },
];
const FIXED_TAG = { rainbow: 'Rainbow', random: 'Random' };

function buildEffects() {
  const list = $('effectList');
  list.innerHTML = '';
  for (const group of EFFECT_GROUPS) {
    const members = [...Array(15).keys()].filter(group.test);
    if (!members.length) continue;
    const wrap = document.createElement('li');
    wrap.className = 'effect-group';
    wrap.setAttribute('role', 'presentation');
    wrap.innerHTML = `<span class="effect-group-label" id="group-${group.id}">${group.label}<span>${members.length}</span></span>`;
    const ul = document.createElement('ul');
    ul.className = 'effect-sub';
    ul.setAttribute('role', 'group');
    ul.setAttribute('aria-labelledby', `group-${group.id}`);
    for (const i of members) ul.append(buildEffect(i));
    wrap.append(ul);
    list.append(wrap);
  }
}

function buildEffect(i) {
  const li = document.createElement('li');
  li.className = 'effect';
  li.id = `effect-${i}`;
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');
  li.tabIndex = -1;
  li.dataset.index = i;
  const tag = FIXED_COLOR[i] ? `<span class="effect-tag is-${FIXED_COLOR[i]}">${FIXED_TAG[FIXED_COLOR[i]]}</span>` : '<span></span>';
  li.innerHTML = `<span class="effect-num">${String(i + 1).padStart(2, '0')}</span><span class="effect-name"></span>${tag}` +
    `<button class="effect-edit" type="button" tabindex="-1" aria-label="Rename effect ${i + 1}">${PENCIL}</button>`;
  li.addEventListener('click', (e) => {
    if (e.target.closest('.effect-edit')) { startRename(i); return; }
    if (renaming === i) return;
    selectEffect(i);
  });
  li.querySelector('.effect-name').addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(i); });
  li.addEventListener('keydown', onEffectKey);
  return li;
}

// arrow keys follow the on-screen order, across both groups
function onEffectKey(e) {
  if (renaming >= 0) return;
  const i = Number(e.currentTarget.dataset.index);
  const options = [...document.querySelectorAll('#effectList .effect')];
  const at = options.indexOf(e.currentTarget);
  const move = (to) => { e.preventDefault(); options[(to + options.length) % options.length].focus(); };
  if (e.key === 'ArrowDown') move(at + 1);
  else if (e.key === 'ArrowUp') move(at - 1);
  else if (e.key === 'Home') move(0);
  else if (e.key === 'End') move(options.length - 1);
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectEffect(i); }
  else if (e.key === 'F2') { e.preventDefault(); startRename(i); }
}

function selectEffect(i) {
  if (!state?.connected || state.mode === i) return;
  // keyboard drops to rainbow on mode change unless the app re-applies the color
  const local = { mode: i };
  if (!state.keepColor) local.rainbow = true;
  applyState({ ...state, ...local });
  sendState({ mode: i });
}

function startRename(i) {
  if (renaming >= 0) return;
  renaming = i;
  const li = $(`effect-${i}`);
  const nameEl = li.querySelector('.effect-name');
  const input = document.createElement('input');
  input.className = 'effect-input';
  input.value = state?.names?.[i] ?? '';
  input.maxLength = 40;
  input.setAttribute('aria-label', `Effect ${i + 1} name`);
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(nameEl);
    renaming = -1;
    li.focus();
    if (save && value !== (state?.names?.[i] ?? '')) {
      state.names[i] = value || `Effect ${i + 1}`;
      render();
      post('/api/name', { index: i, name: value });
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ---------- color controls ---------- */

function buildSwatches() {
  const box = $('swatches');
  const make = (label, cls, onPick, color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${cls}`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.innerHTML = '<span class="swatch-dot" aria-hidden="true"></span><span></span>';
    b.lastChild.textContent = label;
    if (color) b.style.setProperty('--c', color);
    b.addEventListener('click', onPick);
    box.append(b);
    return b;
  };
  make('Rainbow', 'is-rainbow', () => setColor({ rainbow: true })).dataset.id = 'rainbow';
  for (const p of PRESETS) {
    make(p.name, '', () => setColor({ rainbow: false, rgb: p.rgb }), p.swatch || toHex(p.rgb)).dataset.id = p.id;
  }
  box.addEventListener('keydown', (e) => {
    const items = [...box.children];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 3, ArrowLeft: -1, ArrowUp: -3 }[e.key];
    if (!step) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length].focus();
  });
}

function setColor(partial) {
  if (!state?.connected) return;
  applyState({ ...state, ...partial });
  sendState(partial);
}

function bindCustomColor() {
  const hex = $('hexInput');
  const commit = () => {
    const rgb = parseHex(hex.value);
    hex.classList.toggle('is-invalid', !rgb);
    hex.setAttribute('aria-invalid', String(!rgb));
    if (rgb) setColor({ rainbow: false, rgb });
  };
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { hex.blur(); render(); } });
  hex.addEventListener('change', commit);
  hex.addEventListener('input', () => hex.classList.remove('is-invalid'));

  $('colorInput').addEventListener('input', (e) => {
    const rgb = parseHex(e.target.value);
    if (rgb) setColor({ rainbow: false, rgb });
  });

  const hue = $('hue');
  hue.addEventListener('pointerdown', () => { dragHue = true; });
  window.addEventListener('pointerup', () => { dragHue = false; });
  hue.addEventListener('input', () => setColor({ rainbow: false, rgb: hueToRgb(Number(hue.value)) }));
}

/* ---------- saved custom colors ---------- */

const MAX_SAVED = 16;
const CROSS = '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function bindSaved() {
  $('saveColor').addEventListener('click', () => {
    if (!state?.connected || state.rainbow) return;
    const hex = toHex(state.rgb);
    const list = state.savedColors || [];
    if (list.includes(hex)) { showToast(`${hex} is already saved`); return; }
    if (list.length >= MAX_SAVED) { showToast(`You can save up to ${MAX_SAVED} colors. Remove one first.`); return; }
    saveColors([hex, ...list]);
  });

  const box = $('savedList');
  box.addEventListener('keydown', (e) => {
    const dots = [...box.querySelectorAll('.saved-dot')];
    const i = dots.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSaved(i);
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 8, ArrowLeft: -1, ArrowUp: -8 }[e.key];
    if (!step) return;
    e.preventDefault();
    dots[Math.max(0, Math.min(dots.length - 1, i + step))].focus();
  });
}

function saveColors(list) {
  applyState({ ...state, savedColors: list });
  post('/api/colors', { colors: list });
}

function removeSaved(i) {
  const list = [...(state.savedColors || [])];
  list.splice(i, 1);
  saveColors(list);
  const dots = $('savedList').querySelectorAll('.saved-dot');
  (dots[Math.min(i, dots.length - 1)] || $('saveColor')).focus();
}

function renderSaved() {
  const box = $('savedList');
  const list = state.savedColors || [];
  const current = state.rainbow ? '' : toHex(state.rgb);
  const firstChecked = list.indexOf(current);

  // rebuild only when the list itself changed, so focus survives polling
  if (box.dataset.list !== list.join()) {
    box.dataset.list = list.join();
    box.innerHTML = '';
    list.forEach((hex, i) => {
      const item = document.createElement('div');
      item.className = 'saved-item';
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'saved-dot';
      dot.setAttribute('role', 'radio');
      dot.setAttribute('aria-label', `Color ${hex}`);
      dot.title = `${hex} (press Delete to remove)`;
      dot.style.setProperty('--c', hex);
      dot.addEventListener('click', () => setColor({ rainbow: false, rgb: parseHex(hex) }));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'saved-del';
      del.tabIndex = -1;
      del.setAttribute('aria-label', `Remove ${hex}`);
      del.innerHTML = CROSS;
      del.addEventListener('click', () => removeSaved(i));
      item.append(dot, del);
      box.append(item);
    });
  }
  box.querySelectorAll('.saved-dot').forEach((dot, i) => {
    dot.setAttribute('aria-checked', String(i === firstChecked));
    dot.tabIndex = i === (firstChecked >= 0 ? firstChecked : 0) ? 0 : -1;
  });
  $('savedEmpty').hidden = list.length > 0;
  const save = $('saveColor');
  save.disabled = !state.connected || state.rainbow || list.includes(current);
  save.title = state.rainbow ? 'Pick a single color first; rainbow cannot be saved' : list.includes(current) ? 'Already saved' : `Save ${current}`;
}

/* ---------- brightness ---------- */

const levelIndex = (b) => (b <= 0 ? -1 : LEVELS.reduce((best, v, i) => (Math.abs(v - b) < Math.abs(LEVELS[best] - b) ? i : best), 0));

function buildBrightness() {
  const seg = $('bright');
  LEVELS.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', `Brightness ${(i + 1) * 20}%`);
    b.innerHTML = `<span class="seg-bars" aria-hidden="true">${LEVELS.map((_, j) => `<i class="${j <= i ? 'on' : ''}" style="height:${(j + 1) * 20}%"></i>`).join('')}</span><span>${(i + 1) * 20}%</span>`;
    b.addEventListener('click', () => setBrightness(v));
    seg.append(b);
  });
  seg.addEventListener('keydown', (e) => {
    const items = [...seg.children];
    const i = items.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(items.length - 1, i + step));
    items[n].focus();
    items[n].click();
  });

  $('power').addEventListener('click', () => {
    if (!state?.connected) return;
    const on = state.bright === 0;
    applyState({ ...state, bright: on ? (state.lastBright || 255) : 0 });
    post('/api/power', { on });
  });
  $('keepColor').addEventListener('click', () => {
    if (!state) return;
    applyState({ ...state, keepColor: !state.keepColor });
    post('/api/options', { keepColor: state.keepColor });
  });
}

/* ---------- speed ---------- */

// keyboard byte: 0 = fastest ... 5 = slowest; UI level: 1 = slowest ... 6 = fastest
const speedLevel = (byte) => 6 - Math.max(0, Math.min(5, byte ?? 2));

function buildSpeed() {
  const seg = $('speed');
  for (let level = 1; level <= 6; level++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', `Speed ${level} of 6`);
    b.textContent = level;
    b.addEventListener('click', () => {
      if (!state?.connected) return;
      const speed = 6 - level;
      applyState({ ...state, speed });
      sendState({ speed });
    });
    seg.append(b);
  }
  seg.addEventListener('keydown', (e) => {
    const items = [...seg.children];
    const i = items.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(items.length - 1, i + step));
    items[n].focus();
    items[n].click();
  });
}

function setBrightness(v) {
  if (!state?.connected) return;
  const patch = { bright: v };
  if (v > 0) patch.lastBright = v;
  applyState({ ...state, ...patch });
  sendState({ bright: v });
}

/* ---------- shortcuts legend ---------- */

function bindShortcuts() {
  for (const li of document.querySelectorAll('.shortcuts li')) {
    const ids = li.dataset.keys.split(' ');
    const toggle = (on) => {
      for (const el of document.querySelectorAll('#kb [data-id]')) {
        if (ids.includes(el.dataset.id)) el.classList.toggle('is-hint', on);
      }
    };
    li.addEventListener('mouseenter', () => toggle(true));
    li.addEventListener('mouseleave', () => toggle(false));
  }
}

/* ---------- render ---------- */

function applyState(next) {
  state = next;
  render();
}

function render() {
  if (!state) return;
  const on = !!state.connected;
  app.classList.remove('is-loading');
  app.classList.toggle('is-offline', !on);

  const conn = $('conn');
  conn.classList.toggle('is-on', on);
  conn.classList.toggle('is-off', !on);
  const unsupported = state.supported === false;
  $('connText').textContent = on ? 'Connected'
    : unsupported ? 'Browser not supported'
    : state.serverDown ? 'Connection error'
    : state.needsPermission ? 'Not connected'
    : 'Keyboard not found';

  $('offline').hidden = on;
  if (!on) {
    // WebHID only works in Chromium browsers; the first visit needs a click to pick the keyboard
    const [title, text] = unsupported
      ? ['This browser cannot talk to the keyboard', 'Open this page in Google Chrome or Microsoft Edge on a computer.']
      : state.serverDown
        ? ['Something went wrong while connecting', 'Refresh the page, then connect the keyboard again.']
        : state.needsPermission
          ? ['Connect your KM005', 'Plug in the USB cable, switch the keyboard to wired mode, then press the button below and pick KM005 from the list.']
          : ['KM005 not found', 'Plug in the USB cable and switch the keyboard to wired mode. If it is plugged in but does not show up, connect again.'];
    $('offlineTitle').textContent = title;
    $('offlineText').textContent = text;
    $('connectBtn').hidden = unsupported;
  }

  // effects
  const names = state.names || [];
  for (let i = 0; i < 15; i++) {
    const li = $(`effect-${i}`);
    if (!li) continue;
    const selected = on && state.mode === i;
    li.setAttribute('aria-selected', String(selected));
    li.tabIndex = selected || (!on && i === 0) ? 0 : -1;
    const nameEl = li.querySelector('.effect-name');
    if (nameEl) {
      const name = names[i] || `Effect ${i + 1}`;
      nameEl.textContent = name;
      nameEl.title = name;
      nameEl.classList.toggle('is-default', /^(โหมด|Effect) \d+$/.test(name));
    }
  }

  if (!on) {
    $('effectName').textContent = 'KM005';
    $('effectMeta').textContent = 'Waiting for the keyboard';
    setDisabled(true);
    return;
  }
  setDisabled(false);

  $('effectName').textContent = names[state.mode] || `Effect ${state.mode + 1}`;
  $('effectMeta').textContent = state.bright === 0
    ? `${colorName(state)} · Lights off`
    : `${colorName(state)} · Brightness ${(levelIndex(state.bright) + 1) * 20}%`;

  // color
  const preset = state.rainbow ? 'rainbow' : PRESETS.find((p) => sameRgb(p.rgb, state.rgb))?.id;
  for (const b of $('swatches').children) {
    const checked = b.dataset.id === preset;
    b.setAttribute('aria-checked', String(checked));
    b.tabIndex = checked || (!preset && b.dataset.id === 'rainbow') ? 0 : -1;
  }
  const hexText = toHex(state.rgb);
  const hex = $('hexInput');
  if (document.activeElement !== hex) { hex.value = hexText; hex.classList.remove('is-invalid'); }
  $('pickerChip').style.setProperty('--c', hexText);
  if (document.activeElement !== $('colorInput')) $('colorInput').value = hexText.toLowerCase();
  const hue = $('hue');
  if (!dragHue) hue.value = rgbToHue(state.rgb);
  hue.style.setProperty('--c', hexText);
  renderSaved();

  // effects with built-in colors ignore color settings: lock the color panel
  const fixed = fixedColor(state);
  $('colorGroup').classList.toggle('is-locked', !!fixed);
  $('colorLock').hidden = !fixed;
  if (fixed) {
    $('colorLock').textContent = fixed === 'random'
      ? 'This effect gives every key its own random color, so it ignores color settings. Pick another effect to set a color.'
      : 'This effect uses its own rainbow, so it ignores color settings. Pick another effect to set a color.';
    for (const el of $('colorGroup').querySelectorAll('button, input')) el.disabled = true;
  }

  // brightness; the knob's marker turns with it (off = far left, 100% = far right)
  const lit = state.bright > 0;
  knob.style.setProperty('--turn', `${-135 + (levelIndex(state.bright) + 1) * 54}deg`);
  const power = $('power');
  power.setAttribute('aria-checked', String(lit));
  const shown = levelIndex(lit ? state.bright : (state.lastBright || 255));
  const seg = $('bright');
  seg.classList.toggle('is-off', !lit);
  [...seg.children].forEach((b, i) => {
    b.setAttribute('aria-checked', String(i === shown));
    b.tabIndex = i === shown ? 0 : -1;
  });

  // speed
  const level = speedLevel(state.speed);
  [...$('speed').children].forEach((b, i) => {
    b.setAttribute('aria-checked', String(i + 1 === level));
    b.tabIndex = i + 1 === level ? 0 : -1;
  });
  $('speedValue').textContent = `${level}/6`;

  $('keepColor').setAttribute('aria-checked', String(!!state.keepColor));
}

function setDisabled(off) {
  for (const el of document.querySelectorAll('.settings button, .settings input')) {
    if (el.id === 'keepColor') continue;
    el.disabled = off;
  }
}

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- boot ---------- */

function showSkeleton() {
  const list = $('effectList');
  for (let i = 0; i < 15; i++) {
    const s = document.createElement('li');
    s.className = 'skeleton';
    s.setAttribute('aria-hidden', 'true');
    list.append(s);
  }
}

showSkeleton();
buildKeyboard();
buildSwatches();
bindCustomColor();
bindSaved();
buildBrightness();
buildSpeed();
bindShortcuts();

$('connectBtn').addEventListener('click', async () => {
  try {
    if (await KM.connect()) await poll();
  } catch {
    showToast('Could not connect. Unplug the cable, plug it back in and try again.');
  }
});

api('/api/state')
  .then((s) => { buildEffects(); applyState(s); })
  .catch(() => { buildEffects(); applyState({ connected: false, serverDown: true, supported: KM.supported, names: [] }); })
  .finally(() => {
    setInterval(poll, POLL_MS);
    requestAnimationFrame(frame);
  });
