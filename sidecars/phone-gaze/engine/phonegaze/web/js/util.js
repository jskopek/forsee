/* global document, window, localStorage */
// Small helpers shared by every view. No framework: views build DOM with h().

/** Create an element. attrs: class, text, html-free; on<event> handlers; dataset via data-*. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof window.Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Replace all children of el. */
export function fill(el, ...children) {
  el.textContent = '';
  append(el, children);
  return el;
}

export function fmt(v, digits = 1, unit = '') {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (typeof v !== 'number') return String(v);
  return `${v.toFixed(digits)}${unit}`;
}

export function deg(v) {
  return fmt(v, 2, '°');
}

export function store(key, fallback) {
  try {
    const raw = localStorage.getItem(`pg.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(`pg.${key}`, JSON.stringify(value));
  } catch {
    // storage full or disabled: nothing to do
  }
}

/** Get a dotted path from an object ("calibration.grid"). */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

export function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Turn a pynput hotkey string ("<ctrl>+<alt>+c") into readable keys for a Mac. */
export function hotkeyLabel(spec) {
  if (!spec) return [];
  const names = {
    ctrl: 'Ctrl',
    alt: 'Opt',
    option: 'Opt',
    cmd: 'Cmd',
    shift: 'Shift',
    space: 'Space',
  };
  return String(spec)
    .split('+')
    .map((part) => part.replace(/[<>]/g, '').trim())
    .filter(Boolean)
    .map((p) => names[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p));
}

export function kbd(spec) {
  const parts = hotkeyLabel(spec);
  const out = [];
  parts.forEach((p, i) => {
    if (i) out.push('+');
    out.push(h('kbd', { text: p }));
  });
  return out;
}

/**
 * Screen points <-> CSS pixels of this window.
 *
 * INTERFACES.md: a CSS point (cx, cy) is at screen point (screenX + cx, screenY + cy) on macOS at
 * 100 % zoom. When the engine's screen does not fit inside this window (the simulator's screen,
 * or the window is not fullscreen), the mapping falls back to scaling the whole screen into the
 * window, and `exact` is false so the page can say so.
 */
export function screenMapper(screen, points = []) {
  // Window chrome (title bar, toolbar) sits above the page; it is zero in full screen, where
  // this is exactly the INTERFACES.md formula.
  const sx = (window.screenX || 0) + Math.max(0, window.outerWidth - window.innerWidth);
  const sy = (window.screenY || 0) + Math.max(0, window.outerHeight - window.innerHeight);
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  const sw = (screen && screen.width) || w;
  const sh = (screen && screen.height) || hgt;
  const fits = points.every(
    (p) => p.x - sx >= 0 && p.x - sx <= w && p.y - sy >= 0 && p.y - sy <= hgt,
  );
  const coversScreen = sx <= 0 && sy <= 0 && w >= sw - 1 && hgt >= sh - 1;
  const exact = points.length ? fits : coversScreen;
  if (exact) {
    return {
      exact: true,
      toCss: (x, y) => [x - sx, y - sy],
      toScreen: (cx, cy) => [cx + sx, cy + sy],
    };
  }
  const k = Math.min(w / sw, hgt / sh);
  const ox = (w - sw * k) / 2;
  const oy = (hgt - sh * k) / 2;
  return {
    exact: false,
    toCss: (x, y) => [ox + x * k, oy + y * k],
    toScreen: (cx, cy) => [(cx - ox) / k, (cy - oy) / k],
  };
}

/** Error colour from 0 (green) through yellow to red at `max`. */
export function errorColour(v, max = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return '#888888';
  const t = Math.max(0, Math.min(1, v / max));
  const stops = [
    [26, 152, 80],
    [254, 224, 139],
    [215, 48, 39],
  ];
  const seg = t < 0.5 ? 0 : 1;
  const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[seg];
  const b = stops[seg + 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
