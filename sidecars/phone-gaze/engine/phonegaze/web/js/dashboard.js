/* global window */
// Dashboard: in simple mode (ui.simple_mode, the default) five big actions (Collect data, Run
// sweep, Apply best preset, Calibrate, Validate), the phone connection and the doctor's verdict in
// one line, with everything else folded under "Advanced": health, camera, estimators, models and
// their errors, more actions and the shortcut legend.

import { h, fill, fmt, deg, store, save, kbd } from './util.js';

const SWEEP_COMMAND = 'sidecars/phone-gaze/run.sh sweep <run id>';
let doctorLine = null; // the doctor's last verdict, kept for this page load
let doctorRunning = false;
let sweepPage = null; // 'sweep.html' when the sweep page is installed

async function findSweepPage() {
  if (sweepPage !== null) return sweepPage;
  try {
    const res = await window.fetch('sweep.html', { method: 'HEAD' });
    sweepPage = res.ok ? 'sweep.html' : '';
  } catch {
    sweepPage = '';
  }
  return sweepPage;
}

function doctorText(rep) {
  const c = rep.counts || {};
  const worst = (rep.checks || []).find((x) => x.status === rep.worst);
  if (rep.worst === 'ok')
    return { cls: 'good', text: `Doctor: all ${(rep.checks || []).length} checks OK.` };
  const label = rep.worst === 'fail' ? 'FAIL' : 'WARN';
  return {
    cls: rep.worst === 'fail' ? 'bad' : 'warn',
    text: `Doctor: ${c.fail || 0} FAIL, ${c.warn || 0} WARN. ${label}: ${worst ? `${worst.title}: ${worst.verdict}` : ''}`,
  };
}

