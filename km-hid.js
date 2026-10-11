'use strict';
/*
  In-browser stand-in for km005-app.ps1: the same JSON API (KM.api(path, body)),
  but it talks to the keyboard directly over WebHID and keeps settings in localStorage.

  Protocol (vendor HID interface, usage page FF00 / usage 01, 64-byte reports, report ID 0):
    out: 55 <cmd> | 8 x 00 | data...
    in : AA <cmd> | 8 x echo | data...
    55 05 -> read state; 55 06 <state> -> write state. State (9 bytes at offset 10):
      [0] mode 00-0E  [1] brightness 00-FF  [2] speed 00 (fastest) - 05 (slowest)  [3] ?
      [4] 1 = rainbow / 0 = single color  [5] ?  [6..8] R G B
  Changing mode makes the keyboard go back to rainbow; the RGB bytes are kept.
*/
const KM = (() => {
  const FILTER = { vendorId: 0x5566, productId: 0x000a, usagePage: 0xff00, usage: 0x01 };
  const STORE = 'km005';
  const supported = 'hid' in navigator;

  /* ---------- settings (per browser) ---------- */

  const defaultNames = () => Array.from({ length: 15 }, (_, i) => `โหมด ${i + 1}`);
  const cfg = (() => {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { /* private mode: run with defaults */ }
    const names = defaultNames();
    if (Array.isArray(c.names)) c.names.slice(0, 15).forEach((n, i) => { if (n) names[i] = String(n); });
    return {
      names,
      lastBright: Number(c.lastBright) > 0 ? Number(c.lastBright) : 255,
      keepColor: c.keepColor !== false,
      savedColors: cleanColors(c.savedColors),
    };
  })();

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cfg)); } catch { /* storage blocked: settings last for this visit */ }
  }

  function cleanColors(list) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
      const h = String(c).trim().toUpperCase();
      if (/^#[0-9A-F]{6}$/.test(h) && !out.includes(h)) out.push(h);
      if (out.length >= 16) break;
    }
    return out;
  }

  /* ---------- device ---------- */

  let dev = null;
  let waiter = null;
  let chain = Promise.resolve();

  const isKM = (d) => d.vendorId === FILTER.vendorId && d.productId === FILTER.productId &&
    d.collections.some((c) => c.usagePage === FILTER.usagePage && c.usage === FILTER.usage);

  function onReport(e) {
    if (!waiter) return;
    const b = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (b[0] === 0xaa && b[1] === waiter.cmd) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w.resolve(b.slice());
    }
  }

  async function use(d) {
    if (!d.opened) await d.open();
    d.removeEventListener('inputreport', onReport);
    d.addEventListener('inputreport', onReport);
    dev = d;
  }

  // reconnect to a keyboard this site was already allowed to use
  async function attach() {
    if (dev || !supported) return !!dev;
    const granted = (await navigator.hid.getDevices()).filter(isKM);
    for (const d of granted) {
      try { await use(d); return true; } catch { /* busy or unplugged; try the next one */ }
    }
    return false;
  }

  async function hasPermission() {
    return supported && (await navigator.hid.getDevices()).some(isKM);
  }

  // one command at a time; resolves with the reply bytes or null
  function cmd(c, data) {
    const run = () => new Promise((resolve) => {
      if (!dev) { resolve(null); return; }
      const pkt = new Uint8Array(64);
      pkt[0] = 0x55;
      pkt[1] = c;
      if (data) pkt.set(data.slice(0, 54), 10);
      waiter = { cmd: c, resolve, timer: setTimeout(() => { waiter = null; resolve(null); }, 500) };
      dev.sendReport(0, pkt).catch(() => {
        if (waiter) { clearTimeout(waiter.timer); waiter = null; }
        dev = null;
        resolve(null);
      });
    });
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

  async function readState() {
    const r = await cmd(0x05);
    if (!r) return null;
    return {
      raw: r.slice(10, 19),
      mode: r[10], bright: r[11], speed: r[12], rainbow: r[14] === 1, rgb: [r[16], r[17], r[18]],
    };
  }

  // write back all 9 state bytes, changing only what the patch names
  async function write(s, p) {
    const d = Uint8Array.from(s.raw);
    if (p.mode != null) d[0] = p.mode;
    if (p.bright != null) d[1] = p.bright;
    if (p.speed != null) d[2] = Math.min(5, Math.max(0, p.speed));
    if (p.rainbow != null) d[4] = p.rainbow ? 1 : 0;
    if (p.rgb) d.set(p.rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, v | 0))), 6);
    return cmd(0x06, d);
  }

  if (supported) {
    navigator.hid.addEventListener('disconnect', (e) => { if (e.device === dev) dev = null; });
    navigator.hid.addEventListener('connect', (e) => { if (isKM(e.device)) attach(); });
  }

  /* ---------- API (same shape as km005-app.ps1) ---------- */

  async function stateObject() {
    await attach();
    const s = dev ? await readState() : null;
    const o = {
      connected: !!s, names: cfg.names, keepColor: cfg.keepColor, lastBright: cfg.lastBright,
      savedColors: cfg.savedColors, supported, needsPermission: !s && !(await hasPermission()),
    };
    if (s) Object.assign(o, { mode: s.mode, bright: s.bright, speed: s.speed, rainbow: s.rainbow, rgb: s.rgb });
    return o;
  }

  async function api(path, body) {
    switch (path) {
      case '/api/state': {
        if (!body) return stateObject();
        await attach();
        const before = await readState();
        if (!before) return stateObject();
        if (body.bright > 0 && body.bright !== cfg.lastBright) { cfg.lastBright = body.bright; save(); }
        const rest = { ...body };
        if (body.mode != null) {
          await write(before, { mode: body.mode, bright: body.bright });
          delete rest.mode; delete rest.bright;
          // the keyboard falls back to rainbow on every mode change; put the chosen color back
          if (cfg.keepColor && !before.rainbow && body.rainbow == null) {
            const now = await readState();
            if (now) await write(now, { rainbow: false, rgb: before.rgb });
          }
        }
        if (rest.bright != null || rest.speed != null || rest.rainbow != null || rest.rgb) {
          const now = await readState();
          if (now) await write(now, rest);
        }
        return stateObject();
      }
      case '/api/power': {
        const s = await readState();
        if (s) {
          if (body.on) await write(s, { bright: cfg.lastBright > 0 ? cfg.lastBright : 255 });
          else {
            if (s.bright > 0) { cfg.lastBright = s.bright; save(); }
            await write(s, { bright: 0 });
          }
        }
        return stateObject();
      }
      case '/api/name': {
        const i = Number(body.index);
        if (i >= 0 && i < 15) {
          cfg.names[i] = String(body.name || '').trim().slice(0, 40) || `โหมด ${i + 1}`;
          save();
        }
        return stateObject();
      }
      case '/api/colors':
        cfg.savedColors = cleanColors(body.colors);
        save();
        return stateObject();
      case '/api/options':
        if (body.keepColor != null) { cfg.keepColor = !!body.keepColor; save(); }
        return stateObject();
      default:
        throw new Error(`unknown path ${path}`);
    }
  }

  // must run from a click: the browser shows its device picker
  async function connect() {
    if (!supported) return false;
    const picked = await navigator.hid.requestDevice({ filters: [FILTER] });
    for (const d of picked.filter(isKM)) {
      try { await use(d); return true; } catch { /* try next */ }
    }
    return false;
  }

  return { api, connect, supported };
})();
