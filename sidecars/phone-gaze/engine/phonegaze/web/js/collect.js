/* global window, document, performance, requestAnimationFrame */
// Collect: a guided collection run (engine: phonegaze/collect.py, /api/collect/*). A run is a
// queue of conditions (physical setups); each one is configured on the phone, checked (focus,
// exposure, face and eyes), then recorded raw while one fixed protocol runs full screen. No
// model is fitted and the cursor does not move; the offline sweep does the rest.

import { h, fill, fmt, screenMapper } from './util.js';

const POLL_MS = 500;
const PURSUIT_SEND_MS = 66;

class Paused extends Error {
  constructor() {
    super('paused');
  }
}

let overlayOpen = false;

/** True while the full-screen protocol runs (app.js then leaves the keyboard alone). */
export function collectRunning() {
  return overlayOpen;
}

function minutes(s) {
  if (s === null || s === undefined) return '–';
  if (s < 90) return `about ${Math.max(1, Math.round(s))} s`;
  return `about ${Math.round(s / 60)} min`;
}

function pct(v) {
  return v === null || v === undefined ? '–' : `${v.toFixed(0)} %`;
}

export function qualityText(q) {
  if (!q) return 'No frames yet.';
  return `Face found ${pct(q.face_pct)} · both eyes found ${pct(q.both_eyes_pct)} · frames received ${fmt(q.frames_received, 0)}`;
}

// ---------------------------------------------------------------------------------------------
// The full-screen protocol
// ---------------------------------------------------------------------------------------------

class Protocol {
  constructor(ctx, plan, condition) {
    this.ctx = ctx;
    this.api = ctx.api;
    this.plan = plan;
    this.condition = condition;
    this.abort = new window.AbortController();
    this.goResolve = null;
    this.root = h('div', { class: 'calib collect-overlay', 'data-testid': 'collect-overlay' });
    this.stage = h('div');
    this.dot = h(
      'div',
      { class: 'dot', hidden: true },
      h('div', { class: 'ring' }),
      h('div', { class: 'core' }),
      h('div', { class: 'pin' }),
    );
    this.progress = h('div', { class: 'progress', style: { width: '0%' } });
    this.counter = h('div', { class: 'counter' });
    this.quality = h('div', { class: 'notice', 'data-testid': 'collect-live-quality' });
    this.root.append(this.stage, this.dot, this.progress, this.counter, this.quality);
    this.onKey = (ev) => this.key(ev);
    window.addEventListener('keydown', this.onKey, true);
    document.body.appendChild(this.root);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    this.total = plan.phases.reduce((n, p) => n + (p.dots ? p.dots.length : 0), 0);
    this.done = 0;
    this.qTimer = window.setInterval(() => this.pollQuality(), 1000);
    overlayOpen = true;
  }

  async pollQuality() {
    try {
      const st = await this.api.get('/api/collect/status');
      this.quality.textContent = qualityText(st.quality);
    } catch {
      // the next poll will tell
    }
  }

