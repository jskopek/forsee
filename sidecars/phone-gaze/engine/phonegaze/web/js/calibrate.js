/* global window, document, performance, requestAnimationFrame */
// Full-screen calibration, quick refine and validation (docs/INTERFACES.md: /api/calibration/*,
// calib.dot, ui.pattern, ui.screen). The engine's targets are screen points and stay the source
// of truth: every calib.dot message carries the engine's own x, y for the dot.

import { h, fill, fmt, deg, store, save, screenMapper, errorColour } from './util.js';

const POSE_PROMPTS = [
  'Sit as you normally do and keep your head still.',
  'Now lean a little to the left, then keep still.',
  'Now lean a little to the right, then keep still.',
  'Now sit back a little further from the screen.',
  'Now lean in a little closer to the screen.',
];

// Pattern string format is decided by the reflection estimator (vision/reflection.py):
// "0"/"1" per step, repeating from the moment `on` is sent, then "@<step ms>".
const DEFAULT_FLASH = '10110010@125';
const FLASH_REPEATS = 3;
const PURSUIT_STEP_MS = 250;

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

let running = false;
// Targets for the next touch-up flow: the worst validation dots (set by the report button).
let touchupTargets = [];

export function flowRunning() {
  return running;
}

/**
 * kind: "full" (grid, optional moving dot, pose rounds, quality gate and head sweep), "pursuit",
 * "refine", "validate", "touchup" (validation dots again at the worst places of the last
 * validation, which also feed the error map).
 */
export async function startFlow(kind, ctx) {
  if (running) return null;
  running = true;
  const flow = new Flow(kind, ctx);
  try {
    return await flow.run();
  } finally {
    flow.close();
    running = false;
  }
}

class Flow {
  constructor(kind, ctx) {
    this.kind = kind;
    this.ctx = ctx;
    this.api = ctx.api;
    this.abort = new window.AbortController();
    this.goResolve = null;
    this.runId = null;
    this.closed = false;
    this.timings = [];
    this.root = h('div', { class: 'calib', 'data-testid': 'calib' });
    this.stage = h('div');
    this.dot = h(
      'div',
      { class: 'dot', hidden: true },
      h('div', { class: 'ring' }),
      h('div', { class: 'core' }),
      h('div', { class: 'pin' }),
    );
    this.flashFrame = h('div', { class: 'flashframe', hidden: true });
    this.progress = h('div', { class: 'progress', style: { width: '0%' } });
    this.counter = h('div', { class: 'counter' });
    this.notice = h('div', { class: 'notice' });
    this.root.append(
      this.flashFrame,
      this.stage,
      this.dot,
      this.progress,
      this.counter,
      this.notice,
    );
    this.onKey = (ev) => this.key(ev);
    window.addEventListener('keydown', this.onKey, true);
    document.body.appendChild(this.root);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ------------------------------------------------------------------ plumbing

  key(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.cancel();
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      const inOverlayButton =
        ev.target && ev.target.tagName === 'BUTTON' && this.root.contains(ev.target);
      if (inOverlayButton) return;
      // Never let Space reach a button on the page underneath (Pause, for instance).
      ev.preventDefault();
      ev.stopPropagation();
      if (this.goResolve) {
        const go = this.goResolve;
        this.goResolve = null;
        go();
      }
    }
  }

