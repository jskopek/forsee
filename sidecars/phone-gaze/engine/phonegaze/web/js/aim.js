/* global Image, document */
// Aiming view: live whole-frame preview with overlays, native-resolution eye crops, iris size,
// sharpness, focus, distance, the engine's aiming hints, and the "find the best lens" search.

import { h, fill, fmt } from './util.js';
import { focusText } from './dashboard.js';

/** An <img> that reloads from /api/preview.jpg, one request in flight at a time. */
function livePreview(name, opts = {}) {
  const img = new Image();
  img.alt = name;
  img.dataset.testid = `preview-${name}`;
  let busy = false;
  let wanted = false;
  img.addEventListener('load', () => {
    busy = false;
    img.dataset.loaded = '1';
    if (wanted) refresh();
  });
  img.addEventListener('error', () => {
    busy = false;
  });
  function refresh() {
    if (busy) {
      wanted = true;
      return;
    }
    wanted = false;
    busy = true;
    const overlay = opts.overlay && opts.overlay() ? 1 : 0;
    img.src = `/api/preview.jpg?image=${encodeURIComponent(name)}&overlay=${overlay}&t=${Date.now()}`;
  }
  return { img, refresh };
}

export default {
  id: 'aim',
  title: 'Aim',
  mount(root, ctx) {
    const { api } = ctx;
    let overlayOn = true;
    const wide = livePreview('wide', { overlay: () => overlayOn });
    const crops = new Map();
    const cropBox = h('div', { class: 'crops', 'data-testid': 'crops' });
    const hints = h('ul', { class: 'hints', 'data-testid': 'hints' });
    const numbers = h('dl', { class: 'kv', 'data-testid': 'aim-numbers' });
    const aimBox = h('div', { 'data-testid': 'aim-results' });
    const zoomRow = h('div', { class: 'row' });
    const camSelect = h('select', { 'data-testid': 'camera-select' });
    let lastObs = null;
    let haveFrame = false;
    const previewWrap = h(
      'div',
      {
        class: 'preview',
        title: 'Click to focus there',
        onclick: async (e) => {
          const r = wide.img.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          const y = (e.clientY - r.top) / r.height;
          try {
            await api.post('/api/focus', { x, y });
            ctx.toast('Focusing there.');
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        },
      },
      wide.img,
    );
    const emptyMsg = h('div', {
      class: 'empty',
      text: 'No picture yet. Connect a phone on the Dashboard.',
    });

    async function post(path, body, okText) {
      try {
        await api.post(path, body);
        if (okText) ctx.toast(okText);
        await api.refreshState();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    }

    root.appendChild(
      h(
        'div',
        { class: 'grid' },
        h('section', { class: 'card wide' }, h('h2', { text: 'What to change' }), hints),
        h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'row', style: { marginBottom: '8px' } },
            h('h2', { text: 'Whole picture', style: { margin: 0 } }),
            h(
              'label',
              { class: 'row', style: { marginLeft: 'auto' } },
              h('input', {
                type: 'checkbox',
                checked: true,
                onchange: (e) => {
                  overlayOn = e.target.checked;
                  wide.refresh();
                },
              }),
              'Show eye rectangles and fits',
            ),
          ),
          emptyMsg,
          previewWrap,
          h('p', { class: 'muted small', text: 'Click the picture to focus at that point.' }),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Eyes at full resolution' }),
          cropBox,
          h('h3', { text: 'Measurements' }),
          numbers,
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Camera and focus' }),
          h(
            'div',
            { class: 'row' },
            'Camera: ',
            camSelect,
            h('button', {
              text: 'Use',
              onclick: () =>
                post('/api/camera', { camera_id: camSelect.value }, 'Switching camera.'),
            }),
          ),
          h('div', { style: { marginTop: '8px' } }, zoomRow),
          h(
            'div',
            { class: 'row', style: { marginTop: '8px' } },
            h('button', {
              text: 'Lock focus',
              onclick: () => post('/api/focus', { locked: true }, 'Focus locked.'),
            }),
            h('button', {
              text: 'Auto focus',
              onclick: () => post('/api/focus', { locked: false }, 'Focus unlocked.'),
            }),
          ),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', { text: 'Find the best lens' }),
          h('p', {
            class: 'muted',
            text: 'Tries each camera and zoom for a few seconds, measures how big and sharp your irises are, and keeps the best.',
          }),
          h('button', {
            class: 'primary big',
            text: 'Find the best lens',
            'data-testid': 'find-lens',
            onclick: () => post('/api/aim', {}, 'Trying each camera; keep looking at the screen.'),
          }),
          aimBox,
        ),
      ),
    );
    previewWrap.hidden = true;

    function ensureCrop(name) {
      if (crops.has(name)) return;
      const p = livePreview(name, { overlay: () => overlayOn });
      const label =
        name === 'left_eye' ? 'Your left eye' : name === 'right_eye' ? 'Your right eye' : name;
      crops.set(name, p);
      cropBox.appendChild(
        h(
          'figure',
          { class: 'crop', style: { margin: 0 } },
          p.img,
          h('figcaption', { class: 'muted small', text: label }),
        ),
      );
    }

    function onFrame(m) {
      haveFrame = true;
      emptyMsg.hidden = true;
      previewWrap.hidden = false;
      wide.refresh();
      for (const name of m.images || []) {
        if (name === 'wide') continue;
        ensureCrop(name);
        crops.get(name).refresh();
      }
    }

    function eyeNum(side, key) {
      const e = lastObs && lastObs[side];
      return e ? e[key] : null;
    }

    function update() {
      const st = api.state;
      if (!st) return;
      const q = st.quality || {};
      const s = (st.phone && st.phone.status) || {};
      const c = st.camera || {};
      const dist = lastObs && lastObs.distance;
      const hintList = st.hints || [];
      fill(
        hints,
        hintList.length
          ? hintList.map((t) => h('li', { text: t }))
          : h('li', {
              class: haveFrame ? 'good' : 'muted',
              text: haveFrame ? 'Looks good.' : 'Waiting for pictures from the phone.',
            }),
      );
      const irisL = eyeNum('left', 'iris_radius');
      const irisR = eyeNum('right', 'iris_radius');
      fill(
        numbers,
        h('dt', { text: 'Iris diameter' }),
        h(
          'dd',
          { 'data-testid': 'iris-px' },
          fmt(q.iris_px, 0, ' px'),
          irisL || irisR
            ? ` (left ${fmt(irisL && irisL * 2, 0)}, right ${fmt(irisR && irisR * 2, 0)})`
            : '',
        ),
        h('dt', { text: 'Sharpness' }),
        h('dd', { text: fmt(q.sharpness, 2) }),
        h('dt', { text: 'Brightness' }),
        h('dd', { text: fmt(q.brightness, 0) }),
        h('dt', { text: 'Eyes found' }),
        h('dd', { text: fmt(q.eyes_in_frame, 0) }),
        h('dt', { text: 'Edge margin' }),
        h('dd', {
          text:
            q.edge_margin === null || q.edge_margin === undefined
              ? '–'
              : `${Math.round(100 * q.edge_margin)}%`,
        }),
        h('dt', { text: 'Motion blur' }),
        h('dd', { text: fmt(q.motion_blur_px, 1, ' px') }),
        h('dt', { text: 'Distance' }),
        h('dd', {
          'data-testid': 'distance',
          text: typeof dist === 'number' ? `${Math.round(dist * 100)} cm` : '–',
        }),
        h('dt', { text: 'Focus' }),
        h('dd', { text: focusText(s) }),
        h('dt', { text: 'Camera' }),
        h('dd', {
          text: `${[c.position, c.type].filter(Boolean).join(' ') || '–'}${c.zoom ? ` at ${fmt(c.zoom, 2)}×` : ''}`,
        }),
      );
      // Camera list and zoom presets from the phone's hello.
      const cams = (st.phone && st.phone.hello && st.phone.hello.cameras) || [];
      if (camSelect.options.length !== cams.length) {
        fill(
          camSelect,
          cams.map((cam) => h('option', { value: cam.id, text: cam.name || cam.id })),
        );
      }
      if (c.id && document.activeElement !== camSelect) camSelect.value = c.id;
      const cur = cams.find((cam) => cam.id === c.id);
      const zooms = [1, ...((cur && cur.zoomPresets) || [])].filter(
        (z, i, a) => a.indexOf(z) === i,
      );
      if (zoomRow.dataset.key !== zooms.join(',')) {
        zoomRow.dataset.key = zooms.join(',');
        fill(
          zoomRow,
          'Zoom: ',
          zooms.map((z) =>
            h('button', {
              text: `${fmt(z, z % 1 ? 2 : 0)}×`,
              onclick: () => post('/api/zoom', { zoom: z }, `Zoom ${z}×.`),
            }),
          ),
        );
      }
      renderAim(st.aim);
    }

    function renderAim(aim) {
      if (!aim || !aim.results || !['trying', 'done', 'failed'].includes(aim.phase)) return;
      const best = aim.best;
      fill(
        aimBox,
        h('p', {
          class: aim.phase === 'failed' ? 'bad' : aim.phase === 'done' ? 'good' : 'warn',
          'data-testid': 'aim-phase',
          text:
            aim.phase === 'trying'
              ? 'Trying…'
              : aim.phase === 'done' && best
                ? `Best: ${best.camera_name || best.camera_id} at ${fmt(best.zoom, 2)}× (now in use).`
                : `No camera found your eyes${aim.error ? `: ${aim.error}` : '.'}`,
        }),
        h(
          'table',
          {},
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ['Camera', 'Zoom', 'Iris', 'Sharpness', 'Eyes', 'Frames', 'Score'].map((t, i) =>
                h('th', { class: i > 1 ? 'num' : '', text: t }),
              ),
            ),
          ),
          h(
            'tbody',
            {},
            aim.results.map((r) => {
              const q = r.quality || {};
              const isBest = best && best.camera_id === r.camera_id && best.zoom === r.zoom;
              return h(
                'tr',
                { class: isBest ? 'chosen' : '' },
                h('td', { text: `${r.camera_name || r.type || r.camera_id}${isBest ? ' ●' : ''}` }),
                h('td', { text: `${fmt(r.zoom, 2)}×` }),
                r.error
                  ? h('td', { colspan: 5, class: 'bad', text: r.error })
                  : [
                      h('td', { class: 'num', text: fmt(q.iris_px, 0, ' px') }),
                      h('td', { class: 'num', text: fmt(q.sharpness, 2) }),
                      h('td', { class: 'num', text: fmt(q.eyes_in_frame, 0) }),
                      h('td', { class: 'num', text: fmt(r.frames, 0) }),
                      h('td', { class: 'num', text: fmt(r.score, 2) }),
                    ],
              );
            }),
          ),
        ),
      );
    }

    const offs = [
      api.on('frame', onFrame),
      api.on('state', update),
      api.on('obs', (m) => {
        lastObs = m;
        update();
      }),
      api.on('aim', (m) => {
        renderAim({
          phase: m.phase,
          results: m.results,
          best: m.phase === 'done' ? { camera_id: m.camera_id, zoom: m.zoom } : null,
        });
      }),
    ];
    update();
    return () => offs.forEach((f) => f());
  },
};
