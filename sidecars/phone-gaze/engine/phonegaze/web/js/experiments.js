/* global document, FileReader */
// Experiments: every setting from GET /api/config rendered automatically, applied live, with
// reset to default, plus named presets kept by the engine (phonegaze/presets.py): built-in
// starting points and your own, applied in one click, with their difference from the defaults,
// exported and imported as JSON files. Results of calibrations and validations are remembered
// against the active preset in this browser.

import { h, fill, fmt, deg, store, save, getPath } from './util.js';

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v === '') return '""';
  return String(v);
}

let presetCache = [];

function presetResults() {
  const r = store('presetResults', {});
  return r && typeof r === 'object' ? r : {};
}

/** Remember calibration and validation results against the active preset, if it still matches. */
export function trackPresetResults(ctx) {
  ctx.api.on('calib.report', async (m) => {
    const name = store('activePreset', '');
    if (!name) return;
    let listing;
    try {
      listing = await ctx.api.get('/api/presets');
    } catch {
      return;
    }
    presetCache = listing.presets || [];
    const p = presetCache.find((x) => x.name === name);
    if (!p || !p.matches) return;
    const entry = { when: new Date().toISOString(), kind: m.kind, chosen: m.chosen };
    if (m.validation) {
      const accs = Object.entries(m.validation).filter(
        ([, v]) => v && typeof v.accuracy_deg === 'number',
      );
      accs.sort((a, b) => a[1].accuracy_deg - b[1].accuracy_deg);
      if (accs.length) {
        entry.best_model = accs[0][0];
        entry.accuracy_deg = accs[0][1].accuracy_deg;
      }
    } else {
      const r = (m.reports || []).find((x) => x.model === m.chosen);
      if (r) entry.loo_error_deg = r.loo_error_deg;
    }
    const all = presetResults();
    all[name] = [...(all[name] || []), entry].slice(-20);
    save('presetResults', all);
  });
}