  cancel() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    if (this.goResolve) this.goResolve();
    if (this.runId) {
      this.api.post('/api/calibration/cancel', { run_id: this.runId }).catch(() => {});
      this.ctx.toast('Calibration cancelled.');
    }
  }

  check() {
    if (this.abort.signal.aborted) throw new Cancelled();
  }

  wait(ms) {
    this.check();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(new Cancelled());
        },
        { once: true },
      );
    });
  }

  frame() {
    this.check();
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  /** Wait for Space/Enter or a click on a button made by `panel`. */
  waitGo() {
    this.check();
    return new Promise((resolve) => {
      this.goResolve = resolve;
    }).then(() => this.check());
  }

  panel(...children) {
    this.root.classList.add('show-cursor');
    this.dot.hidden = true;
    fill(this.stage, h('div', { class: 'panel' }, ...children));
  }

  clearPanel() {
    this.root.classList.remove('show-cursor');
    fill(this.stage);
  }

  goButton(label) {
    return h('button', {
      class: 'primary big',
      text: label,
      'data-testid': 'calib-go',
      onclick: () => {
        if (this.goResolve) {
          const go = this.goResolve;
          this.goResolve = null;
          go();
        }
      },
    });
  }

  async fullscreen() {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
        await this.wait(400);
      } catch {
        // Not allowed (no user gesture, or headless). Calibrating in the window still works;
        // the dot positions are checked against the window below.
      }
    }
    this.api.sendScreen();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    this.api.refreshState().catch(() => {});
  }

  send(plan, target, state, poseGroup = 0) {
    this.api.send({
      type: 'calib.dot',
      run_id: plan.run_id,
      dot_id: target.dot_id,
      x: target.x,
      y: target.y,
      state,
      pose_group: poseGroup,
    });
  }

  /**
   * On a slow computer few frames are processed while a dot is collected, and a dot with fewer
   * than calibration.min_samples usable samples is thrown away (at 5 fps every dot was). Keep
   * the dot up, by at most twice the collect time, until the engine has enough. Engines without
   * the endpoint, or a dot it does not know yet, just end the wait.
   */
  async extendForSamples(plan, target, collect) {
    const until = performance.now() + 2 * collect;
    while (!this.closed && performance.now() < until) {
      let p;
      try {
        p = await this.api.get(`/api/calibration/dot?run_id=${encodeURIComponent(plan.run_id)}`);
      } catch {
        return;
      }
      if (!p || !p.active || p.dot_id === null) return;
      if (p.dot_id !== target.dot_id || p.collected >= p.needed + 2) return;
      await this.wait(150);
    }
  }

  setProgress(done, total, label) {
    this.progress.style.width = `${total ? (100 * done) / total : 0}%`;
    this.counter.textContent = label || `${done} / ${total}`;
  }

  /**
   * On a Mac the engine measures the main display. A calibration shown anywhere else (another
   * display, a window that is not full screen) would map gaze on one display to points on
   * another and still report plausible numbers, so refuse it. Waits up to 2 s for a full-screen
   * transition to finish first.
   */
  async ensureExact(plan) {
    if (!plan.screen || plan.screen.source !== 'macos') return;
    const t0 = performance.now();
    while (!screenMapper(plan.screen, plan.targets).exact) {
      if (performance.now() - t0 > 2000) {
        throw new Error(
          'This window does not cover the main display, which is the screen Phone Gaze uses. ' +
            'Move this window to the main display (System Settings > Displays sets which one ' +
            'that is), make it full screen, and start again.',
        );
      }
      await this.wait(100);
    }
  }

  placeDot(screen, x, y, points) {
    const map = screenMapper(screen, points);
    const [cx, cy] = map.toCss(x, y);
    this.dot.style.left = `${cx}px`;
    this.dot.style.top = `${cy}px`;
    this.dot.hidden = false;
    this.notice.textContent = map.exact
      ? ''
      : 'This window does not cover the screen the engine is using, so the dots are scaled to fit. ' +
        'Real calibration needs full screen on the main display.';
  }

  ring(diameter) {
    const r = this.dot.querySelector('.ring');
    r.style.width = `${diameter}px`;
    r.style.height = `${diameter}px`;
    r.style.opacity = diameter > 18 ? '1' : '0.35';
  }

  // ------------------------------------------------------------------ engine calls

  async startRun(kind, extra = {}) {
    const plan = await this.api.post('/api/calibration/start', { kind, ...extra });
    this.runId = plan.run_id;
    this.check();
    return plan;
  }

  async finishRun(plan, extra = {}) {
    this.counter.textContent = 'Fitting…';
    this.dot.hidden = true;
    this.panel(h('h1', { text: 'Working it out…' }), h('p', { text: 'Fitting every model.' }));
    const answer = await this.api.post('/api/calibration/finish', {
      run_id: plan.run_id,
      ...extra,
    });
    this.runId = null;
    this.check();
    return answer;
  }

  // ------------------------------------------------------------------ phases

  /** Show each target: "show", settle (shrinking ring), "collect", collect time, "done". */
  async runDots(plan, opts = {}) {
    const { poseGroup = 0, offset = 0, total = plan.targets.length, prefix = '' } = opts;
    const settle = plan.settle_ms ?? 600;
    const collect = plan.collect_ms ?? 900;
    await this.ensureExact(plan);
    for (let i = 0; i < plan.targets.length; i++) {
      const t = plan.targets[i];
      this.placeDot(plan.screen, t.x, t.y, plan.targets);
      const rec = { dot_id: t.dot_id, x: t.x, y: t.y, pose_group: poseGroup };
      rec.show = performance.now();
      this.send(plan, t, 'show', poseGroup);
      const t0 = performance.now();
      for (;;) {
        await this.frame();
        const f = Math.min(1, (performance.now() - t0) / Math.max(1, settle));
        this.ring(70 - 56 * (1 - (1 - f) * (1 - f)));
        if (f >= 1) break;
      }
      rec.collect = performance.now();
      this.send(plan, t, 'collect', poseGroup);
      await this.wait(collect);
      await this.extendForSamples(plan, t, collect);
      rec.done = performance.now();
      this.send(plan, t, 'done', poseGroup);
      this.timings.push(rec);
      this.setProgress(offset + i + 1, total, `${prefix}Dot ${offset + i + 1} of ${total}`);
    }
    this.dot.hidden = true;
  }

  /** Moving dot through the engine's way-points, one way-point every 250 ms. */
  async runPursuit(plan) {
    const pts = plan.targets;
    if (!pts.length) return;
    const settle = plan.settle_ms ?? 600;
    await this.ensureExact(plan);
    this.placeDot(plan.screen, pts[0].x, pts[0].y, pts);
    this.send(plan, pts[0], 'show');
    const s0 = performance.now();
    for (;;) {
      await this.frame();
      const f = Math.min(1, (performance.now() - s0) / Math.max(1, settle));
      this.ring(70 - 56 * f);
      if (f >= 1) break;
    }
    const t0 = performance.now();
    let prev = -1;
    for (;;) {
      await this.frame();
      const el = performance.now() - t0;
      const i = Math.floor(el / PURSUIT_STEP_MS);
      if (i >= pts.length) break;
      const f = (el % PURSUIT_STEP_MS) / PURSUIT_STEP_MS;
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      if (i !== prev) {
        if (prev >= 0) this.send(plan, pts[prev], 'done');
        prev = i;
      }
      this.send(plan, { dot_id: a.dot_id, x, y }, 'collect');
      this.placeDot(plan.screen, x, y, pts);
      this.setProgress(i + 1, pts.length, `Follow the dot · ${Math.ceil((pts.length - i) / 4)} s`);
    }
    if (prev >= 0) this.send(plan, pts[prev], 'done');
    this.dot.hidden = true;
  }

  /** Coded flash for the reflection estimator: whole-window brightness plus a white border. */
  async runFlash(pattern) {
    const m = /@\s*([0-9.]+)/.exec(pattern);
    const step = m ? Number(m[1]) : 125;
    const bits = [...pattern.replace(/@.*$/, '')].filter((c) => c === '0' || c === '1');
    if (!bits.length) return;
    this.clearPanel();
    this.stage.appendChild(h('div', { class: 'cross' }));
    this.counter.textContent = 'Keep looking at the cross';
    await this.wait(900);
    const bg = this.root.style.background;
    this.flashFrame.hidden = false;
    const show = (bit) => {
      this.root.style.background = bit ? '#ffffff' : '#101010';
      this.flashFrame.style.borderWidth = bit ? '40px' : '0';
    };
    show(bits[0] === '1');
    this.api.send({ type: 'ui.pattern', pattern, on: true });
    const t0 = performance.now();
    try {
      for (;;) {
        await this.frame();
        const k = Math.floor((performance.now() - t0) / step);
        if (k >= bits.length * FLASH_REPEATS) break;
        show(bits[k % bits.length] === '1');
      }
    } finally {
      this.api.send({ type: 'ui.pattern', pattern, on: false });
      this.root.style.background = bg;
      this.flashFrame.hidden = true;
      fill(this.stage);
    }
  }

  // ------------------------------------------------------------------ flows

  async run() {
    try {
      let result;
      if (this.kind === 'refine' || this.kind === 'validate' || this.kind === 'touchup')
        result = await this.simpleFlow();
      else if (this.kind === 'pursuit') result = await this.pursuitFlow();
      else result = await this.fullFlow();
      return result;
    } catch (err) {
      if (err instanceof Cancelled) return null;
      await this.showError(err);
      return null;
    }
  }

  async showError(err) {
    if (this.runId) {
      this.api.post('/api/calibration/cancel', { run_id: this.runId }).catch(() => {});
      this.runId = null;
    }
    this.panel(
      h('h1', { text: 'That did not work' }),
      h('p', { text: err.message || String(err), 'data-testid': 'calib-error' }),
      h('p', { class: 'keys', text: 'Press Esc or the button to close.' }),
      h('button', { class: 'big', text: 'Close', onclick: () => this.cancel() }),
    );
    try {
      await this.waitGo();
    } catch {
      // closed with Esc
    }
  }

  calibOptions() {
    const values = (this.ctx.config && this.ctx.config.values) || {};
    const c = values.calibration || {};
    return {
      grid: c.grid || '3x3',
      movingDot: Boolean(c.moving_dot),
      poseRounds: Math.max(1, Number(c.pose_rounds) || 1),
      headSweep: Math.max(0, Number(c.head_sweep) || 0),
      qualityGate: Boolean(c.quality_gate),
      flash: Boolean(store('flash', false)),
    };
  }

  async setConfig(changes) {
    try {
      const res = await this.api.post('/api/config', { changes });
      if (this.ctx.config) this.ctx.config.values = res.values;
      const errs = Object.values(res.errors || {});
      if (errs.length) this.ctx.toast(errs.join(' '), 'error');
    } catch (err) {
      this.ctx.toast(err.message, 'error');
    }
  }

  async fullFlow() {
    await this.ctx.loadConfig().catch(() => null);
    const o = this.calibOptions();
    const moving = h('input', {
      type: 'checkbox',
      checked: o.movingDot,
      'data-testid': 'opt-moving',
      onchange: (e) => this.setConfig({ 'calibration.moving_dot': e.target.checked }),
    });
    const rounds = h('select', {
      'data-testid': 'opt-rounds',
      onchange: (e) => this.setConfig({ 'calibration.pose_rounds': Number(e.target.value) }),
    });
    for (let i = 1; i <= 5; i++) {
      rounds.appendChild(
        h('option', { value: String(i), text: String(i), selected: i === o.poseRounds }),
      );
    }
    const sweep = h('select', {
      'data-testid': 'opt-sweep',
      onchange: (e) => this.setConfig({ 'calibration.head_sweep': Number(e.target.value) }),
    });
    for (let i = 0; i <= 3; i++) {
      sweep.appendChild(
        h('option', {
          value: String(i),
          text: i ? `${i} dot${i > 1 ? 's' : ''}` : 'off',
          selected: i === o.headSweep,
        }),
      );
    }
    const gate = h('input', {
      type: 'checkbox',
      checked: o.qualityGate,
      'data-testid': 'opt-gate',
      onchange: (e) => this.setConfig({ 'calibration.quality_gate': e.target.checked }),
    });
    const flash = h('input', {
      type: 'checkbox',
      checked: o.flash,
      'data-testid': 'opt-flash',
      onchange: (e) => save('flash', e.target.checked),
    });
    this.panel(
      h('h1', { text: 'Calibration' }),
      h('p', {
        text: 'Look at the centre of each red dot until it moves on. Keep your head still.',
      }),
      h('p', { text: POSE_PROMPTS[0] }),
      h(
        'div',
        { class: 'card', style: { textAlign: 'left', fontSize: '1.05rem', margin: '18px 0' } },
        h('label', { class: 'row' }, moving, ' Follow a moving dot as well (about 12 s)'),
        h(
          'label',
          { class: 'row' },
          'Head positions: ',
          rounds,
          h('span', {
            class: 'muted small',
            text: ' (two or more lets the geometric model learn your eyes)',
          }),
        ),
        h(
          'label',
          { class: 'row' },
          'Head sweep: ',
          sweep,
          h('span', {
            class: 'muted small',
            text: ' (look at a dot while turning your head, about 10 s each; used by models.eyeball_centre "head" or "auto" on the Experiments page)',
          }),
        ),
        h('label', { class: 'row' }, gate, ' Show poor dots again once (quality gate)'),
        h(
          'label',
          { class: 'row' },
          flash,
          ' Flash the screen for 3 s first (helps find the screen reflection; leave off if flashing light bothers you)',
        ),
        h('div', {
          class: 'muted small',
          text: `Grid ${o.grid}. Change the grid on the Experiments page.`,
        }),
      ),
      this.goButton('Start'),
      h('p', { class: 'keys', text: 'Space starts · Esc cancels at any time' }),
    );
    await this.waitGo();
    const opts = this.calibOptions();
    opts.flash = flash.checked;
    opts.movingDot = moving.checked;
    opts.poseRounds = Number(rounds.value);
    this.clearPanel();
    await this.fullscreen();

    let pursuitAnswer = null;
    if (opts.flash) await this.runFlash(DEFAULT_FLASH);
    if (opts.movingDot) {
      // A separate engine run, fitted for its report only (commit: false): the grid's fit
      // (below) is the one that goes into use, and cancelling the grid keeps the previous
      // calibration rather than the moving-dot fit.
      const pplan = await this.startRun('pursuit');
      if (pplan.flash && pplan.flash.pattern) await this.runFlash(pplan.flash.pattern);
      this.clearPanel();
      await this.runPursuit(pplan);
      pursuitAnswer = await this.finishRun(pplan, { commit: false });
      this.clearPanel();
    }
    const plan = await this.startRun('grid', { pose_rounds: opts.poseRounds });
    const nRounds = Math.max(1, opts.poseRounds || plan.pose_rounds || 1);
    const total = plan.targets.length * nRounds;
    for (let r = 0; r < nRounds; r++) {
      if (r > 0) {
        this.panel(
          h('h1', { text: `Head position ${r + 1} of ${nRounds}` }),
          h('p', { text: POSE_PROMPTS[r % POSE_PROMPTS.length], 'data-testid': 'pose-prompt' }),
          h('p', { text: 'The same dots again.' }),
          this.goButton('Ready'),
          h('p', { class: 'keys', text: 'Space when ready · Esc cancels' }),
        );
        await this.waitGo();
        this.clearPanel();
        await this.wait(300);
      }
      await this.runDots(plan, {
        poseGroup: r,
        offset: r * plan.targets.length,
        total,
        prefix: nRounds > 1 ? `Position ${r + 1} · ` : '',
      });
      if (plan.quality_gate) await this.qualityGate(plan, r);
    }
    const sweepDots = (plan.sweep && plan.sweep.targets) || [];
    for (let k = 0; k < sweepDots.length; k++) {
      await this.runSweep(plan, sweepDots[k], k, sweepDots.length);
    }
    const answer = await this.finishRun(plan);
    return this.report(answer, plan, { pursuitAnswer });
  }

  /**
   * Quality gate: ask the engine which dots of this head position were rejected, scattered or
   * far off, and show those once more (same ids, so the engine keeps the better attempt).
   */
  async qualityGate(plan, poseGroup) {
    let check;
    try {
      check = await this.api.post('/api/calibration/check', { run_id: plan.run_id });
    } catch {
      return; // an older engine, or no gate: carry on
    }
    this.check();
    const retry = (check.retry || []).filter((d) => (d.pose_group || 0) === poseGroup);
    if (!retry.length) return;
    this.panel(
      h('h1', { text: 'A few dots again' }),
      h('p', {
        text: `${retry.length} dot${retry.length > 1 ? 's' : ''} did not measure well. Look at each one again, as before.`,
        'data-testid': 'gate-prompt',
      }),
      h('p', { class: 'muted small', text: retry.map((d) => d.reason).join(' · ') }),
      h('p', { class: 'keys', text: 'Starting by itself · Esc cancels' }),
    );
    // Automatic: no key press, so the flow never stops and waits here.
    await this.wait(2000);
    this.clearPanel();
    await this.wait(250);
    const again = { ...plan, targets: retry.map((d) => ({ dot_id: d.dot_id, x: d.x, y: d.y })) };
    await this.runDots(again, { poseGroup, prefix: 'Again · ' });
  }

  /** Head sweep: one dot held for plan.sweep.seconds while the head turns and moves. */
  async runSweep(plan, target, k, n) {
    const seconds = Number(plan.sweep.seconds) || 10;
    const prompt =
      (plan.sweep.prompts || [])[k] || 'Keep your eyes on the dot and slowly move your head.';
    this.panel(
      h('h1', { text: n > 1 ? `Head sweep ${k + 1} of ${n}` : 'Head sweep' }),
      h('p', { text: prompt, 'data-testid': 'sweep-prompt' }),
      h('p', {
        class: 'muted',
        text: `About ${Math.round(seconds)} seconds. Slow and small is fine; never take your eyes off the dot.`,
      }),
      this.goButton('Ready'),
      h('p', { class: 'keys', text: 'Space when ready · Esc cancels' }),
    );
    await this.waitGo();
    this.clearPanel();
    await this.ensureExact(plan);
    this.placeDot(plan.screen, target.x, target.y, plan.targets.concat([target]));
    this.send(plan, target, 'show', 0);
    const settle = plan.settle_ms ?? 600;
    const s0 = performance.now();
    for (;;) {
      await this.frame();
      const f = Math.min(1, (performance.now() - s0) / Math.max(1, settle));
      this.ring(70 - 56 * f);
      if (f >= 1) break;
    }
    this.send(plan, target, 'collect', 0);
    const t0 = performance.now();
    for (;;) {
      await this.frame();
      const left = seconds - (performance.now() - t0) / 1000;
      if (left <= 0) break;
      this.setProgress(
        seconds - left,
        seconds,
        `Eyes on the dot, move your head slowly · ${Math.ceil(left)} s`,
      );
    }
    this.send(plan, target, 'done', 0);
    this.dot.hidden = true;
  }

  async pursuitFlow() {
    this.panel(
      h('h1', { text: 'Moving dot' }),
      h('p', { text: 'Follow the red dot with your eyes. Keep your head still.' }),
      this.goButton('Start'),
      h('p', { class: 'keys', text: 'Space starts · Esc cancels' }),
    );
    await this.waitGo();
    this.clearPanel();
    await this.fullscreen();
    const plan = await this.startRun('pursuit');
    await this.runPursuit(plan);
    const answer = await this.finishRun(plan);
    return this.report(answer, plan, {});
  }

  async simpleFlow() {
    const isRefine = this.kind === 'refine';
    const isTouchup = this.kind === 'touchup';
    this.panel(
      h('h1', { text: isRefine ? 'Quick refine' : isTouchup ? 'Touch-up' : 'Validation' }),
      h('p', {
        text: isRefine
          ? 'Look at the centre of each dot. This adjusts the calibration you already have.'
          : isTouchup
            ? 'The places that were least accurate, once more. They measure accuracy again and, with the error map on, correct it there.'
            : 'Look at the centre of each dot. These dots are only used to measure accuracy (and, with the error map on, to correct it).',
      }),
      this.goButton('Start'),
      h('p', { class: 'keys', text: 'Space starts · Esc cancels' }),
    );
    await this.waitGo();
    this.clearPanel();
    await this.fullscreen();
    const plan = isTouchup
      ? await this.startRun('validate', { targets: touchupTargets })
      : await this.startRun(this.kind);
    await this.wait(250);
    await this.runDots(plan, {});
    const answer = await this.finishRun(plan);
    return this.report(answer, plan, {});
  }

  // ------------------------------------------------------------------ report

  async report(answer, plan, extra) {
    this.ctx.lastReport = { answer, plan, timings: this.timings };
    this.root.classList.add('show-cursor');
    this.dot.hidden = true;
    this.progress.style.width = '0%';
    this.counter.textContent = '';
    this.notice.textContent = '';
    fill(this.stage);
    const box = h('div', { class: 'report', 'data-testid': 'calib-report' });
    this.stage.appendChild(box);
    renderReport(box, answer, plan, {
      timings: this.timings,
      pursuitAnswer: extra.pursuitAnswer,
      actions: [
        h('button', {
          class: 'primary big',
          text: 'Done',
          'data-testid': 'report-done',
          onclick: () => this.cancel(),
        }),
        answer.kind === 'validate' && (answer.touchup || []).length
          ? h('button', {
              class: 'big',
              text: `Touch up the worst ${answer.touchup.length}`,
              'data-testid': 'report-touchup',
              onclick: () => {
                touchupTargets = answer.touchup;
                this.cancel();
                window.setTimeout(() => this.ctx.calibrate('touchup'), 50);
              },
            })
          : null,
        answer.kind !== 'validate'
          ? h('button', {
              class: 'big',
              text: 'Validate now',
              onclick: () => {
                this.cancel();
                window.setTimeout(() => this.ctx.calibrate('validate'), 50);
              },
            })
          : null,
        h('button', {
          class: 'big',
          text: 'Calibrate again',
          onclick: () => {
            this.cancel();
            window.setTimeout(() => this.ctx.calibrate('full'), 50);
          },
        }),
      ],
    });
    try {
      await this.waitGo();
    } catch {
      // closed
    }
    return answer;
  }
}

