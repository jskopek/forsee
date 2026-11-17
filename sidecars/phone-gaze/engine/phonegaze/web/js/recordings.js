// Recording controls and the list of recorded sessions, with offline scoring and replay.

import { h, fill, fmt } from './util.js';

function size(bytes) {
  if (typeof bytes !== 'number') return '–';
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

export default {
  id: 'recordings',
  title: 'Recordings',
  mount(root, ctx) {
    const { api } = ctx;
    const label = h('input', {
      type: 'text',
      placeholder: 'Label (optional)',
      'data-testid': 'rec-label',
    });
    const startBtn = h('button', {
      class: 'primary big',
      text: 'Start recording',
      'data-testid': 'rec-start',
    });
    const stopBtn = h('button', { class: 'big danger', text: 'Stop', 'data-testid': 'rec-stop' });
    const now = h('div', { class: 'stat', 'data-testid': 'rec-status' });
    const list = h('div', { class: 'tablewrap', 'data-testid': 'rec-list' });
    const result = h('div');

    startBtn.addEventListener('click', async () => {
      try {
        const r = await api.post('/api/record/start', { label: label.value.trim() });
        ctx.toast(`Recording to ${r.path}`);
        await api.refreshState();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    });
    stopBtn.addEventListener('click', async () => {
      try {
        const r = await api.post('/api/record/stop');
        ctx.toast(`Stopped: ${fmt(r && r.seconds, 1)} s, ${fmt(r && r.frames, 0)} frames.`);
        await api.refreshState();
        load();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    });

    async function load() {
      try {
        const res = await api.get('/api/recordings');
        const recs = (res && res.recordings) || [];
        if (!recs.length) {
          fill(list, h('p', { class: 'muted', text: 'No recordings yet.' }));
          return;
        }
        fill(
          list,
          h(
            'table',
            {},
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                [
                  'Recording',
                  'Label',
                  'Started',
                  'Length',
                  'Frames',
                  'Size',
                  'Calibration',
                  '',
                ].map((t, i) => h('th', { class: i >= 3 && i <= 5 ? 'num' : '', text: t })),
              ),
            ),
            h(
              'tbody',
              {},
              recs.map((r) =>
                h(
                  'tr',
                  {},
                  h('td', { title: r.path || '', text: r.id }),
                  h('td', { text: r.label || '' }),
                  h('td', {
                    text: r.started_at ? String(r.started_at).replace('T', ' ').slice(0, 19) : '–',
                  }),
                  h('td', { class: 'num', text: fmt(r.seconds, 1, ' s') }),
                  h('td', { class: 'num', text: fmt(r.frames, 0) }),
                  h('td', { class: 'num', text: size(r.bytes) }),
                  h('td', { text: r.has_calibration ? 'yes' : '' }),
                  h(
                    'td',
                    {},
                    h(
                      'div',
                      { class: 'row' },
                      h('button', {
                        text: 'Score',
                        title: 'Run the recording through the estimators and models and score them',
                        onclick: async (e) => {
                          e.target.disabled = true;
                          fill(
                            result,
                            h('p', {
                              class: 'muted',
                              text: `Scoring ${r.id}… this can take a while.`,
                            }),
                          );
                          try {
                            const out = await api.post('/api/replay', { id: r.id });
                            fill(result, h('h3', { text: `Score for ${r.id}` }), scoreView(out));
                          } catch (err) {
                            fill(result, h('p', { class: 'bad', text: err.message }));
                          } finally {
                            e.target.disabled = false;
                          }
                        },
                      }),
                      h('button', {
                        text: 'Play through engine',
                        title: 'Use this recording instead of a phone',
                        onclick: async () => {
                          try {
                            await api.post('/api/phone/connect', { replay: r.id });
                            ctx.toast(`Replaying ${r.id}.`);
                            await api.refreshState();
                          } catch (err) {
                            ctx.toast(err.message, 'error');
                          }
                        },
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      } catch (err) {
        fill(list, h('p', { class: 'bad', text: `Could not list recordings: ${err.message}` }));
      }
    }

    function update() {
      const rec = api.state && api.state.recording;
      startBtn.disabled = Boolean(rec);
      stopBtn.disabled = !rec;
      now.textContent = rec ? `Recording ${rec.id}: ${fmt(rec.seconds, 0)} s` : 'Not recording';
      now.className = `stat ${rec ? 'bad' : 'muted'}`;
    }

    root.append(
      h(
        'div',
        { class: 'grid' },
        h(
          'section',
          { class: 'card wide' },
          h('h2', { text: 'Record a session' }),
          h('p', {
            class: 'muted',
            text: 'Records the phone stream, observations, gaze and any calibration on this Mac (never in the repository), so it can be scored again later with other settings.',
          }),
          h('div', { class: 'row' }, label, startBtn, stopBtn),
          h('div', { style: { marginTop: '10px' } }, now),
        ),
        h(
          'section',
          { class: 'card wide' },
          h(
            'div',
            { class: 'row' },
            h('h2', { text: 'Recorded sessions', style: { margin: 0 } }),
            h('button', { text: 'Refresh', onclick: load }),
          ),
          list,
          result,
        ),
      ),
    );
    update();
    load();
    const offs = [api.on('state', update)];
    return () => offs.forEach((f) => f());
  },
};

function scoreView(out) {
  if (!out || typeof out !== 'object') return h('pre', { text: String(out) });
  const reports = out.reports || [];
  const val = out.validation || {};
  const names = [...new Set([...reports.map((r) => r.model), ...Object.keys(val)])];
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'muted' },
      `${fmt(out.frames, 0)} frames · estimators ${(out.estimators || []).join(', ') || '–'} · ${fmt(out.n_fit_samples, 0)} fit samples, ${fmt(out.n_validation_samples, 0)} validation samples · chosen ${out.chosen || '–'}`,
    ),
    names.length
      ? h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Model', 'Cross-validated', 'Validated', 'Note'].map((t) => h('th', { text: t })),
            ),
          ),
          h(
            'tbody',
            {},
            names.map((n) => {
              const r = reports.find((x) => x.model === n) || {};
              const v = val[n] || {};
              return h(
                'tr',
                {},
                h('td', { text: n }),
                h('td', { class: 'num', text: fmt(r.loo_error_deg, 2, '°') }),
                h('td', { class: 'num', text: fmt(v.accuracy_deg, 2, '°') }),
                h('td', { class: 'muted small', text: r.message || v.error || '' }),
              );
            }),
          ),
        )
      : null,
    h(
      'details',
      {},
      h('summary', { class: 'muted small', text: 'Raw result' }),
      h('pre', { text: JSON.stringify(out, null, 2) }),
    ),
  );
}