  key(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.inMenu) this.go('continue');
      else if (!this.abort.signal.aborted) {
        this.abort.abort();
        if (this.goResolve) this.goResolve();
      }
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      if (ev.target && ev.target.tagName === 'BUTTON' && this.root.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.go();
    }
  }

  go(value) {
    if (this.goResolve) {
      const fn = this.goResolve;
      this.goResolve = null;
      fn(value);
    }
  }

  check() {
    if (this.abort.signal.aborted) throw new Paused();
  }

  wait(ms) {
    this.check();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(new Paused());
        },
        { once: true },
      );
    });
  }

  frame() {
    this.check();
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  waitGo() {
    this.check();
    return new Promise((resolve) => {
      this.goResolve = resolve;
    }).then((v) => {
      this.check();
      return v;
    });
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

  button(label, value, testid, cls = 'big') {
    return h('button', {
      class: cls,
      text: label,
      'data-testid': testid,
      onclick: () => this.go(value),
    });
  }

  async prompt(title, text) {
    this.panel(
      h('h1', { text: title }),
      text ? h('p', { text, 'data-testid': 'collect-prompt' }) : null,
      h('p', { class: 'keys', text: 'Press Space when ready. Esc pauses.' }),
      this.button('Continue', true, 'collect-continue', 'primary big'),
    );
    await this.waitGo();
    this.clearPanel();
  }

  async fullscreen() {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        await document.documentElement.requestFullscreen();
        await new Promise((r) => window.setTimeout(r, 400));
      } catch {
        // Not allowed (headless, no gesture): the dots are mapped into the window instead.
      }
    }
    this.api.sendScreen();
  }

  allPoints() {
    const pts = [];
    for (const p of this.plan.phases) {
      for (const d of p.dots || []) pts.push(d);
      for (const [x, y] of p.path || []) pts.push({ x, y });
    }
    return pts;
  }

  /** The engine measures the main display; refuse a window that does not cover it (macOS). */
  async ensureExact() {
    const scr = this.plan.screen;
    if (!scr || scr.source !== 'macos') return;
    const t0 = performance.now();
    while (!screenMapper(scr, this.allPoints()).exact) {
      if (performance.now() - t0 > 2000)
        throw new Error(
          'This window does not cover the main display, which is the screen Phone Gaze uses. ' +
            'Move it to the main display, make it full screen, and start the condition again.',
        );
      await this.wait(100);
    }
  }

  place(x, y) {
    const map = screenMapper(this.plan.screen, this.allPoints());
    const [cx, cy] = map.toCss(x, y);
    this.dot.style.left = `${cx}px`;
    this.dot.style.top = `${cy}px`;
    this.dot.hidden = false;
  }

  ring(diameter) {
    const r = this.dot.querySelector('.ring');
    r.style.width = `${diameter}px`;
    r.style.height = `${diameter}px`;
    r.style.opacity = diameter > 18 ? '1' : '0.35';
  }

  post(path, body) {
    return this.api.post(path, body);
  }

  async showDot(phase, d) {
    const settle = this.plan.settle_ms ?? 600;
    const collect = this.plan.collect_ms ?? 900;
    this.place(d.x, d.y);
    this.ring(70);
    const msg = { phase, dot_id: d.id, x: d.x, y: d.y, pose_group: d.pose_group };
    await this.post('/api/collect/dot', { ...msg, state: 'on' });
    const t0 = performance.now();
    for (;;) {
      await this.frame();
      const f = Math.min(1, (performance.now() - t0) / Math.max(1, settle));
      this.ring(70 - 56 * (1 - (1 - f) * (1 - f)));
      if (f >= 1) break;
    }
    await this.wait(collect);
    this.dot.hidden = true;
    await this.post('/api/collect/dot', { ...msg, state: 'off' });
    this.done += 1;
    this.progress.style.width = `${this.total ? (100 * this.done) / this.total : 0}%`;
  }

  async runDots(phase, dots, label) {
    for (let i = 0; i < dots.length; i++) {
      this.counter.textContent = `${label} · dot ${i + 1} of ${dots.length}`;
      await this.showDot(phase, dots[i]);
    }
  }

  async runPhase(p) {
    await this.post('/api/collect/phase', { name: p.name });
    if (p.name === 'calibration') {
      await this.prompt('Calibration dots', p.intro);
      await this.runDots(p.name, p.dots, 'Calibration');
    } else if (p.name === 'poses') {
      await this.prompt('Head positions', p.intro);
      const groups = [...new Set(p.dots.map((d) => d.pose_group))];
      for (const g of groups) {
        await this.prompt(`Head position ${g} of ${groups.length}`, p.prompts[String(g)]);
        await this.runDots(
          p.name,
          p.dots.filter((d) => d.pose_group === g),
          `Head position ${g}`,
        );
      }
    } else if (p.name === 'validation') {
      await this.prompt('Check dots', p.intro);
      await this.runDots(p.name, p.dots, 'Check');
    } else if (p.name === 'pursuit') {
      await this.prompt('Moving dot', p.intro);
      await this.runPursuit(p);
    }
  }

  async runPursuit(p) {
    const pts = p.path;
    const step = p.step_ms || 250;
    this.place(pts[0][0], pts[0][1]);
    this.ring(70);
    const s0 = performance.now();
    const settle = this.plan.settle_ms ?? 600;
    for (;;) {
      await this.frame();
      const f = Math.min(1, (performance.now() - s0) / Math.max(1, settle));
      this.ring(70 - 56 * f);
      if (f >= 1) break;
    }
    const t0 = performance.now();
    let lastSent = 0;
    let inFlight = false;
    for (;;) {
      await this.frame();
      const el = performance.now() - t0;
      const i = Math.floor(el / step);
      if (i >= pts.length - 1) break;
      const f = (el % step) / step;
      const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f;
      const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
      this.place(x, y);
      this.counter.textContent = `Follow the dot · ${Math.ceil(((pts.length - 1 - i) * step) / 1000)} s`;
      if (!inFlight && performance.now() - lastSent >= PURSUIT_SEND_MS) {
        inFlight = true;
        lastSent = performance.now();
        this.post('/api/collect/pursuit', { x, y })
          .catch(() => {})
          .finally(() => {
            inFlight = false;
          });
      }
    }
    this.dot.hidden = true;
  }

  /** Esc: what now? Resolves 'continue', 'redo', 'skip' or 'stop'. */
  async pauseMenu() {
    this.abort = new window.AbortController();
    this.panel(
      h('h1', { text: 'Paused', 'data-testid': 'collect-paused' }),
      h('p', {
        text: 'Continue repeats the part you were in. Redo records this condition again from the start.',
      }),
      h(
        'div',
        { class: 'row', style: { justifyContent: 'center' } },
        this.button('Continue', 'continue', 'collect-resume', 'primary big'),
        this.button('Redo this condition', 'redo', 'collect-redo'),
        this.button('Skip this condition', 'skip', 'collect-skip'),
        this.button('Stop for now', 'stop', 'collect-stop'),
      ),
    );
    this.inMenu = true;
    const choice = await new Promise((resolve) => {
      this.goResolve = resolve;
    });
    this.inMenu = false;
    this.clearPanel();
    return typeof choice === 'string' ? choice : 'continue';
  }

  /** Runs every phase; returns 'finished', 'redo', 'skip' or 'stop'. */
  async run() {
    await this.fullscreen();
    await this.ensureExact();
    for (const p of this.plan.phases) {
      const base = this.done;
      for (;;) {
        try {
          await this.runPhase(p);
          break;
        } catch (err) {
          if (!(err instanceof Paused)) throw err;
          this.dot.hidden = true;
          const choice = await this.pauseMenu();
          if (choice !== 'continue') return choice;
          await this.post('/api/collect/phase', { name: p.name, restart: true });
          this.done = base;
        }
      }
    }
    return 'finished';
  }

  close() {
    window.clearInterval(this.qTimer);
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    overlayOpen = false;
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

function select(testid, options, value) {
  const el = h('select', { 'data-testid': testid });
  for (const [v, label] of options) el.appendChild(h('option', { value: String(v), text: label }));
  el.value = String(value);
  return el;
}

export default {
  id: 'collect',
  title: 'Collect',
  mount(root, ctx) {
    const { api } = ctx;
    const s = {
      opts: null,
      run: null,
      prep: null, // {index, prompts, camera} while preparing
      ready: null,
      result: null, // last finished condition
      summary: null,
      recording: false,
      refusal: '',
      busy: false,
    };
    let timer = null;
    let alive = true;
    const view = h('div', { class: 'collect' });
    root.appendChild(view);

    const toast = (msg, level = 'error') => ctx.toast(msg, level);

    async function call(fn) {
      if (s.busy) return null;
      s.busy = true;
      try {
        return await fn();
      } catch (err) {
        toast(err.message);
        return null;
      } finally {
        s.busy = false;
        render();
      }
    }

    async function load() {
      try {
        s.opts = await api.get('/api/collect/options');
        s.run = s.opts.run;
      } catch (err) {
        toast(err.message);
      }
      render();
    }

    async function queue(op, extra = {}) {
      await call(async () => {
        s.run = await api.post('/api/collect/queue', { op, ...extra });
      });
    }

    function stopPolling() {
      if (timer) window.clearInterval(timer);
      timer = null;
    }

    async function prepare(index) {
      s.result = null;
      s.refusal = '';
      const ans = await call(() => api.post('/api/collect/prepare', { index }));
      if (!ans) return;
      s.prep = ans;
      s.run = ans.run;
      s.ready = null;
      s.refusal = '';
      renderReady();
      await ctx.loadConfig(true).catch(() => {});
      stopPolling();
      timer = window.setInterval(pollReady, POLL_MS);
      render();
    }

    async function pollReady() {
      if (!s.prep || !alive) return;
      try {
        s.ready = await api.get('/api/collect/ready');
      } catch {
        s.ready = null;
      }
      renderReady();
    }

    async function go() {
      if (!s.prep) return;
      const r = s.ready;
      if (r && r.face && !r.eyes) {
        s.refusal = `Not starting yet: ${r.message}`;
        renderReady();
        return;
      }
      let ans;
      try {
        ans = await api.post('/api/collect/start', { index: s.prep.index });
      } catch (err) {
        s.refusal = err.message;
        renderReady();
        return;
      }
      stopPolling();
      s.refusal = '';
      const index = s.prep.index;
      s.prep = null;
      s.recording = true;
      render();
      const plan = { ...ans.protocol };
      plan.screen = {
        ...plan.screen,
        source: (api.state && api.state.screen && api.state.screen.source) || '',
      };
      const proto = new Protocol(ctx, plan, ans.condition);
      let outcome;
      try {
        outcome = await proto.run();
      } catch (err) {
        outcome = 'stop';
        toast(err.message);
      } finally {
        proto.close();
        s.recording = false;
      }
      if (outcome === 'finished') {
        const res = await call(() => api.post('/api/collect/finish'));
        s.prep = null;
        if (res) {
          s.result = res;
          s.run = res.run;
        }
      } else {
        const r2 = await call(() => api.post('/api/collect/abort', { action: outcome }));
        if (r2) s.run = r2;
        if (outcome === 'redo') {
          await prepare(index);
          return;
        }
      }
      render();
    }

    async function closeRun() {
      stopPolling();
      s.prep = null;
      const sum = await call(() => api.post('/api/collect/close', { restore: true }));
      if (sum) {
        s.summary = sum;
        s.run = null;
        s.result = null;
        await ctx.loadConfig(true).catch(() => {});
        api.refreshState().catch(() => {});
      }
      render();
    }

    // -- pieces ----------------------------------------------------------------------------

    function newRunCard() {
      const o = s.opts;
      const boxes = Object.entries(o.sets).map(([k, set]) => {
        const box = h('input', { type: 'checkbox', value: k, 'data-testid': `set-${k}` });
        return {
          box,
          el: h(
            'label',
            { class: 'collect-set' },
            box,
            h('b', { text: ` ${set.label}` }),
            h('span', {
              class: 'muted small',
              text: ` · ${set.count} conditions. ${set.description}`,
            }),
          ),
        };
      });
      const length = select(
        'collect-length',
        Object.entries(o.lengths).map(([k, v]) => [
          k,
          `${k}: ${v.label}${v.seconds ? ` (${Math.round(v.seconds)} s)` : ''}`,
        ]),
        o.defaults.length,
      );
      const pursuit = h('input', {
        type: 'checkbox',
        checked: o.defaults.pursuit,
        'data-testid': 'collect-pursuit',
      });
      const est = h('p', { class: 'muted', 'data-testid': 'collect-estimate-new' });
      const update = () => {
        const n = new Set();
        let count = 0;
        for (const b of boxes) if (b.box.checked) n.add(b.box.value);
        for (const k of n) count += o.sets[k].count;
        const per = (o.lengths[length.value].seconds || 0) + o.setup_estimate_s;
        est.textContent = count
          ? `Up to ${count} conditions: ${minutes(count * per)} in all (${minutes(o.lengths[length.value].seconds)} of dots each, plus about ${Math.round(o.setup_estimate_s)} s to set up).`
          : 'Tick a set, or start an empty run and add conditions yourself.';
      };
      for (const b of boxes) b.box.addEventListener('change', update);
      length.addEventListener('change', update);
      update();
      return h(
        'section',
        { class: 'card wide' },
        h('h2', { text: 'Collect data, then let the machine search' }),
        h('p', {
          text:
            'Record the same short set of dots once per physical setup (camera, zoom, shutter, reflection helper). ' +
            'Nothing is fitted now; afterwards the sweep replays the recordings through thousands of setting combinations.',
        }),
        boxes.map((b) => b.el),
        h(
          'div',
          { class: 'row', style: { marginTop: '10px' } },
          h('label', {}, 'Protocol per condition: ', length),
          h('label', {}, pursuit, ' moving dot at the end'),
        ),
        est,
        h('button', {
          class: 'primary big',
          text: 'Create the run',
          'data-testid': 'collect-new',
          onclick: () =>
            call(async () => {
              s.summary = null;
              s.run = await api.post('/api/collect/runs/new', {
                sets: boxes.filter((b) => b.box.checked).map((b) => b.box.value),
                length: length.value,
                pursuit: pursuit.checked,
              });
            }),
        }),
        h('p', {
          class: 'muted small',
          text: `Recordings go to ${o.folder}. They contain images of your face.`,
        }),
      );
    }

    function resumeCard() {
      const runs = (s.opts.runs || []).filter((r) => !r.finished || r.pending);
      if (!runs.length) return null;
      return h(
        'section',
        { class: 'card wide' },
        h('h2', { text: 'Resume a run' }),
        h(
          'table',
          {},
          h(
            'tbody',
            {},
            runs.slice(0, 10).map((r) =>
              h(
                'tr',
                {},
                h('td', { text: r.run_id }),
                h('td', { text: `${r.done} of ${r.conditions} recorded, ${r.pending} to go` }),
                h(
                  'td',
                  {},
                  h('button', {
                    text: 'Resume',
                    'data-testid': `collect-resume-${r.run_id}`,
                    onclick: () =>
                      call(async () => {
                        s.summary = null;
                        s.run = await api.post('/api/collect/open', { run_id: r.run_id });
                      }),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    }

    function queueCard() {
      const run = s.run;
      const conds = run.conditions;
      const busy = Boolean(s.prep);
      const rows = conds.map((c, i) => {
        const a = (c.attempts || []).filter((x) => x.outcome === 'completed').slice(-1)[0];
        const q = a && a.quality;
        const notes = h('input', {
          type: 'text',
          value: c.notes || '',
          placeholder: 'distance, lighting, glasses…',
          'data-testid': `q-notes-${i}`,
          onchange: (e) => queue('notes', { index: i, notes: e.target.value }),
        });
        const btn = (text, testid, fn, show = true) =>
          show ? h('button', { text, 'data-testid': testid, disabled: busy, onclick: fn }) : null;
        return h(
          'tr',
          { 'data-testid': `q-row-${i}`, class: i === run.active_index ? 'chosen' : '' },
          h('td', { class: 'num', text: String(i + 1) }),
          h('td', { text: c.label, 'data-testid': `q-label-${i}` }),
          h('td', {}, notes),
          h('td', { text: c.status, class: statusClass(c.status), 'data-testid': `q-status-${i}` }),
          h('td', { class: 'small', text: q ? `eyes ${pct(q.both_eyes_pct)}` : '' }),
          h(
            'td',
            { class: 'row' },
            btn('↑', `q-up-${i}`, () => queue('move', { index: i, to: i - 1 }), i > 0),
            btn(
              '↓',
              `q-down-${i}`,
              () => queue('move', { index: i, to: i + 1 }),
              i < conds.length - 1,
            ),
            btn('Repeat', `q-repeat-${i}`, () => queue('repeat', { index: i })),
            btn('Redo', `q-redo-${i}`, () => queue('redo', { index: i }), c.status !== 'pending'),
            btn('Skip', `q-skip-${i}`, () => queue('skip', { index: i }), c.status === 'pending'),
            btn('Record now', `q-record-${i}`, () => prepare(i), c.status === 'pending'),
            btn('Remove', `q-remove-${i}`, () => queue('remove', { index: i })),
          ),
        );
      });
      const left = conds.filter((c) => c.status === 'pending').length;
      return h(
        'section',
        { class: 'card wide' },
        h('h2', { text: `Run ${run.run_id}` }),
        h('p', {
          'data-testid': 'collect-estimate',
          text: `${left} of ${conds.length} conditions to record: ${minutes(run.estimate_s)} (dots ${minutes(run.protocol_seconds)} per condition, "${run.protocol.length}"${run.protocol.pursuit ? ', with a moving dot' : ''}).`,
        }),
        h(
          'div',
          { class: 'tablewrap' },
          h(
            'table',
            { 'data-testid': 'collect-queue' },
            h(
              'thead',
              {},
              h(
                'tr',
                {},
                ['#', 'Condition', 'Notes', 'Status', 'Quality', ''].map((t) =>
                  h('th', { text: t }),
                ),
              ),
            ),
            h('tbody', {}, rows),
          ),
        ),
        addForm(busy),
        h(
          'div',
          { class: 'row', style: { marginTop: '12px' } },
          h('button', {
            class: 'primary big',
            text: run.next === null ? 'Nothing left to record' : 'Record the next condition',
            disabled: busy || run.next === null,
            'data-testid': 'collect-next',
            onclick: () => prepare(run.next),
          }),
          h('button', {
            class: 'big',
            text: run.next === null ? 'Finish the run' : 'Stop for now (resume later)',
            disabled: busy,
            'data-testid': 'collect-finish',
            onclick: closeRun,
          }),
        ),
      );
    }

    function addForm(busy) {
      const o = s.opts;
      const cam = select(
        'add-camera',
        o.cameras.map((c) => [
          c.kind,
          `${c.label}${c.available === false ? ' (not on this phone)' : ''}`,
        ]),
        'back_wide',
      );
      const zoom = h('input', {
        type: 'number',
        min: 1,
        max: 10,
        step: 0.5,
        value: 2,
        'data-testid': 'add-zoom',
        style: { width: '5em' },
      });
      const fps = select(
        'add-fps',
        [
          [30, '30 fps'],
          [60, '60 fps'],
        ],
        30,
      );
      const shutter = select(
        'add-shutter',
        [
          [0, 'normal shutter'],
          [o.defaults.short_shutter_ms, `short shutter (${o.defaults.short_shutter_ms} ms)`],
        ],
        0,
      );
      const helper = select(
        'add-reflection',
        o.reflection.map((r) => [r, `reflection helper: ${r}`]),
        'off',
      );
      const focus = select(
        'add-focus',
        o.focus.map((f) => [f, `focus: ${f}`]),
        'default',
      );
      const notes = h('input', { type: 'text', placeholder: 'notes', 'data-testid': 'add-notes' });
      return h(
        'details',
        { class: 'collect-add' },
        h('summary', { text: 'Add a condition' }),
        h(
          'div',
          { class: 'row' },
          cam,
          h('label', {}, 'zoom ', zoom),
          fps,
          shutter,
          helper,
          focus,
          notes,
          h('button', {
            text: 'Add',
            disabled: busy,
            'data-testid': 'add-submit',
            onclick: () =>
              queue('add', {
                condition: {
                  camera: cam.value,
                  zoom: Number(zoom.value),
                  fps: Number(fps.value),
                  max_exposure_ms: Number(shutter.value),
                  reflection: helper.value,
                  focus: focus.value,
                  notes: notes.value,
                },
              }),
          }),
        ),
      );
    }

    const readyLine = h('p', { class: 'collect-ready', 'data-testid': 'collect-ready' });
    const refusalLine = h('p', { class: 'bad', 'data-testid': 'collect-refusal' });
    const checks = h('ul', { class: 'collect-checks' });
    const img = h('img', { alt: 'Live camera preview', 'data-testid': 'collect-preview' });
    const goBtn = h('button', {
      class: 'primary big',
      text: 'Start recording this condition',
      'data-testid': 'collect-go',
      onclick: go,
    });

    function renderReady() {
      const r = s.ready;
      readyLine.textContent = r ? r.message : 'Checking…';
      readyLine.className = `collect-ready ${r && r.ready ? 'good' : 'warn'}`;
      const item = (ok, text) =>
        h('li', { class: ok ? 'good' : 'muted', text: `${ok ? '✓' : '…'} ${text}` });
      fill(
        checks,
        item(r && r.camera_ok, 'Camera and zoom set'),
        item(r && r.settled, 'Focus and exposure settled'),
        item(r && r.face, `Face found${r ? ` (${pct(r.face_pct)})` : ''}`),
        item(r && r.eyes, `Both eyes found${r ? ` (${pct(r.both_eyes_pct)})` : ''}`),
      );
      goBtn.classList.toggle('primary', Boolean(r && r.ready));
      refusalLine.textContent = s.refusal;
      if (s.prep && r && r.fresh) img.src = `/api/preview.jpg?overlay=1&t=${Date.now()}`;
    }

    function setupCard() {
      const p = s.prep;
      renderReady();
      return h(
        'section',
        { class: 'card wide collect-setup', 'data-testid': 'collect-setup' },
        h('h2', { text: `Condition ${p.index + 1}: ${p.condition.label}` }),
        h('p', { class: 'muted', text: `Camera: ${p.camera.name || p.camera.id}` }),
        p.prompts.length
          ? h(
              'ul',
              { class: 'hints', 'data-testid': 'collect-prompts' },
              p.prompts.map((t) => h('li', { text: t })),
            )
          : null,
        h(
          'div',
          { class: 'collect-setup-body' },
          h('div', { class: 'preview' }, img),
          h(
            'div',
            {},
            readyLine,
            checks,
            refusalLine,
            goBtn,
            h('p', { class: 'muted small', text: 'The dots then run full screen. Esc pauses.' }),
            h(
              'div',
              { class: 'row' },
              h('button', {
                text: 'Skip this condition',
                'data-testid': 'collect-setup-skip',
                onclick: async () => {
                  stopPolling();
                  const i = s.prep.index;
                  s.prep = null;
                  await queue('skip', { index: i });
                },
              }),
              h('button', {
                text: 'Back to the list',
                onclick: () => {
                  stopPolling();
                  s.prep = null;
                  render();
                },
              }),
            ),
          ),
        ),
      );
    }

    function resultCard() {
      const r = s.result;
      const q = r.quality || {};
      const need = r.poor_below_pct;
      return h(
        'section',
        { class: `card wide ${r.poor ? 'collect-poor' : ''}`, 'data-testid': 'collect-result' },
        h('h2', { text: `Recorded: ${r.condition.label}` }),
        h('p', { 'data-testid': 'collect-result-quality', text: qualityText(q) }),
        r.poor
          ? h('p', {
              class: 'bad',
              'data-testid': 'collect-poor',
              text: `Poor data: both eyes were found in only ${pct(q.both_eyes_pct)} of frames${need ? ` (needs ${need} %)` : ''}. Redo it with more light, nearer, or the head better centred.`,
            })
          : h('p', { class: 'good', text: 'Good data.' }),
        h('p', { class: 'muted small', text: `Saved in ${r.path}` }),
        h(
          'div',
          { class: 'row' },
          r.poor
            ? h('button', {
                class: 'primary',
                text: 'Redo this condition',
                'data-testid': 'collect-result-redo',
                onclick: async () => {
                  await queue('redo', { index: r.index });
                  await prepare(r.index);
                },
              })
            : null,
        ),
      );
    }

    function summaryCard() {
      const sm = s.summary;
      const rows = sm.conditions.map((c, i) =>
        h(
          'tr',
          { 'data-testid': `sum-row-${i}` },
          h('td', { text: c.label }),
          h('td', { text: c.status, class: statusClass(c.status) }),
          h('td', { class: 'num', text: c.quality ? pct(c.quality.face_pct) : '–' }),
          h('td', { class: 'num', text: c.quality ? pct(c.quality.both_eyes_pct) : '–' }),
          h('td', { class: 'num', text: c.quality ? fmt(c.quality.frames_received, 0) : '–' }),
          h('td', {
            class: 'small',
            text: c.status === 'done' || c.status === 'poor' ? c.path || '' : '',
          }),
        ),
      );
      return h(
        'section',
        { class: 'card wide', 'data-testid': 'collect-summary' },
        h('h2', {
          text: sm.finished
            ? `Run ${sm.run_id} finished`
            : `Run ${sm.run_id} stopped (resume it later)`,
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
              ['Condition', 'Status', 'Face', 'Both eyes', 'Frames', 'Recording'].map((t) =>
                h('th', { text: t }),
              ),
            ),
          ),
          h('tbody', {}, rows),
        ),
        h('p', {}, 'The run file: ', h('code', { text: sm.run_file })),
        h('p', {}, 'Analyse it (from the repository root):'),
        h('pre', { class: 'collect-cmd', 'data-testid': 'collect-command', text: sm.command }),
        sm.sweep_page
          ? h(
              'p',
              {},
              h('a', {
                href: sm.sweep_page,
                'data-testid': 'collect-sweep-link',
                text: 'Open the sweep page',
              }),
            )
          : null,
        h('p', { class: 'muted small', text: 'Your settings from before the run are back.' }),
        h('button', {
          text: 'Back',
          onclick: () => {
            s.summary = null;
            load();
          },
        }),
      );
    }

    function render() {
      if (!alive) return;
      if (!s.opts) {
        fill(view, h('p', { class: 'muted', text: 'Loading…' }));
        return;
      }
      const parts = [];
      if (s.recording)
        parts.push(
          h(
            'section',
            { class: 'card wide', 'data-testid': 'collect-recording' },
            h('h2', { text: 'Recording…' }),
          ),
        );
      else if (s.summary) parts.push(summaryCard());
      else if (!s.run) parts.push(newRunCard(), resumeCard());
      else {
        if (s.prep) parts.push(setupCard());
        if (s.result && !s.prep) parts.push(resultCard());
        parts.push(queueCard());
      }
      fill(view, h('div', { class: 'grid' }, parts));
    }

    render();
    load();
    return () => {
      alive = false;
      stopPolling();
    };
  },
};

function statusClass(st) {
  return st === 'done' ? 'good' : st === 'poor' ? 'bad' : st === 'skipped' ? 'muted' : '';
}
