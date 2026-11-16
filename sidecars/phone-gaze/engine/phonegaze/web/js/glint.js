/* global window, document, performance */
// Glint assist (ui.glint_*): bright markers drawn over every engine page, calibration included,
// so the screen's reflection on the cornea is bigger and easier to find; optionally blinked in
// short bursts with a code the engine knows (ui.pattern), so the reflection estimator re-learns
// where the reflection sits (estimators.reflection_coded_flash).

const STEP_DEFAULT_MS = 125;

function parsePattern(text) {
  const [bitsText, stepText] = String(text || '').split('@');
  const bits = [...(bitsText || '')].filter((c) => c === '0' || c === '1').map(Number);
  const step = Number.parseFloat(stepText);
  return {
    bits: bits.length && new Set(bits).size === 2 ? bits : [1, 0, 1, 1, 0, 0, 1, 0],
    stepMs: Number.isFinite(step) && step >= 10 ? step : STEP_DEFAULT_MS,
  };
}

export function installGlint(ctx) {
  const layer = document.createElement('div');
  layer.className = 'glint-layer';
  layer.dataset.testid = 'glint-layer';
  layer.setAttribute('aria-hidden', 'true');
  const corners = ['tl', 'tr', 'bl', 'br'].map((pos) => {
    const el = document.createElement('div');
    el.className = `glint-corner ${pos}`;
    layer.appendChild(el);
    return el;
  });
  document.body.appendChild(layer);

  let lastKey = '';
  let burst = null; // { t0, until, bits, stepMs, pattern }
  let nextBurstAt = performance.now() + 5000;

  function settings() {
    const ui = (ctx.config && ctx.config.values && ctx.config.values.ui) || {};
    return {
      marker: ui.glint_marker || 'off',
      px: ui.glint_marker_px || 24,
      blink: Boolean(ui.glint_blink),
      everyS: ui.glint_blink_every_s || 30,
      pattern: ui.glint_pattern || '10110010@125',
    };
  }

  function calibrationFlashing() {
    return Boolean(document.querySelector('.calib .flashframe:not([hidden])'));
  }

  function layout(s) {
    const key = `${s.marker}|${s.px}|${s.blink}`;
    if (key === lastKey) return;
    lastKey = key;
    layer.dataset.mode = s.marker;
    layer.hidden = s.marker === 'off' && !s.blink;
    layer.style.borderWidth = s.marker === 'border' ? `${s.px}px` : '0';
    for (const c of corners) {
      c.hidden = s.marker !== 'corners';
      c.style.width = `${s.px * 2}px`;
      c.style.height = `${s.px * 2}px`;
    }
  }

  function endBurst() {
    if (!burst) return;
    ctx.api.send({ type: 'ui.pattern', pattern: burst.pattern, on: false });
    burst = null;
    layer.classList.remove('glint-off', 'glint-whole');
  }

  function frame() {
    const s = settings();
    layout(s);
    const now = performance.now();
    if (burst) {
      if (now >= burst.until || !s.blink || calibrationFlashing()) {
        endBurst();
        nextBurstAt = now + s.everyS * 1000;
      } else {
        const i = Math.floor((now - burst.t0) / burst.stepMs) % burst.bits.length;
        layer.classList.toggle('glint-off', burst.bits[i] === 0);
      }
    } else if (s.blink && now >= nextBurstAt && !calibrationFlashing() && ctx.api.wsOpen) {
      const { bits, stepMs } = parsePattern(s.pattern);
      const cycles = Math.max(2, Math.ceil(2000 / (bits.length * stepMs)));
      burst = {
        t0: now,
        until: now + cycles * bits.length * stepMs,
        bits,
        stepMs,
        pattern: s.pattern,
      };
      layer.classList.toggle('glint-whole', s.marker === 'off');
      ctx.api.send({ type: 'ui.pattern', pattern: s.pattern, on: true });
    } else if (!s.blink) {
      nextBurstAt = now + 2000;
    }
    window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
  window.addEventListener('beforeunload', endBurst);
  return { layer };
}
