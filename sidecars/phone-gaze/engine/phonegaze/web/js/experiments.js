/* global document */
// Experiments: every setting from GET /api/config rendered automatically, applied live, with
// reset to default, plus named presets (kept in this browser) that can be compared.

import { h, fill, fmt, deg, store, save, getPath } from './util.js';

// Sections that describe this machine rather than an experiment; presets leave them alone.
const NOT_IN_PRESETS = ['server.', 'phone.', 'recording.directory', 'ui.'];

function inPreset(s) {
  return !s.restart && !NOT_IN_PRESETS.some((p) => s.path.startsWith(p));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v === '') return '""';
  return String(v);
}

function loadPresets() {
  const p = store('presets', {});
  return p && typeof p === 'object' ? p : {};
}

/** Changes that make the current config equal the preset (defaults for anything it omits). */
function presetChanges(preset, settings, values) {
  const changes = {};
  for (const s of settings) {
    if (!inPreset(s)) continue;
    const want = Object.prototype.hasOwnProperty.call(preset.changes, s.path)
      ? preset.changes[s.path]
      : s.default;
    if (!same(want, getPath(values, s.path))) changes[s.path] = want;
  }
  return changes;
}

/** Remember calibration and validation results against the active preset, if it still matches. */
export function trackPresetResults(ctx) {
  ctx.api.on('calib.report', (m) => {
    const name = store('activePreset', '');
    if (!name || !ctx.config) return;
    const presets = loadPresets();
    const p = presets[name];
    if (!p) return;
    if (Object.keys(presetChanges(p, ctx.config.settings, ctx.config.values)).length) return;
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
    p.results = [...(p.results || []), entry].slice(-20);
    save('presets', presets);
  });
}

function settingRow(s, ctx, onApplied) {
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
  const el = h('section', { class: 'card wide' }, h('h2', { text: 'Presets' }), box);
  function render() {
    const presets = loadPresets();
    const names = Object.keys(presets).sort();
    const active = store('activePreset', '');
    const nameInput = h('input', {
      type: 'text',
      placeholder: 'Preset name',
      'data-testid': 'preset-name',
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
    const doCompare = () =>
      fill(
        cmp,
        compareTable(presets[a.value], presets[b.value], a.value, b.value, ctx.config.settings),
      );
    a.addEventListener('change', doCompare);
    b.addEventListener('change', doCompare);
    fill(
      box,
      h(
        'p',
        { class: 'muted' },
        'A preset stores every experiment setting that differs from its default. Calibration and validation results are remembered against the active preset while the settings still match it. Presets live in this browser only.',
      ),
      h(
        'form',
        {
          class: 'row',
          onsubmit: (e) => {
            e.preventDefault();
            const name = nameInput.value.trim();
            if (!name) return;
            const changes = {};
            for (const s of ctx.config.settings) {
              if (!inPreset(s)) continue;
              const v = getPath(ctx.config.values, s.path);
              if (!same(v, s.default)) changes[s.path] = v;
            }
            const all = loadPresets();
            all[name] = {
              changes,
              saved: new Date().toISOString(),
              results: (all[name] && all[name].results) || [],
            };
            save('presets', all);
            save('activePreset', name);
            ctx.toast(`Saved preset “${name}” (${Object.keys(changes).length} changed settings).`);
            render();
          },
        },
        nameInput,
        h('button', {
          type: 'submit',
          class: 'primary',
          text: 'Save current settings as preset',
          'data-testid': 'preset-save',
        }),
      ),
      names.length
        ? h(
            'table',
            { style: { marginTop: '10px' } },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['Preset', 'Changed settings', 'Latest result', ''].map((t) =>
                  h('th', { text: t }),
                ),
              ),
            ),
            h(
              'tbody',
              {},
              names.map((n) => {
                const p = presets[n];
                const lastRes = (p.results || [])[p.results ? p.results.length - 1 : 0];
                return h(
                  'tr',
                  { class: n === active ? 'chosen' : '' },
                  h('td', { text: `${n}${n === active ? ' (active)' : ''}` }),
                  h('td', {
                    class: 'small',
                    text:
                      Object.entries(p.changes)
                        .map(([k, v]) => `${k} = ${show(v)}`)
                        .join('; ') || 'all defaults',
                  }),
                  h('td', { class: 'small', text: lastRes ? resultText(lastRes) : '–' }),
                  h(
                    'td',
                    {},
                    h(
                      'div',
                      { class: 'row' },
                      h('button', {
                        text: 'Apply',
                        onclick: async () => {
                          const changes = presetChanges(p, ctx.config.settings, ctx.config.values);
                          try {
                            const res = await ctx.api.post('/api/config', { changes });
                            ctx.config.values = res.values;
                            const errs = Object.entries(res.errors || {});
                            if (errs.length)
                              ctx.toast(errs.map(([k, v]) => `${k}: ${v}`).join(' '), 'error');
                            else ctx.toast(`Applied “${n}”.`);
                            save('activePreset', n);
                          } catch (err) {
                            ctx.toast(err.message, 'error');
                          }
                          rerender();
                        },
                      }),
                      h('button', {
                        class: 'danger',
                        text: 'Delete',
                        onclick: () => {
                          const all = loadPresets();
                          delete all[n];
                          save('presets', all);
                          if (store('activePreset', '') === n) save('activePreset', '');
                          render();
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

function compareTable(pa, pb, na, nb, settings) {
  if (!pa || !pb) return null;
  const paths = new Set([...Object.keys(pa.changes), ...Object.keys(pb.changes)]);
  const def = Object.fromEntries(settings.map((s) => [s.path, s.default]));
  const val = (p, k) =>
    Object.prototype.hasOwnProperty.call(p.changes, k) ? p.changes[k] : def[k];
  const best = (p, key) => {
    const xs = (p.results || []).map((r) => r[key]).filter((x) => typeof x === 'number');
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
        h('td', { text: deg(best(pa, 'accuracy_deg')) }),
        h('td', { text: deg(best(pb, 'accuracy_deg')) }),
      ),
      h(
        'tr',
        {},
        h('td', { text: 'Best cross-validated error' }),
        h('td', { text: deg(best(pa, 'loo_error_deg')) }),
        h('td', { text: deg(best(pb, 'loo_error_deg')) }),
      ),
      h(
        'tr',
        {},
        h('td', { text: 'Results recorded' }),
        h('td', { text: fmt((pa.results || []).length, 0) }),
        h('td', { text: fmt((pb.results || []).length, 0) }),
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
    return () => {};
  },
};