function simpleCard(ctx) {
  const { api } = ctx;
  const conn = h('p', { class: 'simple-line', 'data-testid': 'simple-connection' });
  const doctor = h('p', { class: 'simple-line small muted', 'data-testid': 'simple-doctor' });
  const message = h('p', { class: 'simple-line', 'data-testid': 'simple-message' });
  const sweep = h('a', {
    class: 'button',
    href: '#dashboard',
    text: 'Run sweep',
    'data-testid': 'simple-sweep',
    onclick: (e) => {
      if (sweep.getAttribute('href') === '#dashboard') {
        e.preventDefault();
        fill(
          message,
          'The sweep page is not installed yet. Run the sweep from a terminal, at the repository root: ',
          h('code', { text: SWEEP_COMMAND }),
        );
      }
    },
  });
  findSweepPage().then((pg) => {
    if (pg) sweep.setAttribute('href', pg);
  });
  async function applyBest() {
    try {
      const ans = await api.post('/api/collect/best-preset/apply');
      const p = ans.preset || {};
      const where = [p.camera, p.zoom ? `${p.zoom}x` : ''].filter(Boolean).join(' at ');
      message.textContent = `Applied "${p.name}"${where ? `, found for the ${where}` : ''}${p.description ? `: ${p.description}` : '.'}`;
      message.className = 'simple-line good';
      ctx.loadConfig(true).catch(() => {});
      api.refreshState().catch(() => {});
    } catch (err) {
      message.textContent = err.message;
      message.className = 'simple-line bad';
    }
  }
  async function runDoctor() {
    if (doctorRunning) return;
    doctorRunning = true;
    doctor.textContent = 'Doctor: checking…';
    try {
      const rep = await api.post('/api/diagnostics/doctor', { seconds: 2 });
      doctorLine = doctorText(rep);
    } catch (err) {
      doctorLine = { cls: 'bad', text: `Doctor: could not run (${err.message})` };
    } finally {
      doctorRunning = false;
    }
    showDoctor();
  }
  function showDoctor() {
    if (!doctorLine) return;
    fill(
      doctor,
      `${doctorLine.text} `,
      h('a', { href: 'diagnostics.html', text: 'Details' }),
      ' · ',
      h('a', {
        href: '#dashboard',
        text: 'Check again',
        'data-testid': 'simple-doctor-again',
        onclick: (e) => {
          e.preventDefault();
          runDoctor();
        },
      }),
    );
    doctor.className = `simple-line small ${doctorLine.cls}`;
  }
  const el = h(
    'section',
    { class: 'card wide simple', 'data-testid': 'simple' },
    h('h2', { text: 'Start here' }),
    h(
      'div',
      { class: 'bigbuttons' },
      h('a', {
        class: 'button primary',
        href: '#collect',
        text: 'Collect data',
        'data-testid': 'simple-collect',
      }),
      sweep,
      h('button', {
        class: 'big',
        text: 'Apply best preset',
        'data-testid': 'simple-best',
        onclick: applyBest,
      }),
      h('button', {
        class: 'primary big',
        text: 'Calibrate',
        'data-testid': 'calibrate',
        onclick: () => ctx.calibrate('full'),
      }),
      h('button', {
        class: 'big',
        text: 'Validate',
        'data-testid': 'validate',
        onclick: () => ctx.calibrate('validate'),
      }),
    ),
    conn,
    doctor,
    message,
  );
  let asked = false;
  return {
    el,
    update(st) {
      const p = st.phone || {};
      const pl = st.pipeline || {};
      const state = p.state || (p.connected ? 'connected' : 'disconnected');
      const what = p.simulated ? 'simulator' : p.replay ? 'replay' : 'phone';
      conn.textContent =
        state === 'connected'
          ? `Connected to the ${what}: ${fmt(pl.fps, 0, ' fps')}, ${fmt(pl.latency_ms, 0, ' ms')} latency${st.paused ? ', paused' : ''}.`
          : state === 'connecting'
            ? 'Connecting to the phone…'
            : 'No phone connected: type its address below, or use the simulator.';
      conn.className = `simple-line ${state === 'connected' ? 'good' : state === 'connecting' ? 'warn' : 'bad'}`;
      if (doctorLine) showDoctor();
      else if (!asked && state === 'connected') {
        asked = true;
        runDoctor();
      } else if (!doctorLine && !doctorRunning)
        doctor.textContent = 'Doctor: runs once the phone is connected.';
    },
  };
}

