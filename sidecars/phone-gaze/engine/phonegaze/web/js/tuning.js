/* global window */
// Tuning: both eye crops large with switchable overlays and live numbers, a freeze-frame button,
// tap-to-focus on an eye, and the settings that matter most for the vision stages next to them.
// Engine side: phonegaze/tuning.py (/api/tuning/*).

import { h, fill, fmt, store, save } from './util.js';
import { settingRow } from './experiments.js';

const LAYERS = [
  ['ellipse', 'Iris fit'],
  ['edge', 'Edge points'],
  ['iris', 'Iris centre'],
  ['reflection', 'Reflection'],
  ['corners', 'Eye corners'],
  ['lids', 'Eyelid mask'],
  ['crop', 'Crop rectangle'],
];

// The settings shown beside the images (all of them are on the Experiments page too).
const QUICK = [
  'estimators.iris_fit',
  'estimators.iris_edge_keep',
  'estimators.iris_lid_mask_upper_deg',
  'estimators.iris_lid_mask_lower_deg',
  'estimators.iris_subpixel',
  'estimators.iris_diameter_mm',
  'estimators.distance_source',
  'estimators.reflection_k_mad',
  'estimators.reflection_min_confidence',
  'estimators.reflection_area_max',
  'estimators.use_reflection',
  'stream.roi_width_mm',
  'lens.zoom',
  'lens.exposure_bias',
  'lens.max_exposure_ms',
  'ui.glint_marker',
  'outputs.fallback_pointer',
];

const EYE_ROWS = [
  ['iris_set_by', 'Iris from', (v) => v || '–'],
  ['iris_radius_image_px', 'Iris radius (crop px)', (v) => fmt(v, 1)],
  [
    'ellipse_axes_px',
    'Ellipse semi-axes (px)',
    (v) => (v ? `${fmt(v[0], 1)} × ${fmt(v[1], 1)}` : '–'),
  ],
  ['ellipse_ratio', 'Minor / major', (v) => fmt(v, 2)],
  ['fit_confidence', 'Fit confidence', (v) => fmt(v, 2)],
  ['fit_rms_px', 'Fit rms (px)', (v) => fmt(v, 2)],
  ['fit_inliers', 'Edge points used', (v) => fmt(v, 0)],
  ['fit_seed', 'Fit started from', (v) => v || '–'],
  ['edge_width_px', 'Edge width 10-90 % (px)', (v) => fmt(v, 2)],
  ['sharpness', 'Sharpness', (v) => fmt(v, 2)],
  ['openness', 'Openness', (v) => fmt(v, 2)],
  ['reflection_score', 'Reflection score', (v) => fmt(v, 2)],
  ['reflection_mode', 'Reflection mode', (v) => v || '–'],
  ['reflection_area_ratio', 'Reflection area / predicted', (v) => fmt(v, 2)],
  ['reflection_snr', 'Reflection SNR', (v) => fmt(v, 1)],
];

function pct(v) {
  return v === null || v === undefined ? '–' : `${Math.round(v * 100)} %`;
}

