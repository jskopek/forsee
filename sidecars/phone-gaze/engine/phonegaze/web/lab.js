/* global window, document, fetch */
// Lab page: sessions on this computer, background lab runs, past reports, presets from tune.
// Talks to /api/lab/* (phonegaze/lab.py register()).

import { h, fill, fmt, store, save } from './js/util.js';

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

function changesText(changes) {
  const entries = Object.entries(changes || {});
  if (!entries.length) return 'no changes (the defaults)';
  return entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('; ');
}

async function runLab(path) {
  try {
    await call('POST', '/api/lab/run', { session: path });
    pollJobs();
  } catch (err) {
    fill($('jobs'), h('p', { class: 'job-failed', text: err.message }));
  }
}

async function loadSessions() {
  try {
    const data = await call('GET', '/api/lab/sessions');
    $('sessions-where').textContent = `Reports and caches go to ${data.output_dir}.`;
    if (!data.sessions.length) {
      fill(
        $('sessions'),
        h('p', {
          class: 'muted',
          text: 'No sessions found in tools/eye-capture/captures or the recordings folder. Enter a folder below.',
        }),
      );
      return;
    }
    fill(
      $('sessions'),
      table(
        ['Session', 'Kind', ''],
        data.sessions.map((s) =>
          h(
            'tr',
            {},
            h('td', { text: s.name, title: s.path }),
            h('td', { text: s.kind }),
            h('td', {}, h('button', { text: 'Run the lab', onclick: () => runLab(s.path) })),
          ),
        ),
      ),
    );
  } catch (err) {
    fill($('sessions'), h('p', { class: 'job-failed', text: err.message }));
  }
}

let polling = null;

async function pollJobs() {
  window.clearTimeout(polling);
  let data;
  try {
    data = await call('GET', '/api/lab/jobs');
  } catch {
    return;
  }
  const rows = data.jobs.map((j) =>
    h(
      'tr',
      {},
      h('td', { text: j.session }),
      h('td', {
        class: j.state === 'failed' ? 'job-failed' : '',
        text: j.state === 'failed' ? `failed: ${j.error}` : j.state,
      }),
      h('td', { class: 'small', text: (j.log || []).slice(-1)[0] || '' }),
      h(
        'td',
        {},
        j.report
          ? h('a', { href: `/api/lab/report/${encodeURIComponent(j.report)}`, text: 'Report' })
          : '',
      ),
    ),
  );
  fill($('jobs'), rows.length ? table(['Run', 'State', 'Progress', ''], rows) : '');
  if (data.jobs.some((j) => j.state === 'running')) {
    polling = window.setTimeout(pollJobs, 2000);
  } else if (rows.length) {
    loadReports();
  }
}

async function loadReports() {
  try {
    const data = await call('GET', '/api/lab/reports');
    if (!data.reports.length) {
      fill($('reports'), h('p', { class: 'muted', text: 'No reports yet.' }));
      return;
    }
    fill(
      $('reports'),
      table(
        ['Session', 'Made', 'Best per camera (held-out dot error)', ''],
        data.reports.map((r) =>
          h(
            'tr',
            {},
            h('td', { text: (r.session || r.id).split('/').slice(-1)[0], title: r.session }),
            h('td', { text: r.created || '' }),
            h(
              'td',
              {},
              (r.best || []).map((b) =>
                h('div', {
                  text: `${b.camera}: ${fmt(b.value, 2)}° (${b.model}, ${b.combo})`,
                }),
              ),
            ),
            h(
              'td',
              {},
              r.has_html
                ? h('a', { href: `/api/lab/report/${encodeURIComponent(r.id)}`, text: 'Open' })
                : '',
            ),
          ),
        ),
      ),
    );
  } catch (err) {
    fill($('reports'), h('p', { class: 'job-failed', text: err.message }));
  }
}

function addToExperiments(p) {
  const presets = store('presets', {}) || {};
  const name = `lab: ${p.name}`;
  presets[name] = { changes: p.changes, results: (presets[name] && presets[name].results) || [] };
  save('presets', presets);
  return name;
}

async function loadPresets() {
  try {
    const data = await call('GET', '/api/lab/presets');
    if (!data.presets.length) {
      fill(
        $('presets'),
        h('p', { class: 'muted', text: `No presets yet (they live in ${data.folder}).` }),
      );
      return;
    }
    const status = h('p', { class: 'small muted' });
    fill(
      $('presets'),
      table(
        ['Preset', 'Changes', 'Held-out score', ''],
        data.presets.map((p) =>
          h(
            'tr',
            {},
            h('td', { text: p.name, title: p.session || '' }),
            h('td', { class: 'changes', text: changesText(p.changes) }),
            h('td', {
              text:
                typeof p.score === 'number'
                  ? `${fmt(p.score, 2)} ${p.unit || ''}` +
                    (typeof p.nested_estimate === 'number'
                      ? ` (expect ${fmt(p.nested_estimate, 2)})`
                      : '')
                  : '–',
            }),
            h(
              'td',
              {},
              h('button', {
                text: 'Apply now',
                onclick: async () => {
                  try {
                    const r = await call('POST', '/api/lab/presets/apply', { name: p.name });
                    const errs = Object.values(r.errors || {});
                    status.textContent = errs.length
                      ? `Applied with errors: ${errs.join('; ')}`
                      : `Applied ${p.name}.`;
                  } catch (err) {
                    status.textContent = err.message;
                  }
                },
              }),
              ' ',
              h('button', {
                text: 'Add to Experiments',
                onclick: () => {
                  status.textContent = `Added as "${addToExperiments(p)}" on the Experiments page.`;
                },
              }),
            ),
          ),
        ),
      ),
      status,
    );
  } catch (err) {
    fill($('presets'), h('p', { class: 'job-failed', text: err.message }));
  }
}

$('session-run').addEventListener('click', () => {
  const path = $('session-path').value.trim();
  if (path) runLab(path);
});

loadSessions();
loadReports();
loadPresets();
pollJobs();
