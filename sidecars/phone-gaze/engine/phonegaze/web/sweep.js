/* global document, fetch, navigator, setTimeout, clearTimeout */
// Sweep page: start an offline sweep of recorded setups, follow its progress (it runs in its
// own process, so a reload just picks it up again), read the leaderboard and the diagnosis,
// apply the winner. Talks to /api/sweep/* (phonegaze/sweep.py register()).

import { h, fill, fmt, store, save } from './js/util.js';

const $ = (id) => document.getElementById(id);
let selected = store('sweep.selected', null);
let timer = null;

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

function duration(s) {
  if (typeof s !== 'number') return '–';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Seconds since the sweep started (from its start time, so it moves between progress writes). */
function runningFor(s) {
  const t = Date.parse(s.started || '');
  if (Number.isFinite(t)) return Math.max(0, (Date.now() - t) / 1000);
  return typeof s.elapsed_s === 'number' ? s.elapsed_s : null;
}

function ci(v) {
  return Array.isArray(v) ? `${fmt(v[0], 2)}–${fmt(v[1], 2)}` : '–';
}

function table(head, rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'tr',
        {},
        head.map((t) => h('th', { text: t })),
      ),
      rows,
    ),
  );
}

async function loadTargets() {
  try {
    const data = await call('GET', '/api/sweep/targets');
    $('targets-where').textContent = `Recordings folder: ${data.root}`;
    const sel = $('target');
    const opts = [];
    for (const r of data.runs) {
      opts.push(
        h('option', {
          value: r.run_id,
          text: `Collection run ${r.run_id}${r.recordings !== null ? ` (${r.recordings} setups)` : ''}`,
        }),
      );
    }
    if (data.recordings.length) {
      opts.push(h('option', { value: data.root, text: 'Every recording in the folder' }));
    }
    for (const r of data.recordings) {
      opts.push(h('option', { value: r.path, text: `${r.name} (${r.kind})` }));
    }
    if (!opts.length) {
      opts.push(h('option', { value: '', text: 'Nothing recorded yet: run a collection first' }));
    }
    fill(sel, opts);
  } catch (err) {
    $('targets-where').textContent = err.message;
  }
}

async function start() {
  const target = $('target-path').value.trim() || $('target').value;
  const msg = $('start-msg');
  if (!target) {
    msg.textContent = 'Choose what to sweep first.';
    return;
  }
  msg.textContent = 'Reading the recordings…';
  try {
    const r = await call('POST', '/api/sweep/start', {
      target,
      minutes: Number($('minutes').value) || 45,
      max_combos: Number($('combos').value) || null,
    });
    msg.textContent =
      `Started "${r.name}" on ${r.conditions} setup(s).` +
      (r.notes && r.notes.length ? ` Notes: ${r.notes.join('; ')}` : '');
    selected = r.name;
    save('sweep.selected', selected);
    refresh();
  } catch (err) {
    msg.textContent = err.message;
  }
}

function stageText(s) {
  const t = {
    starting: 'Starting',
    observations: 'Reading the recordings (stage 1)',
    fitting: 'Fitting setups (stage 2)',
    reports: 'Writing the reports',
    done: 'Done',
    failed: 'Failed',
    interrupted: 'Stopped',
    stopped: 'Stopped',
  };
  return t[s.stage] || s.stage || '–';
}

async function loadList() {
  try {
    const data = await call('GET', '/api/sweep/list');
    if (!data.sweeps.length) {
      fill($('sweeps'), h('p', { class: 'muted', text: `No sweeps yet (${data.folder}).` }));
      return [];
    }
    if (!selected || !data.sweeps.some((s) => s.name === selected)) {
      selected = data.sweeps[0].name;
    }
    fill(
      $('sweeps'),
      table(
        ['Sweep', 'State', 'Updated', ''],
        data.sweeps.map((s) =>
          h(
            'tr',
            { class: s.name === selected ? 'selected' : '' },
            h('td', { text: s.name, title: s.path }),
            h('td', { text: stageText(s) + (s.running ? ' (running)' : '') }),
            h('td', { text: (s.updated || '').replace('T', ' ') }),
            h(
              'td',
              {},
              h('button', {
                text: 'Show',
                onclick: () => {
                  selected = s.name;
                  save('sweep.selected', selected);
                  refresh();
                },
              }),
            ),
          ),
        ),
      ),
    );
    return data.sweeps;
  } catch (err) {
    fill($('sweeps'), h('p', { class: 'job-failed', text: err.message }));
    return [];
  }
}

