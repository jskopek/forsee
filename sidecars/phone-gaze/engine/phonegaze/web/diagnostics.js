/* global window, document, navigator, fetch */
// Diagnostics page: live health strip, the doctor's checklist, the diagnostics bundle and the log.
// Talks to /api/diagnostics/* (phonegaze/diagnostics.py, phonegaze/doctor.py).

import { h, fill } from './js/util.js';

const $ = (id) => document.getElementById(id);

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `${path}: HTTP ${res.status}`);
  return data;
}

function num(v, digits = 0, unit = '') {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '–';
}

function browserScreen() {
  const s = window.screen || {};
  return {
    screen_width: s.width,
    screen_height: s.height,
    device_pixel_ratio: window.devicePixelRatio,
    screen_x: window.screenX,
    screen_y: window.screenY,
    inner_width: window.innerWidth,
    inner_height: window.innerHeight,
    fullscreen: Boolean(document.fullscreenElement),
  };
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => (button.textContent = old), 1500);
  } catch {
    window.prompt('Copy this:', text);
  }
}

// ---- Health strip ----------------------------------------------------------------------------

function renderHealth(hs) {
  $('health-window').textContent = `(last ${num(hs.window_s)} s, ${hs.frames} frames)`;
  fill(
    $('strip'),
    hs.items.map((it) =>
      h(
        'div',
        { class: `stage ${it.status}`, title: `${it.label}: ${it.status}`, 'data-stage': it.id },
        h('span', { class: 'label', text: it.label }),
        h('span', { class: 'pct', text: it.pct === null ? 'n/a' : `${it.pct.toFixed(0)} %` }),
      ),
    ),
  );
  const pairs = [
    ['Mode', hs.mode || '–'],
    ['Stream', num(hs.stream_fps, 1, ' fps')],
    ['Processed', num(hs.processed_fps, 1, ' fps')],
    ['Capture→Mac', num(hs.latency_ms, 0, ' ms')],
    ['Processing', num(hs.processing_ms, 0, ' ms')],
    ['Iris', num(hs.iris_px, 0, ' px')],
    [
      'Distance',
      `${num(hs.distance_cm, 0, ' cm')}${hs.distance_source ? ` (${hs.distance_source})` : ''}`,
    ],
    ['Sharpness', num(hs.sharpness, 3)],
    ['Brightness', num(hs.brightness, 0)],
    ['Blinks', num(hs.blink_rate_per_min, 0, '/min')],
  ];
  fill(
    $('health-numbers'),
    pairs.map(([k, v]) => h('span', {}, `${k} `, h('b', { text: v }))),
  );
  const bad = (hs.geometry || []).filter((g) => g.ok === false);
  const reasons = Object.entries(hs.unusable_reasons || {});
  fill(
    $('health-geometry'),
    bad.length
      ? h('p', {
          class: 'bad',
          text: `Implausible: ${bad.map((g) => `${g.name} ${num(g.value, 2)} (expected ${g.expected[0]}–${g.expected[1]})`).join('; ')}`,
        })
      : null,
    reasons.length
      ? h('p', {
          class: 'muted',
          text: `Unusable frames: ${reasons.map(([k, v]) => `${k} ${v} %`).join(', ')}`,
        })
      : null,
  );
}

async function pollHealth() {
  try {
    renderHealth(await call('GET', '/api/diagnostics/health'));
  } catch (err) {
    fill($('strip'), h('span', { class: 'bad', text: `Engine not answering: ${err.message}` }));
  }
}

// ---- Doctor ----------------------------------------------------------------------------------

let lastReport = null;

function reportText(rep) {
  const lines = [`Phone Gaze doctor (${rep.started}, ${rep.duration_s} s)`];
  let group = null;
  for (const c of rep.checks) {
    if (c.group !== group) {
      group = c.group;
      lines.push('', group || 'Other');
    }
    lines.push(`  ${c.status.toUpperCase().padEnd(4)}  ${c.title}: ${c.verdict}`);
    if (c.fix && (c.status === 'fail' || c.status === 'warn')) lines.push(`        Fix: ${c.fix}`);
  }
  const n = rep.counts || {};
  lines.push('', `${n.ok || 0} ok, ${n.warn || 0} warnings, ${n.fail || 0} failures`);
  return lines.join('\n');
}

