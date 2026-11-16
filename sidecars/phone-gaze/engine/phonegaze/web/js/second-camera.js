/* global window, document */
// Second camera (experimental): the Mac's webcam as a position anchor for the phone. Shows the
// webcam with its detected face, where the solved phone pose puts the phone relative to the
// screen (with its uncertainty), how the two cameras' distances agree, the moved/re-anchoring
// state, and every second_camera.* switch (the same settings appear on the Experiments page).

import { h, fill, fmt } from './util.js';

const SVG = 'http://www.w3.org/2000/svg';

// Styles for this page only, kept here so the shared stylesheet is untouched.
const CSS = `
.sc-views { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.sc-views figure { margin: 0; flex: 1 1 200px; }
.sc-diagram { width: 100%; max-height: 260px; background: var(--code); border-radius: 8px; }
.sc-screen { fill: none; stroke: var(--text); stroke-width: 2; }
.sc-screen-edge { stroke: var(--text); stroke-width: 4; }
.sc-webcam { fill: var(--accent); }
.sc-phone { fill: var(--warn); }
.sc-unc { fill: var(--warn); fill-opacity: 0.18; stroke: var(--warn); stroke-dasharray: 4 3; }
.sc-axis { stroke: var(--warn); stroke-width: 2; }
.sc-label { fill: var(--muted); font-size: 12px; }
.sc-status { margin: 8px 0 14px; }
.sc-setting { display: grid; grid-template-columns: 11em auto auto 1fr; gap: 4px 10px; align-items: baseline; }
.sc-name { font-weight: 600; font-family: ui-monospace, monospace; font-size: 0.9rem; }
.sc-desc { grid-column: 1 / -1; margin: 0 0 6px; }
`;

if (!document.getElementById('sc-style')) {
  document.head.appendChild(h('style', { id: 'sc-style', text: CSS }));
}

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs))
    if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

const STATUS_TEXT = {
  waiting: ['Waiting for both cameras to see the face', 'muted'],
  anchoring: ['Anchoring: averaging paired frames', 'warn'],
  anchored: ['Anchored', 'good'],
  moving: ['Phone moving', 'warn'],
  're-anchoring': ['Phone moved, re-anchoring', 'warn'],
};

/** Front and side views of the screen with the webcam and the solved phone position. */
function poseDiagram(st) {
  const scr = st.screen_mm || [302, 196];
  const w = scr[0] || 302;
  const hgt = scr[1] || 196;
  const phone = st.phone;
  // Front view: x right, y down, millimetres from the screen's top-left corner.
  let minY = -40;
  let maxY = hgt + 90;
  let minX = -60;
  let maxX = w + 60;
  if (phone) {
    const [px, py] = phone.position_mm;
    minX = Math.min(minX, px - 40);
    maxX = Math.max(maxX, px + 40);
    minY = Math.min(minY, py - 40);
    maxY = Math.max(maxY, py + 40);
  }
  const front = s('svg', {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    class: 'sc-diagram',
    role: 'img',
    'aria-label': 'Front view: the screen, the webcam and the solved phone position',
  });
  front.append(
    s('rect', { x: 0, y: 0, width: w, height: hgt, class: 'sc-screen' }),
    s('circle', { cx: w / 2, cy: st.webcam_mm ? st.webcam_mm[1] : -8, r: 4, class: 'sc-webcam' }),
    s('text', { x: w / 2 + 8, y: -12, class: 'sc-label' }, document.createTextNode('webcam')),
  );
  // Side view: z (towards the user is negative) across, y down.
  let minZ = -120;
  let maxZ = 40;
  if (phone) {
    minZ = Math.min(minZ, phone.position_mm[2] - 60);
    maxZ = Math.max(maxZ, phone.position_mm[2] + 40);
  }
  const side = s('svg', {
    viewBox: `${minZ} ${minY} ${maxZ - minZ} ${maxY - minY}`,
    class: 'sc-diagram',
    role: 'img',
    'aria-label': 'Side view: the screen edge on and the phone in front of it',
  });
  side.append(
    s('line', { x1: 0, y1: 0, x2: 0, y2: hgt, class: 'sc-screen-edge' }),
    s('text', { x: 6, y: hgt - 6, class: 'sc-label' }, document.createTextNode('screen')),
    s('text', { x: minZ + 6, y: minY + 18, class: 'sc-label' }, document.createTextNode('user ←')),
  );
  if (phone) {
    const [px, py, pz] = phone.position_mm;
    const r = Math.max(3, 2 * (phone.se_mm || 0));
    front.append(
      s('circle', { cx: px, cy: py, r, class: 'sc-unc' }),
      s('rect', { x: px - 8, y: py - 4, width: 16, height: 8, rx: 2, class: 'sc-phone' }),
      s('text', { x: px + 12, y: py + 4, class: 'sc-label' }, document.createTextNode('phone')),
    );
    const ax = phone.axis;
    const len = 60;
    side.append(
      s('circle', { cx: pz, cy: py, r, class: 'sc-unc' }),
      s('rect', { x: pz - 4, y: py - 8, width: 8, height: 16, rx: 2, class: 'sc-phone' }),
      s('line', { x1: pz, y1: py, x2: pz + ax[2] * len, y2: py + ax[1] * len, class: 'sc-axis' }),
    );
  }
  return h(
    'div',
    { class: 'sc-views' },
    h('figure', {}, front, h('figcaption', { class: 'muted small', text: 'Front' })),
    h('figure', {}, side, h('figcaption', { class: 'muted small', text: 'Side' })),
  );
}