// ---------------------------------------------------------------------- report rendering

const REGIONS = [
  'Top left',
  'Top',
  'Top right',
  'Left',
  'Centre',
  'Right',
  'Bottom left',
  'Bottom',
  'Bottom right',
];

function regionOf(target, screen) {
  const col = Math.min(2, Math.max(0, Math.floor((3 * target[0]) / screen.width)));
  const row = Math.min(2, Math.max(0, Math.floor((3 * target[1]) / screen.height)));
  return row * 3 + col;
}

/** Per model: list of per-dot entries ({target, mean, error_deg, error_pt}). */
function perDotByModel(answer) {
  const out = {};
  if (answer.validation) {
    for (const [name, v] of Object.entries(answer.validation)) out[name] = (v && v.per_dot) || [];
  } else {
    for (const r of answer.reports || []) out[r.model] = r.per_dot || [];
  }
  return out;
}

function regionTable(perDot, screen) {
  const models = Object.keys(perDot);
  const used = new Set();
  const cells = {};
  for (const m of models) {
    const sums = new Array(9).fill(0);
    const counts = new Array(9).fill(0);
    for (const d of perDot[m]) {
      if (!d.target || d.error_deg === null || d.error_deg === undefined) continue;
      const r = regionOf(d.target, screen);
      sums[r] += d.error_deg;
      counts[r] += 1;
      used.add(r);
    }
    cells[m] = sums.map((s, i) => (counts[i] ? s / counts[i] : null));
  }
  const regions = [...used].sort((a, b) => a - b);
  if (!regions.length)
    return h('p', { class: 'muted', text: 'No per-dot errors in degrees to show.' });
  return h(
    'div',
    { class: 'tablewrap' },
    h(
      'table',
      { 'data-testid': 'region-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: 'Model' }),
          regions.map((r) => h('th', { class: 'num', text: REGIONS[r] })),
        ),
      ),
      h(
        'tbody',
        {},
        models.map((m) =>
          h(
            'tr',
            {},
            h('td', { text: m }),
            regions.map((r) =>
              h(
                'td',
                { class: 'num', style: { color: errorColour(cells[m][r]) } },
                deg(cells[m][r]),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Draw the error heat map: each dot coloured by error, a line to the mean prediction. */
export function drawHeatmap(canvas, perDot, screen) {
  const ratio = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = (cssW * screen.height) / screen.width;
  canvas.width = Math.round(cssW * ratio);
  canvas.height = Math.round(cssH * ratio);
  canvas.style.height = `${cssH}px`;
  const g = canvas.getContext('2d');
  g.scale(ratio, ratio);
  const k = cssW / screen.width;
  g.clearRect(0, 0, cssW, cssH);
  const style = window.getComputedStyle(document.body);
  g.strokeStyle = style.getPropertyValue('--line') || '#888';
  g.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    g.beginPath();
    g.moveTo((cssW * i) / 3, 0);
    g.lineTo((cssW * i) / 3, cssH);
    g.moveTo(0, (cssH * i) / 3);
    g.lineTo(cssW, (cssH * i) / 3);
    g.stroke();
  }
  const text = style.getPropertyValue('--text') || '#000';
  g.font = '12px system-ui, sans-serif';
  const labels = new Map();
  for (const d of perDot) {
    if (!d.target) continue;
    const x = d.target[0] * k;
    const y = d.target[1] * k;
    const col = errorColour(d.error_deg);
    g.globalAlpha = 0.3;
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, y, 34, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(x, y, 7, 0, Math.PI * 2);
    g.fill();
    if (d.mean) {
      const mx = d.mean[0] * k;
      const my = d.mean[1] * k;
      g.strokeStyle = text;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(mx, my);
      g.stroke();
      g.beginPath();
      g.moveTo(mx - 4, my - 4);
      g.lineTo(mx + 4, my + 4);
      g.moveTo(mx + 4, my - 4);
      g.lineTo(mx - 4, my + 4);
      g.stroke();
    }
    const key = `${Math.round(x)},${Math.round(y)}`;
    const nth = labels.get(key) || 0;
    labels.set(key, nth + 1);
    g.fillStyle = text;
    g.fillText(
      d.error_deg === null || d.error_deg === undefined ? 'no data' : deg(d.error_deg),
      x + 10,
      y - 10 + 14 * nth,
    );
  }
}

function modelTable(answer) {
  if (answer.validation) {
    const rows = Object.entries(answer.validation);
    return h(
      'table',
      { 'data-testid': 'model-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          [
            'Model',
            'Accuracy',
            'Accuracy of dot means',
            'Precision (RMS)',
            'Accuracy (pt)',
            'Predicted',
            'Samples',
          ].map((t, i) => h('th', { class: i ? 'num' : '', text: t })),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map(([name, v]) =>
          h(
            'tr',
            {},
            h('td', { text: name }),
            v && v.error
              ? h('td', { colspan: 6, class: 'bad', text: v.error })
              : [
                  h('td', { class: 'num', text: deg(v.accuracy_deg) }),
                  h('td', { class: 'num', text: deg(v.accuracy_of_mean_deg) }),
                  h('td', { class: 'num', text: deg(v.precision_deg) }),
                  h('td', { class: 'num', text: fmt(v.accuracy_pt, 0) }),
                  h('td', {
                    class: 'num',
                    text:
                      v.valid_fraction === undefined
                        ? '–'
                        : `${Math.round(100 * v.valid_fraction)}%`,
                  }),
                  h('td', { class: 'num', text: fmt(v.n, 0) }),
                ],
          ),
        ),
      ),
    );
  }
  const reports = answer.reports || [];
  return h(
    'table',
    { 'data-testid': 'model-table' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        [
          'Model',
          'Cross-validated',
          'Cross-val (pt)',
          'Training',
          'Precision',
          'Dots',
          'Samples',
          'Note',
        ].map((t, i) => h('th', { class: i && i < 7 ? 'num' : '', text: t })),
      ),
    ),
    h(
      'tbody',
      {},
      reports.map((r) =>
        h(
          'tr',
          { class: r.model === answer.chosen ? 'chosen' : '' },
          h('td', { text: `${r.model}${r.model === answer.chosen ? ' (chosen)' : ''}` }),
          h('td', { class: 'num', text: r.ok ? deg(r.loo_error_deg) : '–' }),
          h('td', { class: 'num', text: r.ok ? fmt(r.loo_error_pt, 0) : '–' }),
          h('td', { class: 'num', text: r.ok ? deg(r.train_error_deg) : '–' }),
          h('td', { class: 'num', text: r.ok ? deg(r.precision_deg) : '–' }),
          h('td', { class: 'num', text: fmt(r.n_dots, 0) }),
          h('td', { class: 'num', text: fmt(r.n_samples, 0) }),
          h('td', {
            class: r.ok ? 'muted small' : 'bad small',
            text: r.message || (r.ok ? '' : 'failed'),
          }),
        ),
      ),
    ),
  );
}

function headline(answer) {
  if (answer.validation) {
    const v = answer.validation;
    const names = Object.keys(v).filter((n) => v[n] && typeof v[n].accuracy_deg === 'number');
    if (!names.length) return 'No model could be validated.';
    names.sort((a, b) => v[a].accuracy_deg - v[b].accuracy_deg);
    return `Best on fresh dots: ${names[0]}, ${deg(v[names[0]].accuracy_deg)} accuracy.`;
  }
  const chosen = (answer.reports || []).find((r) => r.model === answer.chosen);
  if (answer.kind === 'refine') return 'Calibration refined.';
  if (!chosen) return 'No model could be fitted.';
  return `Using ${chosen.model}: ${deg(chosen.loo_error_deg)} cross-validated error.`;
}

function degText(v) {
  return v === null || v === undefined ? '–' : deg(v);
}

/** What the switchable calibration options did: per-eye scores, the moving dot, the gate, the head sweep, the error map. */
function extrasCard(answer) {
  const lines = [];
  for (const r of answer.reports || []) {
    const e = (r.params || {}).eye_loo_deg;
    if (!e) continue;
    lines.push(
      h('li', {
        'data-testid': 'eye-scores',
        text:
          `${r.model}: held-out error with both eyes ${degText(e.both)}, left eye alone ${degText(e.left)}, right eye alone ${degText(e.right)}` +
          (e.weighted !== undefined ? `, both weighted by eye ${degText(e.weighted)}` : '') +
          ((r.params || {}).eye_used ? ` · using ${r.params.eye_used}` : ''),
      }),
    );
  }
  const info = answer.calibration_info || {};
  const p = info.pursuit;
  if (p) {
    lines.push(
      h('li', {
        text:
          p.n_out > 0
            ? `Moving dot: eyes trailed the dot by ${fmt(p.lag_ms, 0)} ms; kept ${p.n_out} of ${p.n_in} samples (${p.dropped_saccade} in catch-up saccades, ${p.dropped_far} far off). ` +
              `Grid held-out error ${degText(p.grid_heldout_deg_without)} without it, ${degText(p.grid_heldout_deg_with)} with it: ${p.merged ? 'merged' : 'not merged'}.`
            : `Moving dot: not merged (${p.reason || 'nothing usable'}).`,
      }),
    );
  }
  if (info.sweep_windows)
    lines.push(
      h('li', { text: `Head sweep: ${info.sweep_windows} windows of head movement used.` }),
    );
  const dots = answer.run_dots || [];
  const retried = dots.filter((d) => d.retry).length;
  const rejected = dots.filter((d) => d.reason && !d.replaced).map((d) => d.reason);
  if (retried)
    lines.push(
      h('li', { text: `Quality gate: ${retried} dot${retried > 1 ? 's' : ''} shown again.` }),
    );
  if (rejected.length)
    lines.push(h('li', { text: `Not used: ${rejected.length} dot(s): ${rejected.join('; ')}` }));
  const maps = answer.error_map || {};
  for (const [name, m] of Object.entries(maps)) {
    if (!m || m.reason === 'off') continue;
    lines.push(
      h('li', {
        'data-testid': 'error-map',
        text: `Error map for ${name} (${m.kind || ''}, ${m.n_dots ?? '?'} dots): ${m.reason || ''}`,
      }),
    );
  }
  if (!lines.length) return null;
  return h(
    'div',
    { class: 'card' },
    h('h2', { text: 'Calibration options' }),
    h('ul', {}, ...lines),
  );
}

export function renderReport(box, answer, plan, opts = {}) {
  const screen = plan.screen || { width: 1, height: 1 };
  const perDot = perDotByModel(answer);
  const names = Object.keys(perDot);
  const select = h('select', { 'data-testid': 'heat-model' });
  const preferred = answer.chosen && perDot[answer.chosen] ? answer.chosen : names[0];
  for (const n of names)
    select.appendChild(h('option', { value: n, text: n, selected: n === preferred }));
  const canvas = h('canvas', { class: 'heat', 'data-testid': 'heatmap' });
  const draw = () => drawHeatmap(canvas, perDot[select.value] || [], screen);
  select.addEventListener('change', draw);
  const kindLabel = {
    grid: 'Calibration',
    pursuit: 'Moving dot',
    refine: 'Quick refine',
    validate: 'Validation',
    touchup: 'Touch-up',
  };
  const timings = opts.timings || [];
  const seconds = timings.length
    ? (timings[timings.length - 1].done - timings[0].show) / 1000
    : null;
  fill(
    box,
    h(
      'div',
      { class: 'card' },
      h('div', {
        class: 'muted',
        text: `${kindLabel[answer.kind] || answer.kind} · run ${answer.run_id}`,
      }),
      h('div', { class: 'headline', text: headline(answer), 'data-testid': 'report-headline' }),
      h(
        'p',
        { class: 'muted' },
        `${fmt(answer.n_samples, 0)} samples`,
        timings.length ? ` from ${timings.length} dots in ${fmt(seconds, 1)} s` : '',
        '. Errors are visual angle at your eye; lower is better.',
      ),
      h('div', { class: 'row' }, ...(opts.actions || [])),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Accuracy per model' }),
      h('div', { class: 'tablewrap' }, modelTable(answer)),
    ),
    extrasCard(answer),
    opts.pursuitAnswer
      ? h(
          'div',
          { class: 'card' },
          h('h2', { text: 'Moving dot (fitted on its own; the grid fit above is the one in use)' }),
          h('div', { class: 'tablewrap' }, modelTable(opts.pursuitAnswer)),
        )
      : null,
    h(
      'div',
      { class: 'card' },
      h('h2', { text: 'Error by screen region' }),
      regionTable(perDot, screen),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('h2', { text: 'Error by dot', style: { margin: 0 } }),
        names.length ? select : null,
        h('span', { class: 'legendbar', title: '0° to 4° and above' }),
        h('span', {
          class: 'muted small',
          text: 'green 0° · red ≥ 4° · line to the mean prediction',
        }),
      ),
      names.length ? canvas : h('p', { class: 'muted', text: 'No per-dot results.' }),
    ),
  );
  if (names.length) window.requestAnimationFrame(draw);
}