function renderReport(rep) {
  const rows = [];
  let group = null;
  for (const c of rep.checks) {
    if (c.group !== group) {
      group = c.group;
      rows.push(h('tr', { class: 'group' }, h('th', { colspan: 2, text: group || 'Other' })));
    }
    rows.push(
      h(
        'tr',
        { 'data-check': c.id, 'data-status': c.status },
        h('td', {}, h('span', { class: `badge ${c.status}`, text: c.status })),
        h(
          'td',
          {},
          h('strong', { text: c.title }),
          `: ${c.verdict}`,
          c.fix && (c.status === 'fail' || c.status === 'warn')
            ? h('div', { class: 'fix', text: `Fix: ${c.fix}` })
            : null,
        ),
      ),
    );
  }
  const n = rep.counts || {};
  fill(
    $('doctor-out'),
    h('p', {
      class: rep.worst === 'fail' ? 'bad' : rep.worst === 'warn' ? 'warn' : 'good',
      text: `${n.ok || 0} ok, ${n.warn || 0} warnings, ${n.fail || 0} failures`,
    }),
    h('table', { class: 'checks' }, h('tbody', {}, rows)),
  );
}

async function runDoctor() {
  const button = $('doctor-run');
  const seconds = Number($('doctor-seconds').value) || 5;
  button.disabled = true;
  $('doctor-status').textContent = `Checking (about ${seconds + 2} s)…`;
  try {
    lastReport = await call('POST', '/api/diagnostics/doctor', {
      seconds,
      browser: browserScreen(),
    });
    renderReport(lastReport);
    $('doctor-copy').disabled = false;
    $('doctor-status').textContent = '';
  } catch (err) {
    $('doctor-status').textContent = `Failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---- Bundle ----------------------------------------------------------------------------------

let lastBundle = null;

async function writeBundle() {
  const button = $('bundle-run');
  button.disabled = true;
  $('bundle-status').textContent = 'Writing (runs the checks first, a few seconds)…';
  try {
    lastBundle = await call('POST', '/api/diagnostics/bundle', {
      include_images: $('bundle-images').checked,
      browser: browserScreen(),
      seconds: 2,
    });
    $('bundle-status').textContent =
      `Written to ${lastBundle.path}` +
      (lastBundle.images ? ' (with images of your face: keep it private)' : ' (no images)');
    $('bundle-summary').hidden = false;
    $('bundle-summary').textContent = lastBundle.summary;
    $('bundle-copy').disabled = false;
    $('bundle-reveal').disabled = false;
  } catch (err) {
    $('bundle-status').textContent = `Failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---- Log -------------------------------------------------------------------------------------

async function loadLog() {
  try {
    const res = await call('GET', '/api/diagnostics/log?lines=400');
    $('log-path').textContent = res.path ? `(${res.path})` : '(log file off)';
    let lines = res.lines || [];
    if ($('log-problems').checked) lines = lines.filter((l) => /WARNING|ERROR|CRITICAL/.test(l));
    $('log-out').textContent = lines.join('\n') || 'Nothing logged yet.';
    $('log-out').scrollTop = $('log-out').scrollHeight;
  } catch (err) {
    $('log-out').textContent = `Could not read the log: ${err.message}`;
  }
}

// ---- Start -----------------------------------------------------------------------------------

async function init() {
  try {
    const cfg = await call('GET', '/api/config');
    const d = (cfg.values && cfg.values.diagnostics) || {};
    if (typeof d.doctor_seconds === 'number') $('doctor-seconds').value = d.doctor_seconds;
    $('bundle-images').checked = Boolean(d.bundle_images);
    const theme = cfg.values && cfg.values.ui && cfg.values.ui.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {
    // The page still works with its defaults.
  }
  $('doctor-run').addEventListener('click', runDoctor);
  $('doctor-copy').addEventListener(
    'click',
    (e) => lastReport && copy(reportText(lastReport), e.target),
  );
  $('bundle-run').addEventListener('click', writeBundle);
  $('bundle-copy').addEventListener(
    'click',
    (e) => lastBundle && copy(lastBundle.summary, e.target),
  );
  $('bundle-reveal').addEventListener('click', () =>
    call('POST', '/api/diagnostics/reveal').catch(() => {}),
  );
  $('log-refresh').addEventListener('click', loadLog);
  $('log-problems').addEventListener('change', loadLog);
  pollHealth();
  window.setInterval(pollHealth, 1000);
  loadLog();
}

init();