export function settingRow(s, ctx, onApplied) {
  const values = () => ctx.config.values;
  const err = h('div', { class: 'err' });
  const resetBtn = h('button', {
    class: 'small',
    text: 'Reset',
    title: `Default: ${show(s.default)}`,
  });
  const row = h('div', { class: 'setting', 'data-path': s.path });
  let control;
  let read;
  let write;

  if (s.type === 'bool') {
    control = h('input', { type: 'checkbox' });
    read = () => control.checked;
    write = (v) => {
      control.checked = Boolean(v);
    };
  } else if (s.choices && s.type !== 'list[str]') {
    control = h(
      'select',
      {},
      s.choices.map((c) => h('option', { value: String(c), text: show(c) })),
    );
    read = () => {
      const raw = control.value;
      const match = s.choices.find((c) => String(c) === raw);
      return match === undefined ? raw : match;
    };
    write = (v) => {
      control.value = String(v);
    };
  } else if (s.type === 'int' || s.type === 'float') {
    control = h('input', {
      type: 'number',
      step: s.type === 'int' ? '1' : 'any',
      min: s.min ?? undefined,
      max: s.max ?? undefined,
      style: { width: '120px' },
    });
    read = () => (s.type === 'int' ? parseInt(control.value, 10) : parseFloat(control.value));
    write = (v) => {
      control.value = v === null || v === undefined ? '' : String(v);
    };
  } else if (s.type === 'list[str]') {
    control = h('input', { type: 'text', style: { minWidth: '280px' } });
    read = () =>
      control.value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    write = (v) => {
      control.value = (v || []).join(', ');
    };
  } else {
    control = h('input', { type: 'text', style: { minWidth: '220px' } });
    read = () => control.value;
    write = (v) => {
      control.value = v === null || v === undefined ? '' : String(v);
    };
  }
  control.dataset.testid = `setting-${s.path}`;

  function refresh() {
    const v = getPath(values(), s.path);
    if (document.activeElement !== control) write(v);
    const changed = !same(v, s.default);
    row.classList.toggle('changed', changed);
    resetBtn.disabled = !changed;
  }

  async function apply(value) {
    if ((s.type === 'int' || s.type === 'float') && Number.isNaN(value)) {
      err.textContent = 'Not a number.';
      return;
    }
    err.textContent = '';
    try {
      const res = await ctx.api.post('/api/config', { changes: { [s.path]: value } });
      ctx.config.values = res.values;
      const e = res.errors && res.errors[s.path];
      if (e) err.textContent = e;
      else if (s.restart) err.textContent = 'Saved. Takes effect when the engine restarts.';
    } catch (ex) {
      err.textContent = ex.message;
    }
    refresh();
    onApplied();
  }

  control.addEventListener('change', () => apply(read()));
  resetBtn.addEventListener('click', () => apply(s.default));
  const range = [
    s.min !== null && s.min !== undefined ? `min ${s.min}` : '',
    s.max !== null && s.max !== undefined ? `max ${s.max}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  row.append(
    h(
      'div',
      {},
      h('div', { class: 'name', text: s.path }),
      h(
        'div',
        { class: 'row', style: { marginTop: '4px' } },
        s.restart ? h('span', { class: 'badge restart', text: 'restart' }) : null,
        h('span', { class: 'badge', text: s.type }),
      ),
    ),
    h(
      'div',
      {},
      h(
        'div',
        { class: 'control' },
        control,
        s.unit ? h('span', { class: 'muted', text: s.unit }) : null,
      ),
      h(
        'div',
        { class: 'desc' },
        s.description || '',
        ` Default: ${show(s.default)}${range ? ` (${range})` : ''}.`,
        s.type === 'list[str]' && s.choices ? ` Choices: ${s.choices.join(', ')}.` : '',
      ),
      err,
    ),
    h('div', {}, resetBtn),
  );
  refresh();
  return { row, refresh, s };
}

function presetsCard(ctx, rerender) {
  const box = h('div');
  const el = h(
    'section',
    { class: 'card wide', 'data-testid': 'presets-card' },
    h('h2', { text: 'Presets' }),
    box,
  );
  let listing = { presets: [] };

  async function call(path, body) {
    try {
      const res = await ctx.api.post(path, body);
      if (res.values) ctx.config.values = res.values;
      else ctx.config = await ctx.loadConfig(true);
      listing = res;
      presetCache = res.presets || [];
      return res;
    } catch (err) {
      ctx.toast(err.message, 'error');
      return null;
    } finally {
      rerender();
      draw();
    }
  }

  async function migrate() {
    // Presets saved by earlier versions lived in this browser only: hand them to the engine once.
    const old = store('presets', null);
    if (!old || typeof old !== 'object') return;
    for (const [name, p] of Object.entries(old)) {
      if (!p || typeof p.changes !== 'object') continue;
      try {
        await ctx.api.post('/api/presets/import', { preset: { name, changes: p.changes } });
        if (Array.isArray(p.results) && p.results.length) {
          const all = presetResults();
          all[name] = [...(all[name] || []), ...p.results].slice(-20);
          save('presetResults', all);
        }
      } catch (err) {
        ctx.toast(`Preset “${name}” from this browser was not kept: ${err.message}`, 'warning');
      }
    }
    save('presets', null);
  }

  async function load() {
    try {
      await migrate();
      listing = await ctx.api.get('/api/presets');
      presetCache = listing.presets || [];
    } catch (err) {
      fill(box, h('p', { class: 'bad', text: `Could not load presets: ${err.message}` }));
      return;
    }
    draw();
  }

  function draw() {
    const presets = listing.presets || [];
    const names = presets.map((p) => p.name);
    const active = store('activePreset', '');
    const results = presetResults();
    const nameInput = h('input', {
      type: 'text',
      placeholder: 'Preset name',
      'data-testid': 'preset-name',
    });
    const fileInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      'data-testid': 'preset-import-file',
      onchange: () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          let data;
          try {
            data = JSON.parse(String(reader.result));
          } catch (err) {
            ctx.toast(`Not a preset file: ${err.message}`, 'error');
            return;
          }
          const res = await call('/api/presets/import', { preset: data });
          if (res) ctx.toast(`Imported “${res.saved.name}”.`);
        };
        reader.readAsText(file);
      },
    });
    const a = h(
      'select',
      {},
      names.map((n) => h('option', { value: n, text: n })),
    );
    const b = h(
      'select',
      {},
      names.map((n) => h('option', { value: n, text: n })),
    );
    if (names.length > 1) b.value = names[1];
    const cmp = h('div', { class: 'tablewrap' });
    const byName = Object.fromEntries(presets.map((p) => [p.name, p]));
    const doCompare = () =>
      fill(
        cmp,
        compareTable(
          byName[a.value],
          byName[b.value],
          a.value,
          b.value,
          ctx.config.settings,
          results,
        ),
      );
    a.addEventListener('change', doCompare);
    b.addEventListener('change', doCompare);
    const current = Object.entries(listing.current || {});
    fill(
      box,
      h(
        'p',
        { class: 'muted' },
        'A preset is a named set of settings that differ from their defaults. “Replace” presets set every experiment setting (defaults for the rest); “merge” presets only change their own settings, on top of the current ones. Machine settings (phone address, cursor, shortcuts, recordings, theme) are never touched. Presets are kept by the engine in ',
        h('code', { text: listing.folder || 'presets.json' }),
        '; built-in ones cannot be changed. Results of calibrations and validations are remembered (in this browser) against the active preset while the settings still match it.',
      ),
      h(
        'p',
        { class: 'small', 'data-testid': 'preset-current' },
        current.length
          ? `Current settings differ from the defaults in ${current.length}: ${current.map(([k, v]) => `${k} = ${show(v)}`).join('; ')}.`
          : 'Current settings are all defaults.',
      ),
      h(
        'form',
        {
          class: 'row',
          onsubmit: async (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (!name) return;
            const res = await call('/api/presets/save', { name });
            if (res) {
              save('activePreset', name);
              ctx.toast(
                `Saved preset “${name}” (${Object.keys(res.saved.changes).length} changed settings).`,
              );
            }
          },
        },
        nameInput,
        h('button', {
          type: 'submit',
          class: 'primary',
          text: 'Save current settings as preset',
          'data-testid': 'preset-save',
        }),
        h('span', { class: 'muted small', text: 'Import a preset file:' }),
        fileInput,
      ),
      presets.length
        ? h(
            'table',
            { style: { marginTop: '10px' }, 'data-testid': 'preset-table' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['Preset', 'Differs from the defaults in', 'Latest result', ''].map((t) =>
                  h('th', { text: t }),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              presets.map((p) => {
                const res = results[p.name] || [];
                const lastRes = res[res.length - 1];
                const tags = [p.builtin ? 'built-in' : 'yours', p.mode, p.matches ? 'in use' : ''];
                return h(
                  'tr',
                  {
                    class: `${p.name === active ? 'chosen' : ''}`,
                    'data-preset': p.name,
                  },
                  h(
                    'td',
                    {},
                    h('div', { text: `${p.name}${p.name === active ? ' (active)' : ''}` }),
                    h('div', { class: 'muted small', text: tags.filter(Boolean).join(' · ') }),
                    p.description ? h('div', { class: 'muted small', text: p.description }) : null,
                  ),
                  h(
                    'td',
                    { class: 'small' },
                    p.diff.length
                      ? h(
                          'table',
                          { class: 'preset-diff' },
                          h(
                            'tbody',
                            {},
                            p.diff.map((d) =>
                              h(
                                'tr',
                                {},
                                h('td', { text: d.path }),
                                h('td', { text: show(d.value) }),
                                h('td', { class: 'muted', text: `default ${show(d.default)}` }),
                              ),
                            ),
                          ),
                        )
                      : 'all defaults',
                  ),
                  h('td', { class: 'small', text: lastRes ? resultText(lastRes) : '–' }),
                  h(
                    'td',
                    {},
                    h(
                      'div',
                      { class: 'row' },
                      h('button', {
                        text: 'Apply',
                        'data-testid': `preset-apply-${p.name}`,
                        onclick: async () => {
                          const r = await call('/api/presets/apply', { name: p.name });
                          if (!r) return;
                          const errs = Object.entries(r.errors || {});
                          if (errs.length)
                            ctx.toast(errs.map(([k, v]) => `${k}: ${v}`).join(' '), 'error');
                          else
                            ctx.toast(
                              `Applied “${p.name}” (${Object.keys(r.applied || {}).length} settings changed).`,
                            );
                          save('activePreset', p.name);
                        },
                      }),
                      h('a', {
                        class: 'button small',
                        text: 'Export',
                        href: `/api/presets/export?name=${encodeURIComponent(p.name)}`,
                        download: `phonegaze-preset-${p.name.replace(/[^A-Za-z0-9_-]+/g, '-')}.json`,
                      }),
                      p.builtin
                        ? null
                        : h('button', {
                            class: 'danger',
                            text: 'Delete',
                            onclick: async () => {
                              await call('/api/presets/delete', { name: p.name });
                              if (store('activePreset', '') === p.name) save('activePreset', '');
                            },
                          }),
                    ),
                  ),
                );
              }),
            ),
          )
        : null,
      names.length > 1
        ? h(
            'div',
            { style: { marginTop: '12px' } },
            h('h3', { text: 'Compare' }),
            h('div', { class: 'row' }, a, ' with ', b),
            cmp,
          )
        : null,
    );
    if (names.length > 1) doCompare();
  }
  load();
  return { el, render: load };
}

/**
 * Drift correction from selections: the switch, and the side-by-side numbers the engine keeps
 * whether or not the correction is applied (state.drift, also GET /api/drift).
 */
function driftCard(ctx) {
  const { api } = ctx;
  let pending = false;
  const toggle = h('input', {
    type: 'checkbox',
    'data-testid': 'drift-toggle',
    onchange: async (e) => {
      pending = true;
      try {
        const res = await api.post('/api/config', {
          changes: { 'calibration.drift_correction': e.target.checked },
        });
        if (ctx.config) ctx.config.values = res.values;
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
      pending = false;
      api.refreshState().catch(() => {});
    },
  });
  const status = h('p', { class: 'muted small', 'data-testid': 'drift-status' });
  const table = h('div', { class: 'tablewrap', 'data-testid': 'drift-stats' });
  const button = (text, body) =>
    h('button', {
      class: 'small',
      text,
      onclick: async () => {
        try {
          await api.post('/api/drift/reset', body);
          await api.refreshState();
        } catch (err) {
          ctx.toast(err.message, 'error');
        }
      },
    });
  const el = h(
    'section',
    { class: 'card wide', 'data-testid': 'drift-card' },
    h('h2', { text: 'Drift correction from selections' }),
    h('p', {
      class: 'muted',
      text:
        'Each key you select in Forsee by dwell is a place you looked. The engine learns a small, ' +
        'slowly changing offset from these to undo slow drift (you settling in your chair, the ' +
        'phone creeping). It is always measured, and only applied when switched on. Numbers are ' +
        'the distance from the gaze estimate to the centre of the selected key, taken before that ' +
        'key changed anything; keys you delete straight away are left out. Lower is better. ' +
        'Untested on a real phone.',
    }),
    h('label', { class: 'row' }, toggle, 'Apply drift correction to the gaze output'),
    status,
    table,
    h(
      'div',
      { class: 'row' },
      button('Forget the learned offset', { offset: true }),
      button('Clear the numbers', { offset: false, stats: true }),
    ),
  );
  const row = (label, block) => {
    const c = (block && block.corrected) || {};
    const u = (block && block.uncorrected) || {};
    return h(
      'tr',
      {},
      h('td', { text: label }),
      h('td', { text: fmt(block ? block.n : 0, 0) }),
      h('td', { text: `${deg(c.median_deg)} / ${deg(c.mean_deg)}` }),
      h('td', { text: `${deg(u.median_deg)} / ${deg(u.mean_deg)}` }),
    );
  };
  function render() {
    const d = api.state && api.state.drift;
    if (!d) {
      fill(table, h('p', { class: 'muted', text: 'No numbers yet.' }));
      return;
    }
    if (!pending) toggle.checked = Boolean(d.enabled);
    const rejected = Object.entries(d.rejected || {})
      .map(([k, v]) => `${v} ${k}`)
      .join(', ');
    status.textContent =
      `${d.enabled ? (d.applied ? 'On and applied' : 'On, waiting for selections') : 'Off (measuring only)'}` +
      ` · offset ${deg(d.offset_deg)} from ${d.used_since_reset} selection(s) since the last reset` +
      `${d.last_reset_reason ? ` (${d.last_reset_reason})` : ''}` +
      ` · ${d.undone || 0} undone${rejected ? ` · not used: ${rejected}` : ''}` +
      ` · mouse clicks ${d.clicks ? 'counted' : 'ignored'}`;
    fill(
      table,
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { text: 'Selections' }),
            h('th', { text: 'n' }),
            h('th', { text: 'With correction (median / mean)' }),
            h('th', { text: 'Without (median / mean)' }),
          ),
        ),
        h(
          'tbody',
          {},
          row('This session', d.session),
          row(`Last ${(d.settings && d.settings.recent) || 50}`, d.recent),
        ),
      ),
    );
  }
  render();
  return { el, render };
}

function resultText(r) {
  if (typeof r.accuracy_deg === 'number')
    return `validated ${deg(r.accuracy_deg)} (${r.best_model})`;
  if (typeof r.loo_error_deg === 'number')
    return `${r.kind}: ${deg(r.loo_error_deg)} cross-validated (${r.chosen})`;
  return `${r.kind}: no result`;
}

function compareTable(pa, pb, na, nb, settings, results) {
  if (!pa || !pb) return null;
  const paths = new Set([...Object.keys(pa.changes), ...Object.keys(pb.changes)]);
  const def = Object.fromEntries(settings.map((s) => [s.path, s.default]));
  const val = (p, k) =>
    Object.prototype.hasOwnProperty.call(p.changes, k) ? p.changes[k] : def[k];
  const best = (name, key) => {
    const xs = (results[name] || []).map((r) => r[key]).filter((x) => typeof x === 'number');
    return xs.length ? Math.min(...xs) : null;
  };
  return h(
    'table',
    { 'data-testid': 'preset-compare' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', { text: 'Setting' }), h('th', { text: na }), h('th', { text: nb })),
    ),
    h(
      'tbody',
      {},
      [...paths].sort().map((k) => {
        const va = val(pa, k);
        const vb = val(pb, k);
        return h(
          'tr',
          {},
          h('td', { text: k }),
          h('td', { class: same(va, vb) ? 'muted' : '', text: show(va) }),
          h('td', { class: same(va, vb) ? 'muted' : '', text: show(vb) }),
        );
      }),
      h(
        'tr',
        {},
        h('td', { text: 'Best validated accuracy' }),
        h('td', { text: deg(best(na, 'accuracy_deg')) }),
        h('td', { text: deg(best(nb, 'accuracy_deg')) }),
      ),
      h(
        'tr',
        {},
        h('td', { text: 'Best cross-validated error' }),
        h('td', { text: deg(best(na, 'loo_error_deg')) }),
        h('td', { text: deg(best(nb, 'loo_error_deg')) }),
      ),
      h(
        'tr',
        {},
        h('td', { text: 'Results recorded' }),
        h('td', { text: fmt((results[na] || []).length, 0) }),
        h('td', { text: fmt((results[nb] || []).length, 0) }),
      ),
    ),
  );
}

export default {
  id: 'experiments',
  title: 'Experiments',
  mount(root, ctx) {
    const filter = h('input', {
      type: 'search',
      placeholder: 'Filter settings',
      'data-testid': 'settings-filter',
      style: { minWidth: '260px' },
    });
    const list = h('div', { 'data-testid': 'settings' });
    let rows = [];
    let presets = null;
    const drift = driftCard(ctx);
    const offState = ctx.api.on('state', () => drift.render());
    const rerender = () => rows.forEach((r) => r.refresh());
    root.append(
      h(
        'div',
        { class: 'row', style: { marginBottom: '12px' } },
        h('h1', { text: 'Experiments', style: { margin: 0 } }),
        filter,
      ),
      h(
        'div',
        { class: 'grid' },
        h('div', { class: 'card wide', id: 'presets-slot' }),
        drift.el,
        h('section', { class: 'card wide' }, list),
      ),
    );
    fill(list, h('p', { class: 'muted', text: 'Loading settings…' }));
    ctx
      .loadConfig(true)
      .then((cfg) => {
        presets = presetsCard(ctx, rerender);
        root.querySelector('#presets-slot').replaceWith(presets.el);
        const bySection = new Map();
        for (const s of cfg.settings) {
          const sec = s.path.split('.')[0];
          if (!bySection.has(sec)) bySection.set(sec, []);
          bySection.get(sec).push(s);
        }
        rows = [];
        fill(list);
        for (const [sec, items] of bySection) {
          const sectionRows = items.map((s) =>
            settingRow(s, ctx, () => {
              if (presets) presets.render();
              ctx.applyTheme();
            }),
          );
          rows.push(...sectionRows);
          const resetAll = h('button', {
            class: 'small',
            text: `Reset ${sec} to defaults`,
            onclick: async (e) => {
              e.preventDefault();
              const changes = {};
              for (const s of items)
                if (!same(getPath(ctx.config.values, s.path), s.default))
                  changes[s.path] = s.default;
              if (!Object.keys(changes).length) return;
              try {
                const res = await ctx.api.post('/api/config', { changes });
                ctx.config.values = res.values;
              } catch (err) {
                ctx.toast(err.message, 'error');
              }
              rerender();
            },
          });
          list.appendChild(
            h(
              'details',
              { class: 'section', open: true, 'data-section': sec },
              h(
                'summary',
                {},
                `${sec} `,
                h('span', { class: 'muted small', text: `(${items.length})` }),
              ),
              h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, resetAll),
              sectionRows.map((r) => r.row),
            ),
          );
        }
      })
      .catch((err) =>
        fill(list, h('p', { class: 'bad', text: `Could not load settings: ${err.message}` })),
      );
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rows) {
        r.row.hidden = Boolean(q) && !`${r.s.path} ${r.s.description}`.toLowerCase().includes(q);
      }
    });
    return () => offState();
  },
};