function connectionCard(ctx) {
  const { api } = ctx;
  const url = h('input', {
    type: 'text',
    class: 'url',
    placeholder: 'http://192.168.1.20:8080',
    value: store('phoneUrl', ''),
    'data-testid': 'phone-url',
  });
  const status = h('div', { class: 'stack', 'data-testid': 'conn-status' });
  const busy = (b) => {
    for (const btn of card.querySelectorAll('button')) btn.disabled = b;
  };
  async function connect(body) {
    busy(true);
    try {
      await api.post('/api/phone/connect', body);
      await api.refreshState();
    } catch (err) {
      ctx.toast(err.message, 'error');
    } finally {
      busy(false);
    }
  }
  const card = h(
    'section',
    { class: 'card' },
    h('h2', { text: 'Phone' }),
    h(
      'form',
      {
        class: 'row',
        onsubmit: (e) => {
          e.preventDefault();
          let u = url.value.trim();
          if (!u) return ctx.toast('Type the address the phone app shows.', 'warning');
          if (!/^https?:\/\//.test(u)) u = `http://${u}`;
          if (!/:\d+$/.test(u.replace(/\/$/, ''))) u = `${u.replace(/\/$/, '')}:8080`;
          url.value = u;
          save('phoneUrl', u);
          connect({ url: u });
        },
      },
      url,
      h('button', { class: 'primary', type: 'submit', text: 'Connect', 'data-testid': 'connect' }),
    ),
    h(
      'div',
      { class: 'row', style: { marginTop: '8px' } },
      h('button', {
        text: 'Use the simulator',
        'data-testid': 'connect-sim',
        onclick: () => connect({ sim: true }),
      }),
      h('button', {
        text: 'Simulator (ARKit)',
        onclick: () => connect({ sim: true, camera: 'arkit' }),
      }),
      h('button', {
        text: 'Disconnect',
        onclick: async () => {
          try {
            await api.post('/api/phone/disconnect');
            await api.refreshState();
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        },
      }),
    ),
    status,
  );
  function update(st) {
    const p = st.phone || {};
    const pl = st.pipeline || {};
    if (!url.value && p.url && !p.simulated) url.value = p.url;
    const state = p.state || (p.connected ? 'connected' : 'disconnected');
    const cls = state === 'connected' ? 'good' : state === 'connecting' ? 'warn' : 'bad';
    const device = (p.hello && p.hello.device && p.hello.device.model) || '';
    fill(
      status,
      h(
        'div',
        { class: `stat ${cls}`, 'data-testid': 'phone-state' },
        state === 'connected'
          ? p.simulated
            ? 'Simulator connected'
            : p.replay
              ? 'Replaying'
              : 'Connected'
          : state,
      ),
      h('div', { class: 'muted' }, [device, p.detail || p.url].filter(Boolean).join(' · ')),
      h(
        'div',
        { class: 'stats' },
        statBox('Frame rate', fmt(pl.fps, 1, ' fps'), 'fps'),
        statBox('Phone sends', fmt(pl.stream_fps, 1, ' fps')),
        statBox('Latency', fmt(pl.latency_ms, 0, ' ms'), 'latency'),
        statBox('Dropped', fmt(pl.dropped, 0)),
        statBox('Clock round trip', fmt(p.clock_round_trip_ms, 1, ' ms')),
      ),
      p.status && p.status.thermalState
        ? h('div', { class: 'muted small', text: `Phone temperature: ${p.status.thermalState}` })
        : null,
    );
  }
  return { el: card, update };
}

function statBox(label, value, testid) {
  return h(
    'div',
    {},
    h('div', { class: 'muted small', text: label }),
    h('div', { class: 'stat', text: value, 'data-testid': testid ? `stat-${testid}` : undefined }),
  );
}

function actionsCard(ctx, simple) {
  const pause = h('button', {
    class: 'big',
    text: 'Pause',
    'data-testid': 'pause',
    onclick: () => ctx.togglePause(),
  });
  const el = h(
    'section',
    { class: 'card wide' },
    h('h2', { text: 'Actions' }),
    h(
      'div',
      { class: 'bigbuttons' },
      h('button', {
        class: 'primary big',
        text: 'Calibrate',
        'data-testid': simple ? 'calibrate-advanced' : 'calibrate',
        onclick: () => ctx.calibrate('full'),
      }),
      h('button', {
        class: 'big',
        text: 'Quick refine',
        'data-testid': 'refine',
        onclick: () => ctx.calibrate('refine'),
      }),
      h('button', {
        class: 'big',
        text: 'Validate',
        'data-testid': simple ? 'validate-advanced' : 'validate',
        onclick: () => ctx.calibrate('validate'),
      }),
      h('button', {
        class: 'big',
        text: 'Moving dot only',
        onclick: () => ctx.calibrate('pursuit'),
      }),
      pause,
    ),
  );
  return {
    el,
    update(st) {
      pause.textContent = st.paused ? 'Resume' : 'Pause';
      pause.classList.toggle('primary', Boolean(st.paused));
    },
  };
}

function cameraCard() {
  const body = h('div');
  const el = h('section', { class: 'card' }, h('h2', { text: 'Camera and estimators' }), body);
  return {
    el,
    update(st) {
      const c = st.camera || {};
      const s = (st.phone && st.phone.status) || {};
      fill(
        body,
        h(
          'dl',
          { class: 'kv' },
          h('dt', { text: 'Camera' }),
          h(
            'dd',
            { 'data-testid': 'camera' },
            [c.position, c.type].filter(Boolean).join(' ') || '–',
          ),
          h('dt', { text: 'Zoom' }),
          h('dd', { text: c.zoom ? `${fmt(c.zoom, 2)}×` : '–' }),
          h('dt', { text: 'Image' }),
          h('dd', {
            text: c.width
              ? `${c.width} × ${c.height}${c.rotation ? `, turned ${c.rotation}°` : ''}`
              : '–',
          }),
          h('dt', { text: 'Mode' }),
          h('dd', { text: c.mode || '–' }),
          h('dt', { text: 'Focus' }),
          h('dd', { text: focusText(s) }),
          h('dt', { text: 'Estimators' }),
          h('dd', {
            'data-testid': 'estimators',
            text: (st.estimators || []).join(', ') || 'none',
          }),
          h('dt', { text: 'Screen' }),
          h('dd', { text: screenText(st.screen) }),
        ),
        timingsTable(st.pipeline && st.pipeline.timings_ms),
      );
    },
  };
}

export function focusText(s) {
  if (!s) return '–';
  if (s.adjustingFocus) return 'focusing…';
  if (s.focusLocked)
    return `locked${typeof s.lensPosition === 'number' ? ` (lens ${s.lensPosition.toFixed(2)})` : ''}`;
  if (s.focusLocked === false) return 'automatic';
  return '–';
}

function screenText(sc) {
  if (!sc || !sc.width) return '–';
  const mm = sc.width_mm
    ? `, ${Math.round(sc.width_mm)} × ${Math.round(sc.height_mm)} mm`
    : ', size unknown';
  return `${sc.name ? `${sc.name}: ` : ''}${Math.round(sc.width)} × ${Math.round(sc.height)} pt${mm} (${sc.source || '?'})`;
}

function timingsTable(t) {
  if (!t || !Object.keys(t).length) return null;
  return h(
    'details',
    { style: { marginTop: '10px' } },
    h('summary', { class: 'muted small', text: 'Time per stage' }),
    h(
      'table',
      {},
      h(
        'tbody',
        {},
        Object.entries(t).map(([k, v]) =>
          h('tr', {}, h('td', { text: k }), h('td', { class: 'num', text: fmt(v, 2, ' ms') })),
        ),
      ),
    ),
  );
}

function modelsCard(ctx) {
  const body = h('div', { class: 'tablewrap' });
  const pin = h('select', {
    'data-testid': 'pin-model',
    onchange: async (e) => {
      try {
        await ctx.api.post('/api/model', { pinned: e.target.value });
        await ctx.api.refreshState();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    },
  });
  const active = h('div', { class: 'stat', 'data-testid': 'active-model' });
  const el = h(
    'section',
    { class: 'card wide' },
    h('h2', { text: 'Gaze models' }),
    h(
      'div',
      { class: 'row' },
      h('div', {}, h('div', { class: 'muted small', text: 'In use' }), active),
      h('label', { class: 'row', style: { marginLeft: 'auto' } }, 'Choose model: ', pin),
    ),
    body,
    h(
      'p',
      { class: 'muted small' },
      'Cross-validated: leave-one-dot-out error on the calibration dots (used to choose). ',
      'Validated: error on fresh dots never used for fitting. Lower is better.',
    ),
  );
  return {
    el,
    update(st) {
      const cal = st.calibration || {};
      active.textContent = cal.active || cal.chosen || 'none: calibrate first';
      const names = new Set([...(cal.models || []), ...(cal.reports || []).map((r) => r.model)]);
      const want = cal.pinned || '';
      fill(
        pin,
        h('option', { value: '', text: `Automatic${cal.chosen ? ` (${cal.chosen})` : ''}` }),
      );
      for (const n of names) pin.appendChild(h('option', { value: n, text: n }));
      pin.value = want;
      const reports = cal.reports || [];
      const val = cal.validation || {};
      if (!reports.length && !Object.keys(val).length) {
        fill(body, h('p', { class: 'muted', text: 'No calibration yet. Press Calibrate.' }));
        return;
      }
      const rows = [...names].map((n) => {
        const r = reports.find((x) => x.model === n) || {};
        const v = val[n] || {};
        const isActive = n === (cal.active || cal.chosen);
        return h(
          'tr',
          { class: isActive ? 'chosen' : '' },
          h('td', { text: `${n}${isActive ? ' ●' : ''}` }),
          h('td', { class: 'num', text: r.ok === false ? 'failed' : deg(r.loo_error_deg) }),
          h('td', { class: 'num', text: deg(r.train_error_deg) }),
          h('td', { class: 'num', text: deg(r.precision_deg) }),
          h('td', { class: 'num', text: deg(v.accuracy_deg) }),
          h('td', { class: 'num', text: deg(v.precision_deg) }),
          h('td', { class: 'num', text: fmt(r.n_dots, 0) }),
          h('td', { class: 'muted small', text: r.message || v.error || '' }),
        );
      });
      fill(
        body,
        h(
          'table',
          { 'data-testid': 'models-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              [
                'Model',
                'Cross-validated',
                'Training',
                'Precision',
                'Validated',
                'Validated precision',
                'Dots',
                'Note',
              ].map((t, i) => h('th', { class: i && i < 7 ? 'num' : '', text: t })),
            ),
          ),
          h('tbody', {}, rows),
        ),
      );
    },
  };
}

function outputsCard(ctx) {
  const body = h('div');
  const el = h('section', { class: 'card' }, h('h2', { text: 'Outputs and shortcuts' }), body);
  return {
    el,
    update(st) {
      const o = st.outputs || {};
      const hk = (ctx.config && ctx.config.values && ctx.config.values.hotkeys) || {};
      const legend = [
        ['Calibrate', hk.recalibrate, 'C'],
        ['Quick refine', hk.quick_refine, 'R'],
        ['Validate', hk.validate, 'V'],
        ['Pause / resume', hk.pause, 'P'],
      ];
      fill(
        body,
        h(
          'dl',
          { class: 'kv' },
          h('dt', { text: 'System cursor' }),
          h('dd', { text: o.cursor_status || (o.cursor ? 'on' : 'off') }),
          h('dt', { text: 'Dwell click' }),
          h('dd', { text: o.dwell_status || (o.dwell_click ? 'on' : 'off') }),
          h('dt', { text: 'Gaze WebSocket' }),
          h('dd', { text: `${fmt(o.websocket_clients, 0)} client(s) on /gaze` }),
          h('dt', { text: 'Global shortcuts' }),
          h('dd', { text: typeof o.hotkeys === 'string' ? o.hotkeys : '–' }),
        ),
        h(
          'table',
          { style: { marginTop: '10px' }, 'data-testid': 'shortcuts' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { text: 'Action' }),
              h('th', { text: 'Anywhere on the Mac' }),
              h('th', { text: 'On this page' }),
            ),
          ),
          h(
            'tbody',
            {},
            legend.map(([name, spec, key]) =>
              h(
                'tr',
                {},
                h('td', { text: name }),
                h('td', {}, spec ? kbd(spec) : '–'),
                h('td', {}, h('kbd', { text: key })),
              ),
            ),
            h(
              'tr',
              {},
              h('td', { text: 'Cancel calibration' }),
              h('td', { text: '' }),
              h('td', {}, h('kbd', { text: 'Esc' })),
            ),
          ),
        ),
        h('p', {
          class: 'muted small',
          text: 'Change the shortcuts and outputs on the Experiments page.',
        }),
      );
    },
  };
}

