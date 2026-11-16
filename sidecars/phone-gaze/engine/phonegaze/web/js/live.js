/* global window, document, performance, requestAnimationFrame, cancelAnimationFrame */
// Live view: gaze marker and trail over targets of several sizes, plus a dwell-click demo.

import { h, fill, fmt, store, save, screenMapper } from './util.js';

const SIZES = [160, 96, 56, 32, 16];
const TRAIL_MS = 800;

export default {
  id: 'live',
  title: 'Live',
  mount(root, ctx) {
    const { api } = ctx;
    const opts = {
      fit: store('live.fit', null),
      raw: store('live.raw', false),
      models: store('live.models', false),
      dwellMs: store('live.dwellMs', 900),
      lookpoints: store('live.lookpoints', false),
    };
    const area = h('div', { class: 'live', 'data-testid': 'live-area' });
    const canvas = h('canvas');
    area.appendChild(canvas);
    const info = h('div', { class: 'row muted', 'data-testid': 'live-info' });
    const hitsEl = h('span', { class: 'stat', text: '0' });
    let hits = 0;
    let targets = [];
    let trail = [];
    let last = null;
    let lastRaw = null;
    let preds = {};
    let dwell = { target: null, since: 0, cooldownUntil: 0 };
    let samples = 0;
    let rateT0 = performance.now();
    let rate = 0;
    let raf = 0;

    const check = (key, label) =>
      h(
        'label',
        { class: 'row' },
        h('input', {
          type: 'checkbox',
          checked:
            key === 'fit' && opts.fit === null
              ? Boolean(api.state && api.state.screen && api.state.screen.source === 'sim')
              : Boolean(opts[key]),
          onchange: (e) => {
            opts[key] = e.target.checked;
            save(`live.${key}`, opts[key]);
            if (key === 'fit') layout();
          },
        }),
        label,
      );

    root.append(
      h(
        'div',
        { class: 'row', style: { marginBottom: '10px' } },
        h('h1', { text: 'Live gaze', style: { margin: 0 } }),
        h('span', { class: 'muted', text: 'Dwell clicks:' }),
        hitsEl,
        h('button', {
          text: 'Full screen',
          onclick: () => {
            area.classList.add('full');
            if (document.documentElement.requestFullscreen)
              document.documentElement.requestFullscreen().catch(() => {});
            window.setTimeout(layout, 300);
          },
        }),
        h('span', { class: 'muted small', text: 'Esc leaves full screen.' }),
      ),
      h(
        'div',
        { class: 'row', style: { marginBottom: '10px', gap: '18px' } },
        check('fit', 'Fit the whole screen into this box'),
        check('raw', 'Show unfiltered point'),
        check('models', 'Show every model'),
        check('lookpoints', 'Use dwell clicks for drift correction'),
        h(
          'label',
          { class: 'row' },
          'Dwell ',
          h('input', {
            type: 'number',
            min: 200,
            max: 5000,
            step: 50,
            value: opts.dwellMs,
            style: { width: '90px' },
            onchange: (e) => {
              opts.dwellMs = Math.max(200, Number(e.target.value) || 900);
              save('live.dwellMs', opts.dwellMs);
            },
          }),
          ' ms',
        ),
      ),
      area,
      info,
    );

    function mapper() {
      const st = api.state || {};
      const screen = st.screen && st.screen.width ? st.screen : null;
      const r = area.getBoundingClientRect();
      const fit = opts.fit === null ? Boolean(screen && screen.source === 'sim') : opts.fit;
      if (fit && screen) {
        const k = Math.min(r.width / screen.width, r.height / screen.height);
        const ox = (r.width - screen.width * k) / 2;
        const oy = (r.height - screen.height * k) / 2;
        return {
          toArea: (x, y) => [ox + x * k, oy + y * k],
          toScreen: (ax, ay) => [(ax - ox) / k, (ay - oy) / k],
          fit: true,
        };
      }
      const m = screenMapper(screen, []);
      return {
        toArea: (x, y) => {
          const [cx, cy] = m.toCss(x, y);
          return [cx - r.left, cy - r.top];
        },
        toScreen: (ax, ay) => m.toScreen(ax + r.left, ay + r.top),
        fit: false,
      };
    }

    function layout() {
      for (const t of targets) t.el.remove();
      targets = [];
      const r = area.getBoundingClientRect();
      const cols = 5;
      const rows = 3;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const size = SIZES[(col + row * 2) % SIZES.length];
          const x = ((col + 0.5) / cols) * r.width;
          const y = ((row + 0.5) / rows) * r.height;
          const el = h('div', {
            class: 'target',
            style: { left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px` },
            text: size >= 56 ? `${size}px` : '',
            title: `${size} px target`,
          });
          area.appendChild(el);
          targets.push({ el, x, y, r: size / 2 });
        }
      }
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * ratio);
      canvas.height = Math.round(r.height * ratio);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    }

    function onGaze(m) {
      samples += 1;
      const now = performance.now();
      if (now - rateT0 > 1000) {
        rate = (samples * 1000) / (now - rateT0);
        samples = 0;
        rateT0 = now;
      }
      last = m;
      lastRaw = m.raw || null;
      if (m.valid) {
        const [ax, ay] = mapper().toArea(m.x, m.y);
        trail.push({ x: ax, y: ay, t: now });
        dwellStep(ax, ay, now);
      } else {
        dwell.target = null;
      }
    }

    function dwellStep(ax, ay, now) {
      let hit = null;
      for (const t of targets) {
        t.el.classList.remove('gazed');
        if (Math.hypot(ax - t.x, ay - t.y) <= Math.max(t.r, 12)) hit = t;
      }
      if (hit) hit.el.classList.add('gazed');
      if (now < dwell.cooldownUntil) return;
      if (hit !== dwell.target) {
        dwell = { target: hit, since: now, cooldownUntil: dwell.cooldownUntil };
        return;
      }
      if (hit && now - dwell.since >= opts.dwellMs) {
        hits += 1;
        hitsEl.textContent = String(hits);
        hit.el.classList.add('hit');
        window.setTimeout(() => hit.el.classList.remove('hit'), 400);
        dwell = { target: null, since: now, cooldownUntil: now + 700 };
        if (opts.lookpoints) {
          const [sx, sy] = mapper().toScreen(hit.x, hit.y);
          api
            .post('/api/lookpoint', { x: sx, y: sy })
            .catch((err) => ctx.toast(err.message, 'error'));
        }
      }
    }

    function draw() {
      raf = requestAnimationFrame(draw);
      const ratio = window.devicePixelRatio || 1;
      const g = canvas.getContext('2d');
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const now = performance.now();
      trail = trail.filter((p) => now - p.t < TRAIL_MS);
      const style = window.getComputedStyle(document.body);
      const accent = style.getPropertyValue('--accent').trim() || '#1f5fd6';
      const muted = style.getPropertyValue('--muted').trim() || '#888';
      if (trail.length > 1) {
        g.strokeStyle = accent;
        g.lineWidth = 2;
        for (let i = 1; i < trail.length; i++) {
          g.globalAlpha = 1 - (now - trail[i].t) / TRAIL_MS;
          g.beginPath();
          g.moveTo(trail[i - 1].x, trail[i - 1].y);
          g.lineTo(trail[i].x, trail[i].y);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
      const map = mapper();
      if (opts.models) {
        g.font = '11px system-ui, sans-serif';
        for (const [name, p] of Object.entries(preds)) {
          if (!p || !p.valid) continue;
          const [x, y] = map.toArea(p.x, p.y);
          g.fillStyle = muted;
          g.beginPath();
          g.arc(x, y, 4, 0, Math.PI * 2);
          g.fill();
          g.fillText(name, x + 6, y - 6);
        }
      }
      if (opts.raw && lastRaw && lastRaw.valid !== false) {
        const [x, y] = map.toArea(lastRaw.x, lastRaw.y);
        g.strokeStyle = muted;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, 6, 0, Math.PI * 2);
        g.stroke();
      }
      if (dwell.target && now >= dwell.cooldownUntil) {
        const f = Math.min(1, (now - dwell.since) / opts.dwellMs);
        const t = dwell.target;
        g.strokeStyle = accent;
        g.lineWidth = 5;
        g.beginPath();
        g.arc(t.x, t.y, Math.max(t.r, 12) + 8, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
        g.stroke();
      }
      if (last) {
        const [x, y] = map.toArea(last.x, last.y);
        g.globalAlpha = last.valid ? 0.85 : 0.25;
        g.fillStyle = last.valid ? accent : muted;
        g.beginPath();
        g.arc(x, y, 11, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        g.stroke();
      }
    }

    function updateInfo() {
      const st = api.state || {};
      const cal = st.calibration || {};
      const parts = [
        `Model: ${(last && last.model) || cal.active || cal.chosen || 'none (calibrate first)'}`,
        `Rate: ${fmt(rate, 0)} Hz`,
        `Confidence: ${last ? fmt(last.confidence, 2) : '–'}`,
        last && !last.valid ? 'Not tracking' : '',
        mapper().fit ? 'Screen fitted into the box' : 'Drawn at true screen position',
      ].filter(Boolean);
      fill(info, parts.join(' · '));
    }

    const onResize = () => layout();
    const onFs = () => {
      if (!document.fullscreenElement) {
        area.classList.remove('full');
        window.setTimeout(layout, 100);
      }
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    const timer = window.setInterval(updateInfo, 500);
    const offs = [
      api.on('gaze', onGaze),
      api.on('predictions', (m) => {
        preds = m.predictions || {};
      }),
    ];
    layout();
    draw();
    updateInfo();
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      offs.forEach((f) => f());
    };
  },
};