export default {
  id: 'tuning',
  title: 'Tuning',
  mount(root, ctx) {
    const { api } = ctx;
    let layers = store('tuning.layers', null);
    if (!Array.isArray(layers)) layers = LAYERS.map(([k]) => k);
    let frozen = false;
    let timer = 0;
    let busy = false;
    let alive = true;

    const imgs = {};
    const tables = {};
    const eyeCards = ['right', 'left'].map((side) => {
      imgs[side] = h('img', {
        alt: `${side} eye`,
        'data-testid': `tuning-eye-${side}`,
        class: 'tuning-eye',
      });
      tables[side] = h('tbody');
      return h(
        'section',
        { class: 'card' },
        h('h2', {
          text: side === 'right' ? 'Right eye (image left)' : 'Left eye (image right)',
        }),
        imgs[side],
        h('table', { class: 'small tuning-table' }, tables[side]),
      );
    });

    const layerBoxes = LAYERS.map(([key, label]) =>
      h(
        'label',
        { class: 'row' },
        h('input', {
          type: 'checkbox',
          checked: layers.includes(key),
          'data-testid': `layer-${key}`,
          onchange: (e) => {
            layers = e.target.checked
              ? [...new Set([...layers, key])]
              : layers.filter((x) => x !== key);
            save('tuning.layers', layers);
            refreshImages();
          },
        }),
        label,
      ),
    );

    const freezeBtn = h('button', {
      class: 'primary',
      text: 'Freeze frame',
      'data-testid': 'tuning-freeze',
      onclick: async () => {
        try {
          const res = await api.post('/api/tuning/freeze', { frozen: !frozen });
          frozen = res.frozen;
          freezeBtn.textContent = frozen ? 'Unfreeze' : 'Freeze frame';
          tick(true);
        } catch (err) {
          ctx.toast(err.message, 'error');
        }
      },
    });
    const focusBtn = (side, lock) =>
      h('button', {
        text: `${lock ? 'Focus and lock on' : 'Focus on'} ${side} eye`,
        onclick: async () => {
          try {
            await api.post('/api/tuning/focus', { side, lock });
            ctx.toast(`Focus ${lock ? 'locked' : 'set'} on the ${side} eye.`);
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        },
      });
    const unlockBtn = h('button', {
      text: 'Unlock focus',
      onclick: async () => {
        try {
          await api.post('/api/focus', { locked: false });
        } catch (err) {
          ctx.toast(err.message, 'error');
        }
      },
    });

    const summary = h('div', { class: 'stats', 'data-testid': 'tuning-summary' });
    const details = h('p', { class: 'muted small', 'data-testid': 'tuning-details' });
    const prompt = h('p', { class: 'notice', hidden: true, 'data-testid': 'brightness-prompt' });
    const quick = h('div', { 'data-testid': 'tuning-settings' });

    root.append(
      h(
        'div',
        { class: 'row', style: { marginBottom: '10px' } },
        h('h1', { text: 'Tuning', style: { margin: 0 } }),
        freezeBtn,
        focusBtn('left', false),
        focusBtn('left', true),
        unlockBtn,
      ),
      h(
        'p',
        { class: 'muted' },
        'What the estimators see, frame by frame. A wrong fit should be obvious: the coloured ring must sit on the iris edge, the magenta diamond on the screen’s reflection, the green dots on the eye corners. Change a setting below and the next frame uses it. Freeze holds one frame (images and numbers) while the engine keeps running.',
      ),
      prompt,
      h('div', { class: 'row tuning-layers' }, layerBoxes),
      h('div', { class: 'tuning-eyes' }, eyeCards),
      h('section', { class: 'card wide', style: { marginTop: '16px' } }, summary, details),
      h(
        'section',
        { class: 'card wide', style: { marginTop: '16px' } },
        h('h2', { text: 'Settings that change what you see here' }),
        quick,
      ),
    );

    function refreshImages() {
      const cfg = ctx.config && ctx.config.values && ctx.config.values.ui;
      const w = (cfg && cfg.tuning_crop_px) || 420;
      const stamp = Date.now();
      for (const side of ['left', 'right']) {
        const url = `/api/tuning/eye.jpg?side=${side}&w=${w}&layers=${layers.join(',')}&t=${stamp}`;
        const img = new window.Image();
        img.onload = () => {
          imgs[side].src = img.src;
          imgs[side].dataset.loaded = '1';
        };
        img.onerror = () => {
          imgs[side].dataset.loaded = '0';
        };
        img.src = url;
      }
    }

    function renderStats(st) {
      for (const side of ['left', 'right']) {
        const e = (st.eyes || {})[side] || {};
        fill(
          tables[side],
          EYE_ROWS.map(([key, label, f]) =>
            h(
              'tr',
              {},
              h('td', { class: 'muted', text: label }),
              h('td', { 'data-key': `${side}.${key}`, text: f(e[key]) }),
            ),
          ),
        );
      }
      const r = st.rates || {};
      const d = st.distance || {};
      const stat = (label, value, id) =>
        h(
          'div',
          {},
          h('div', { class: 'muted small', text: label }),
          h('div', { class: 'stat', text: value, 'data-testid': id }),
        );
      fill(
        summary,
        stat('Distance', d.m ? `${fmt(d.m * 100, 1)} cm` : '–', 'tuning-distance'),
        stat('Distance from', d.source || '–', 'tuning-distance-source'),
        stat('Face found', pct(r.face), 'tuning-rate-face'),
        stat(
          'Iris fit L / R',
          `${pct(r.left_iris_fit)} / ${pct(r.right_iris_fit)}`,
          'tuning-rate-iris',
        ),
        stat(
          'Reflection L / R',
          `${pct(r.left_reflection)} / ${pct(r.right_reflection)}`,
          'tuning-rate-reflection',
        ),
        stat('Frozen', st.frozen ? 'yes' : 'no', 'tuning-frozen'),
      );
      const cues = d.cues
        ? Object.entries(d.cues)
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => `${k} ${fmt(v * 100, 1)} cm`)
            .join(', ')
        : '';
      const ha = st.head_angles_deg;
      const refl = st.reflection || {};
      const lc = st.lens_controls || {};
      const t = st.timings_ms || {};
      details.textContent = [
        st.camera
          ? `Camera ${st.camera.type} ${fmt(st.camera.zoom, 1)}x (${st.camera.mode}), frame ${st.seq}`
          : '',
        `Rates over the last ${r.frames || 0} frames.`,
        cues ? `Distance cues: ${cues}.` : '',
        ha
          ? `Head yaw ${fmt(ha.yaw, 1)}°, pitch ${fmt(ha.pitch, 1)}°, roll ${fmt(ha.roll, 1)}°.`
          : '',
        st.face_attempt ? `Face found by: ${st.face_attempt}.` : '',
        refl.latency_s !== null && refl.latency_s !== undefined
          ? `Coded flash: latency ${fmt(refl.latency_s * 1000, 0)} ms, prior learned for ${Object.keys(refl.priors || {}).join(' and ') || 'no eye'}.`
          : 'No coded flash decoded yet.',
        lc.error ? `Camera controls refused: ${lc.error}.` : '',
        lc.sent && Object.keys(lc.sent).length
          ? `Camera controls sent: ${JSON.stringify(lc.sent)}.`
          : '',
        st.fallback && st.fallback.mode !== 'off'
          ? `Fallback pointer: ${st.fallback.mode} (${st.fallback.source || 'no input yet'}).`
          : '',
        `Per frame: landmarks ${fmt(t.landmarks, 1)} ms, iris ${fmt(t.iris_edge, 1)} ms, reflection ${fmt(t.reflection, 1)} ms, total ${fmt(t.total, 0)} ms.`,
      ]
        .filter(Boolean)
        .join(' ');
    }

    async function tick(force = false) {
      if (!alive || (busy && !force)) return;
      busy = true;
      try {
        const st = await api.get('/api/tuning/stats');
        frozen = Boolean(st.frozen);
        freezeBtn.textContent = frozen ? 'Unfreeze' : 'Freeze frame';
        renderStats(st);
        refreshImages();
      } catch (err) {
        details.textContent = `No numbers yet: ${err.message}`;
      }
      busy = false;
    }

    function schedule() {
      const cfg = ctx.config && ctx.config.values && ctx.config.values.ui;
      const hz = (cfg && cfg.tuning_rate_hz) || 4;
      timer = window.setTimeout(async () => {
        if (!frozen) await tick();
        if (alive) schedule();
      }, 1000 / hz);
    }

    ctx
      .loadConfig(true)
      .then((cfg) => {
        const ui = cfg.values.ui || {};
        if (ui.glint_brightness_prompt) {
          prompt.hidden = false;
          prompt.textContent =
            'Tip: turn the Mac’s screen brightness all the way up while tuning the reflection (the browser cannot do it for you). A brighter screen makes a brighter, easier reflection; switch this reminder off with ui.glint_brightness_prompt.';
        }
        const byPath = new Map(cfg.settings.map((s) => [s.path, s]));
        const rows = QUICK.filter((p) => byPath.has(p)).map((p) =>
          settingRow(byPath.get(p), ctx, () => tick(true)),
        );
        fill(
          quick,
          rows.map((r) => r.row),
        );
      })
      .catch((err) => fill(quick, h('p', { class: 'bad', text: err.message })));
    tick(true);
    schedule();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  },
};