function logCard(ctx) {
  const list = h('div', { class: 'log' });
  const el = h('section', { class: 'card' }, h('h2', { text: 'Engine messages' }), list);
  const off = ctx.api.on('log', (m) => {
    list.prepend(
      h(
        'div',
        { class: m.level === 'error' ? 'bad' : m.level === 'warning' ? 'warn' : '' },
        `${new Date().toLocaleTimeString()} ${m.message}`,
      ),
    );
    while (list.childElementCount > 100) list.lastChild.remove();
  });
  if (!list.childElementCount) list.appendChild(h('div', { class: 'muted', text: 'Nothing yet.' }));
  return { el, update() {}, off };
}

// Link to the Diagnostics page, with the live health strip (WebSocket "health" messages) in one line.
function diagnosticsCard(ctx) {
  const line = h('p', {
    class: 'muted small',
    'data-testid': 'health-line',
    text: 'Waiting for frames…',
  });
  const off = ctx.api.on('health', (m) => {
    const parts = (m.items || [])
      .filter((it) => it.status !== 'na')
      .map((it) => `${it.label} ${it.pct === null ? '–' : `${it.pct.toFixed(0)}%`}`);
    line.textContent = parts.length ? parts.join(' · ') : 'No frames yet.';
    const bad = (m.items || []).some((it) => it.status === 'bad');
    line.className = `small ${bad ? 'bad' : 'muted'}`;
  });
  const el = h(
    'section',
    { class: 'card' },
    h('h2', { text: 'Something wrong?' }),
    line,
    h('a', {
      href: 'diagnostics.html',
      'data-testid': 'diagnostics-link',
      text: 'Diagnostics: checklist with fixes, health strip, bundle for the developers',
    }),
    h(
      'p',
      { class: 'small' },
      h('a', {
        href: 'lab.html',
        'data-testid': 'lab-link',
        text: 'Lab: score recorded sessions offline, sweep settings, compare two setups (A/B)',
      }),
    ),
  );
  return { el, update() {}, off };
}