function settingControl(setting, value, ctx, onChanged) {
  const path = setting.path;
  const send = async (v) => {
    try {
      const res = await ctx.api.post('/api/config', { changes: { [path]: v } });
      if (res.errors && res.errors[path]) ctx.toast(res.errors[path], 'error');
      ctx.config = { ...ctx.config, values: res.values };
      onChanged();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };
  let control;
  if (setting.type === 'bool') {
    control = h('input', {
      type: 'checkbox',
      checked: Boolean(value),
      onchange: (e) => send(e.target.checked),
    });
  } else if (setting.choices) {
    control = h(
      'select',
      { onchange: (e) => send(e.target.value) },
      setting.choices.map((c) => h('option', { value: c, text: String(c), selected: c === value })),
    );
  } else {
    control = h('input', {
      type: setting.type === 'str' ? 'text' : 'number',
      value: value === undefined || value === null ? '' : String(value),
      step: setting.type === 'int' ? '1' : 'any',
      min: setting.min ?? undefined,
      max: setting.max ?? undefined,
      style: { width: setting.type === 'str' ? '16em' : '7em' },
      onchange: (e) =>
        send(setting.type === 'str' ? e.target.value : Number.parseFloat(e.target.value)),
    });
  }
  const name = path.split('.')[1];
  return h(
    'label',
    { class: 'sc-setting', 'data-path': path, title: setting.description },
    h('span', { class: 'sc-name', text: name }),
    control,
    setting.unit ? h('span', { class: 'muted small', text: setting.unit }) : null,
    h('span', { class: 'muted small sc-desc', text: setting.description }),
  );
}

export default {
  id: 'second-camera',
  title: 'Second camera',
  mount(root, ctx) {
    const { api } = ctx;
    const status = h('div', { class: 'sc-status', 'data-testid': 'sc-status' });
    const img = h('img', { alt: 'Webcam with the detected face', 'data-testid': 'sc-preview' });
    const noImg = h('div', { class: 'empty', text: 'No webcam frame yet.' });
    const preview = h('div', { class: 'preview' }, noImg);
    const facts = h('dl', { class: 'kv', 'data-testid': 'sc-facts' });
    const pose = h('div', { 'data-testid': 'sc-pose' });
    const check = h('dl', { class: 'kv', 'data-testid': 'sc-selfcheck' });
    const switches = h('div', { class: 'stack', 'data-testid': 'sc-switches' });
    let timer = 0;
    let imgTimer = 0;
    let alive = true;

    root.append(
      h('h1', { text: 'Second camera (experimental)' }),
      h('p', {
        class: 'muted',
        text:
          "The Mac's built-in camera is fixed to the screen, so where it is relative to the screen is known. " +
          'Seeing the same head with both cameras tells where the phone is. Everything here is off by default; ' +
          'compare each switch with Validate (the extra models, geometric_2cam and webcam, appear in its table).',
      }),
      status,
      h(
        'div',
        { class: 'grid' },
        h('section', { class: 'card' }, h('h2', { text: 'Webcam' }), preview, facts),
        h('section', { class: 'card' }, h('h2', { text: 'Where the phone is' }), pose),
        h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Do the cameras agree?' }),
          check,
          h('div', { class: 'row', style: { marginTop: '10px' } }, [
            h('button', {
              text: 'Re-anchor now',
              'data-testid': 'sc-reanchor',
              onclick: async () => {
                try {
                  await api.post('/api/second_camera/reanchor');
                  refresh();
                } catch (err) {
                  ctx.toast(err.message, 'error');
                }
              },
            }),
          ]),
        ),
        h('section', { class: 'card wide' }, h('h2', { text: 'Switches' }), switches),
      ),
    );

    function renderSwitches() {
      const cfg = ctx.config;
      if (!cfg) return;
      const list = cfg.settings.filter((x) => x.path.startsWith('second_camera.'));
      fill(
        switches,
        list.map((x) =>
          settingControl(x, cfg.values.second_camera[x.path.split('.')[1]], ctx, () => {
            renderSwitches();
            refresh();
          }),
        ),
      );
    }

    function render(st) {
      if (!st.enabled) {
        fill(
          status,
          h('p', {
            class: 'muted',
            text: 'Off. Turn on "enabled" below (the simulator serves its own second camera; on a Mac the built-in camera is used).',
          }),
        );
        fill(facts);
        fill(pose, h('div', { class: 'empty', text: 'Not running.' }));
        fill(check);
        return;
      }
      const sv = st.solver || {};
      const [text, cls] = STATUS_TEXT[sv.status] || [sv.status || '?', 'muted'];
      fill(
        status,
        h(
          'div',
          { class: 'row' },
          h('span', { class: `pill ${cls}`, 'data-testid': 'sc-state', text }),
          st.error ? h('span', { class: 'bad', 'data-testid': 'sc-error', text: st.error }) : null,
          sv.last_move
            ? h('span', {
                class: 'muted small',
                text: `Moves detected: ${sv.moves} (last: ${sv.last_move.reason})`,
              })
            : null,
          st.transform
            ? h('span', {
                class: 'small',
                text: `track_phone applying ${fmt(st.transform.shift_m * 100, 1)} cm, ${fmt(st.transform.angle_deg, 1)}°`,
              })
            : null,
        ),
      );
      const face = st.face || {};
      fill(
        facts,
        h('dt', { text: 'Source' }),
        h('dd', { text: `${st.source || '–'}${st.running ? '' : ' (stopped)'}` }),
        h('dt', { text: 'Frames / faces' }),
        h('dd', { text: `${st.frames} / ${st.faces}` }),
        h('dt', { text: 'Face' }),
        h('dd', {
          class: face.ok ? 'good' : 'warn',
          text: face.ok ? `ok, ${fmt((face.distance_m || 0) * 100, 0)} cm` : face.why || '–',
        }),
        h('dt', { text: 'Paired frames' }),
        h('dd', {
          text: `${st.paired}${st.why_not_paired ? ` (now: ${st.why_not_paired})` : ''}`,
        }),
      );
      const e = sv.estimate;
      fill(
        pose,
        poseDiagram(st),
        h(
          'dl',
          { class: 'kv' },
          h('dt', { text: 'Position' }),
          h('dd', {
            'data-testid': 'sc-phone-pos',
            text: st.phone
              ? st.phone.position_mm.map((v) => fmt(v / 10, 1)).join(', ') +
                ' cm from the top-left corner (x right, y down, z into the screen)'
              : '–',
          }),
          h('dt', { text: 'Uncertainty' }),
          h('dd', {
            text: e
              ? `±${fmt(e.se_t_m * 100, 1)} cm, ±${fmt(e.se_rot_deg, 1)}° (frame-to-frame spread ${fmt(e.sd_t_m * 100, 1)} cm, ${fmt(e.sd_rot_deg, 1)}°; biases not included)`
              : '–',
          }),
          h('dt', { text: 'Frames averaged' }),
          h('dd', {
            text: e
              ? `${e.n} over ${fmt(e.duration_s, 1)} s (${e.method})${sv.time_to_anchor_s ? `, anchored after ${fmt(sv.time_to_anchor_s, 1)} s` : ''}`
              : '–',
          }),
        ),
      );
      const sc = st.self_check || {};
      fill(
        check,
        h('dt', { text: 'Eyes from the phone' }),
        h('dd', { text: sc.phone_m ? `${fmt(sc.phone_m * 100, 1)} cm` : '–' }),
        h('dt', { text: 'Eyes from the webcam' }),
        h('dd', { text: sc.webcam_m ? `${fmt(sc.webcam_m * 100, 1)} cm` : '–' }),
        h('dt', { text: 'Webcam distance expected' }),
        h('dd', {
          text: sc.expected_webcam_m
            ? `${fmt(sc.expected_webcam_m * 100, 1)} cm (from the phone and its calibration)`
            : 'after a calibration',
        }),
        h('dt', { text: 'Ratio' }),
        h('dd', {
          'data-testid': 'sc-ratio',
          class: sc.ratio && Math.abs(sc.ratio - 1) > 0.05 ? 'warn' : '',
          text: sc.ratio ? `${fmt(sc.ratio, 3)} (${sc.basis})` : '–',
        }),
        h('dt', { text: 'Suggested field of view' }),
        h('dd', {
          text: sc.suggested_hfov_deg ? `${fmt(sc.suggested_hfov_deg, 1)}° (hfov_deg)` : '–',
        }),
      );
    }

    async function refresh() {
      try {
        const st = await api.get('/api/second_camera');
        if (alive) render(st);
      } catch (err) {
        fill(
          status,
          h('p', { class: 'bad', text: `Could not read the second camera: ${err.message}` }),
        );
      }
    }

    function refreshImage() {
      const probe = new window.Image();
      probe.onload = () => {
        if (!alive) return;
        img.src = probe.src;
        if (!img.isConnected) fill(preview, img);
      };
      probe.src = `/api/second_camera/preview.jpg?t=${Date.now()}`;
    }

    ctx
      .loadConfig()
      .then(renderSwitches)
      .catch((err) => ctx.toast(err.message, 'error'));
    refresh();
    refreshImage();
    timer = window.setInterval(refresh, 700);
    imgTimer = window.setInterval(refreshImage, 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.clearInterval(imgTimer);
    };
  },
};