function progressView(s) {
  const pct = s.total ? Math.min(100, Math.round((100 * (s.done || 0)) / s.total)) : null;
  const parts = [
    h('h3', { text: `${s.name}: ${stageText(s)}` }),
    h('p', { class: 'small', text: s.message || '' }),
  ];
  if (s.running) {
    parts.push(
      h('progress', { max: 100, value: pct === null ? 0 : pct, 'aria-label': 'Progress' }),
      h('p', {
        class: 'small',
        'data-testid': 'sweep-eta',
        text:
          `${s.evaluated || 0} setups fitted so far` +
          (runningFor(s) !== null ? `; running for ${duration(runningFor(s))}` : '; starting') +
          (typeof s.eta_s === 'number' ? `, about ${duration(s.eta_s)} left in this step` : '') +
          (s.minutes ? ` (budget ${s.minutes} min)` : ''),
      }),
      h('button', {
        text: 'Stop (start again to resume)',
        onclick: async () => {
          await call('POST', '/api/sweep/stop', { name: s.name }).catch(() => null);
          refresh();
        },
      }),
    );
  }
  if (s.error) parts.push(h('p', { class: 'job-failed', text: s.error }));
  if (s.log && s.log.length && (s.running || s.stage === 'failed')) {
    parts.push(h('pre', { class: 'cli log', text: s.log.join('\n') }));
  }
  return parts;
}

function resultView(s) {
  if (!s.board) return [];
  const b = s.board;
  const out = [];
  const o = b.overall;
  if (o) {
    out.push(
      h('h3', { text: 'Best overall' }),
      h(
        'p',
        { 'data-testid': 'sweep-best' },
        h('strong', { text: `${o.label}` }),
        ` (${o.camera_label}, ${o.zoom || '?'}×): ${fmt(o.acc_deg, 2)}° (95 % ${ci(o.ci)}), confirmed ${fmt(o.confirm_deg, 2)}° on held-back dots, precision ${fmt(o.prec_deg, 2)}°.`,
        o.within_noise_of_runner_up
          ? ` Within noise of ${o.runner_up.label} (${fmt(o.runner_up.acc_deg, 2)}°).`
          : '',
      ),
      h('p', { class: 'small changes', text: `${o.fit_name} | ${o.vision_name}` }),
    );
  }
  const status = h('p', { class: 'small', role: 'status', 'data-testid': 'sweep-apply-status' });
  if (s.has_preset) {
    out.push(
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'primary',
          text: 'Apply best preset',
          'data-testid': 'sweep-apply',
          onclick: async () => {
            try {
              const r = await call('POST', '/api/sweep/apply', { name: s.name });
              const errs = Object.values(r.errors || {});
              status.textContent = errs.length
                ? `Applied with errors: ${errs.join('; ')}`
                : `Applied "${r.preset}" (${Object.keys(r.applied).length} setting(s)); it is for the ${r.camera_label || r.camera_id} at ${r.zoom || '?'}×. Calibrate on that camera next.`;
            } catch (err) {
              status.textContent = err.message;
            }
          },
        }),
        h('a', {
          href: `/api/sweep/report/${encodeURIComponent(s.name)}`,
          target: '_blank',
          text: 'Full leaderboard',
        }),
      ),
      status,
    );
  }
  out.push(h('h3', { text: 'Per setup' }));
  const diag = {};
  for (const d of s.diagnosis || []) diag[d.id] = d;
  out.push(
    table(
      ['Setup', 'Best', '95 %', 'Confirmed', 'Defaults', 'Why', 'Next'],
      (b.conditions || []).map((c) => {
        const w = c.winner || {};
        const d = diag[c.id] || {};
        return h(
          'tr',
          {},
          h('td', { text: `${c.label} (${c.camera_label}, ${c.zoom || '?'}×)` }),
          h('td', { text: c.winner ? `${fmt(w.acc_deg, 2)}°` : c.message || '–' }),
          h('td', { text: ci(w.ci) }),
          h('td', { text: c.winner ? `${fmt(w.confirm_deg, 2)}°` : '–' }),
          h('td', {
            text: c.defaults
              ? `${fmt(c.defaults.acc_deg, 2)}°${c.defaults.note ? ` (${c.defaults.note})` : ''}`
              : c.defaults_message || 'not fitted',
          }),
          h('td', { class: 'why', text: d.verdict || '–' }),
          h('td', { class: 'small', text: d.next_step || '' }),
        );
      }),
    ),
  );
  if (s.summary) {
    const pre = h('pre', { class: 'cli summary', 'data-testid': 'sweep-summary', text: s.summary });
    out.push(
      h('h3', { text: 'Summary to paste into a chat' }),
      h('button', {
        text: 'Copy',
        onclick: () => navigator.clipboard && navigator.clipboard.writeText(s.summary),
      }),
      pre,
    );
  }
  return out;
}

async function refresh() {
  if (timer) clearTimeout(timer);
  timer = null;
  await loadList();
  if (!selected) {
    fill($('current'));
    return;
  }
  let s;
  try {
    s = await call('GET', `/api/sweep/status?name=${encodeURIComponent(selected)}`);
  } catch (err) {
    fill($('current'), h('p', { class: 'job-failed', text: err.message }));
    return;
  }
  fill($('current'), progressView(s), resultView(s));
  if (s.running) timer = setTimeout(refresh, 2000);
}

$('start').addEventListener('click', start);
loadTargets();
refresh();