export default {
  id: 'dashboard',
  title: 'Dashboard',
  mount(root, ctx) {
    const values = ctx.config && ctx.config.values;
    const simple = !values || !values.ui || values.ui.simple_mode !== false;
    if (!simple) {
      const cards = [
        actionsCard(ctx, false),
        connectionCard(ctx),
        cameraCard(ctx),
        outputsCard(ctx),
        modelsCard(ctx),
        logCard(ctx),
        diagnosticsCard(ctx),
      ];
      root.appendChild(
        h(
          'div',
          { class: 'grid' },
          cards.map((c) => c.el),
        ),
      );
      return listen(ctx, cards);
    }
    // Simple mode: the five actions and the connection on top, the rest under "Advanced".
    const top = [simpleCard(ctx), connectionCard(ctx)];
    const rest = [
      actionsCard(ctx, true),
      cameraCard(ctx),
      outputsCard(ctx),
      modelsCard(ctx),
      logCard(ctx),
      diagnosticsCard(ctx),
    ];
    const details = h(
      'details',
      {
        class: 'advanced',
        'data-testid': 'advanced',
        open: Boolean(store('dashboardAdvanced', false)),
        ontoggle: () => save('dashboardAdvanced', details.open),
      },
      h('summary', {
        text: 'Advanced: more actions, camera, models, outputs, diagnostics and the lab',
      }),
      h(
        'div',
        { class: 'grid' },
        rest.map((c) => c.el),
      ),
    );
    root.appendChild(
      h(
        'div',
        { class: 'grid' },
        top.map((c) => c.el),
      ),
    );
    root.appendChild(details);
    return listen(ctx, [...top, ...rest]);
  },
};

function listen(ctx, cards) {
  const update = () => {
    if (!ctx.api.state) return;
    for (const c of cards) c.update(ctx.api.state);
  };
  update();
  ctx.loadConfig().then(update, () => {});
  const offs = [
    ctx.api.on('state', update),
    ctx.api.on('hello', update),
    ctx.api.on('calib.report', update),
  ];
  return () => {
    offs.forEach((f) => f());
    cards.forEach((c) => c.off && c.off());
  };
}
