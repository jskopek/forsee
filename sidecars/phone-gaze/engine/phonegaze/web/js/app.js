/* global window, document */
// Entry point: navigation, shared context, toasts, theme, global-shortcut handling.

import { api } from './api.js';
import { h, fill } from './util.js';
import { startFlow, flowRunning } from './calibrate.js';
import dashboard from './dashboard.js';
import aim from './aim.js';
import live from './live.js';
import experiments, { trackPresetResults } from './experiments.js';
import recordings from './recordings.js';
import tuning from './tuning.js';
import { installGlint } from './glint.js';
import secondCamera from './second-camera.js'; // second camera (experimental)
import collect, { collectRunning } from './collect.js';

const VIEWS = [dashboard, collect, live, aim, tuning, experiments, recordings, secondCamera];
// Shown after an "Advanced" label in the navigation (simple mode: ui.simple_mode).
const ADVANCED = new Set(['aim', 'tuning', 'experiments', 'recordings', 'second-camera']);

const ctx = {
  api,
  config: null,
  toast,
  applyTheme: () => applyTheme(),
  async loadConfig(force = false) {
    if (!ctx.config || force) ctx.config = await api.get('/api/config');
    applyTheme();
    return ctx.config;
  },
  calibrate(kind) {
    return startFlow(kind, ctx);
  },
  async togglePause(paused) {
    const now = api.state ? api.state.paused : false;
    try {
      await api.post('/api/pause', { paused: paused === undefined ? !now : paused });
      await api.refreshState();
    } catch (err) {
      toast(err.message, 'error');
    }
  },
};

let current = null;
let cleanup = null;

function toast(message, level = 'info', ms = 5000) {
  const el = h('div', { class: `toast ${level}`, role: 'status', text: message });
  document.getElementById('toasts').appendChild(el);
  window.setTimeout(() => el.remove(), ms);
}

function applyTheme() {
  const theme =
    ctx.config && ctx.config.values && ctx.config.values.ui && ctx.config.values.ui.theme;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function route() {
  const id = (window.location.hash || '#dashboard').slice(1);
  const view = VIEWS.find((v) => v.id === id) || VIEWS[0];
  if (current === view) return;
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      window.console.error(err);
    }
  }
  current = view;
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.getAttribute('href') === `#${view.id}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const root = fill(document.getElementById('view'));
  document.title = `${view.title} · Phone Gaze`;
  cleanup = view.mount(root, ctx) || null;
}

function updatePills() {
  const conn = document.getElementById('conn-pill');
  conn.textContent = api.wsOpen ? 'Engine: connected' : 'Engine: not connected';
  conn.className = `pill ${api.wsOpen ? 'good' : 'bad'}`;
  const phone = document.getElementById('phone-pill');
  const st = api.state;
  if (!st) return;
  const p = st.phone || {};
  const state = p.state || (p.connected ? 'connected' : 'disconnected');
  let label = 'no phone';
  if (state === 'connected') label = p.simulated ? 'simulator' : p.replay ? 'replay' : 'connected';
  else if (state === 'connecting') label = 'connecting…';
  const fps = st.pipeline && st.pipeline.fps;
  phone.textContent = `Phone: ${label}${state === 'connected' && fps ? ` · ${fps.toFixed(0)} fps` : ''}${st.paused ? ' · paused' : ''}`;
  phone.className = `pill ${state === 'connected' ? (st.paused ? 'warn' : 'good') : state === 'connecting' ? 'warn' : 'bad'}`;
}

function onKey(ev) {
  if (flowRunning() || collectRunning()) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'c') ctx.calibrate('full');
  else if (key === 'r') ctx.calibrate('refine');
  else if (key === 'v') ctx.calibrate('validate');
  else if (key === 'p') ctx.togglePause();
  else return;
  ev.preventDefault();
}

function init() {
  const nav = document.getElementById('nav');
  let advanced = false;
  for (const v of VIEWS) {
    if (ADVANCED.has(v.id) && !advanced) {
      advanced = true;
      nav.appendChild(h('span', { class: 'nav-advanced muted small', text: 'Advanced:' }));
    }
    nav.appendChild(h('a', { href: `#${v.id}`, text: v.title }));
  }
  api.on('open', () => {
    updatePills();
    api.sendScreen();
  });
  api.on('close', updatePills);
  api.on('hello', updatePills);
  api.on('state', updatePills);
  api.on('log', (m) => {
    if (m.level === 'warning' || m.level === 'error') toast(m.message, m.level);
  });
  api.on('hotkey', (m) => {
    if (collectRunning()) return; // a collection run is recording: no calibration on top of it
    if (m.action === 'recalibrate') ctx.calibrate('full');
    else if (m.action === 'quick_refine') ctx.calibrate('refine');
    else if (m.action === 'validate') ctx.calibrate('validate');
    else if (m.action === 'pause') {
      // The engine toggles pause itself for the pause shortcut; just refresh what we show.
      api.refreshState().catch(() => {});
    }
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', onKey);
  trackPresetResults(ctx);
  installGlint(ctx);
  api.connect();
  api.refreshState().catch(() => {});
  ctx.loadConfig().catch((err) => toast(`Could not load settings: ${err.message}`, 'error'));
  route();
  updatePills();
}

init();
