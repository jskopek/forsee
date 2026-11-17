/* global setTimeout, fetch, __dirname, window */
// End to end: collect against the simulator, sweep from the Sweep page, apply the preset.
//
//   node sidecars/phone-gaze/engine/tests/ui/sweep_e2e.cjs
//
// Starts `python -m phonegaze` with HOME in a temporary folder and connects the simulated phone.
// Collects a two-condition run (back wide 2x, front ARKit; short protocol) by driving the Collect
// page's protocol through /api/collect/* exactly as the page does (dot on, wait, dot off; the
// engine forwards each dot to the simulated person). Then, on the Sweep page: the run is offered,
// Start, the progress shows, a reload picks it up again, the leaderboard and the diagnosis
// appear, Apply best preset changes the engine's settings. Real estimators run on the simulator's
// rendered frames (and the truth-reading chains alongside). Fails on any browser console error.
// PG_PYTHON chooses the interpreter; PG_SHOTS=folder saves a screenshot; PG_KEEP=1 keeps HOME.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const ENGINE_DIR = path.resolve(__dirname, '..', '..');

function log(...args) {
  console.log(`[sweep-e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function api(url, body) {
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function startEngine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sweep-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ sim: { port: simPort }, collect: { settle_s: 0.5 } }));
  const py = process.env.PG_PYTHON || path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  const args = ['-m', 'phonegaze', '--no-browser', '--no-cursor', '--no-hotkeys'];
  args.push('--port', String(port), '--config', cfgPath);
  log('starting engine');
  const proc = spawn(py, args, {
    cwd: ENGINE_DIR,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (proc.exitCode !== null) throw new Error(`engine exited ${proc.exitCode}`);
      return (await fetch(`${url}/api/state`)).ok;
    },
    60000,
    'the engine to start',
  );
  return {
    url,
    home,
    output: out,
    stop() {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
      if (!process.env.PG_KEEP) fs.rmSync(home, { recursive: true, force: true });
      else log('kept', home);
    },
  };
}

/** Record one condition the way the Collect page does, without the prompts. */
async function collectCondition(url, index) {
  await api(`${url}/api/collect/prepare`, { index });
  await waitFor(
    async () => (await api(`${url}/api/collect/ready`)).ready,
    90000,
    `condition ${index} to be ready`,
  );
  const ans = await api(`${url}/api/collect/start`, { index });
  const plan = ans.protocol;
  const settle = plan.settle_ms ?? 600;
  const collect = plan.collect_ms ?? 900;
  for (const p of plan.phases) {
    await api(`${url}/api/collect/phase`, { name: p.name });
    if (p.name === 'pursuit') {
      const pts = p.path;
      const step = p.step_ms || 250;
      await api(`${url}/api/collect/pursuit`, { x: pts[0][0], y: pts[0][1] });
      await sleep(settle);
      const t0 = Date.now();
      for (;;) {
        const el = Date.now() - t0;
        const i = Math.floor(el / step);
        if (i >= pts.length - 1) break;
        const f = (el % step) / step;
        await api(`${url}/api/collect/pursuit`, {
          x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f,
          y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f,
        });
        await sleep(100);
      }
      continue;
    }
    for (const d of p.dots) {
      const msg = { phase: p.name, dot_id: d.id, x: d.x, y: d.y, pose_group: d.pose_group };
      await api(`${url}/api/collect/dot`, { ...msg, state: 'on' });
      await sleep(settle + collect);
      await api(`${url}/api/collect/dot`, { ...msg, state: 'off' });
    }
  }
  return api(`${url}/api/collect/finish`, {});
}

async function main() {
  const engine = await startEngine();
  const problems = [];
  const check = (ok, text) => {
    if (!ok) problems.push(text);
  };
  const browser = await chromium.launch();
  let page = null;
  try {
    await api(`${engine.url}/api/phone/connect`, { sim: true });
    await waitFor(
      async () => {
        const st = await api(`${engine.url}/api/state`);
        return st.pipeline && st.pipeline.fps > 1;
      },
      90000,
      'frames from the simulator',
    );

    // 1. Collect: two conditions, short protocol, the moving dot at the end.
    const run = await api(`${engine.url}/api/collect/runs/new`, {
      conditions: [
        { camera: 'back_wide', zoom: 2 },
        { camera: 'front_arkit', zoom: 1 },
      ],
      length: 'short',
      pursuit: true,
    });
    const runId = run.run_id || (run.run && run.run.run_id);
    log('run', runId);
    for (const i of [0, 1]) {
      const res = await collectCondition(engine.url, i);
      log(`condition ${i}:`, res.quality ? JSON.stringify(res.quality).slice(0, 120) : 'done');
    }
    await api(`${engine.url}/api/collect/close`, { restore: true });
    const before = (await api(`${engine.url}/api/config`)).values;

    // 2. The Sweep page: the run is offered; start it with a short budget.
    page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.goto(`${engine.url}/sweep.html`);
    const target = page.getByTestId('sweep-target');
    await waitFor(
      async () => (await target.locator('option').first().getAttribute('value')) === runId,
      15000,
      'the run to be offered first',
    );
    await page.fill('#minutes', '4');
    await page.fill('#combos', '40');
    // a smaller stage 1 than the page's defaults, so the test takes minutes, not an hour
    await page.evaluate(() => {
      const orig = window.fetch;
      window.fetch = (u, o) => {
        if (String(u).endsWith('/api/sweep/start') && o && o.body) {
          const b = JSON.parse(o.body);
          o = {
            ...o,
            body: JSON.stringify({ ...b, max_vision: 3, models: ['auto', 'ridge', 'geometric'] }),
          };
        }
        return orig(u, o);
      };
    });
    await page.getByTestId('sweep-start').click();
    await page.getByTestId('sweep-eta').waitFor({ timeout: 60000 });
    const eta1 = await page.getByTestId('sweep-eta').textContent();
    log('progress:', eta1);

    // 3. A reload picks the running sweep up again.
    await page.reload();
    await page.getByTestId('sweep-current').locator('h3').first().waitFor({ timeout: 15000 });
    const head = await page.getByTestId('sweep-current').locator('h3').first().textContent();
    check(head.includes(runId), `after a reload the page shows "${head}"`);

    // 4. Wait for the end (the budget is 4 minutes plus the reports).
    await page.getByTestId('sweep-best').waitFor({ timeout: 15 * 60000 });
    const best = await page.getByTestId('sweep-best').textContent();
    log('best:', best);
    const summary = await page.getByTestId('sweep-summary').textContent();
    check(
      /BEST OVERALL/.test(summary) && /why:/.test(summary),
      'summary lacks the best or the why',
    );
    const status = await api(`${engine.url}/api/sweep/status?name=${encodeURIComponent(runId)}`);
    check(status.stage === 'done', `stage ${status.stage}`);
    check((status.diagnosis || []).length === 2, 'diagnosis does not cover both conditions');
    log('verdicts:', (status.diagnosis || []).map((d) => d.verdict).join(' | '));

    // 5. Apply best preset.
    await page.getByTestId('sweep-apply').click();
    await page
      .getByTestId('sweep-apply-status')
      .filter({ hasText: 'Applied' })
      .waitFor({ timeout: 15000 });
    log('apply:', await page.getByTestId('sweep-apply-status').textContent());
    const after = (await api(`${engine.url}/api/config`)).values;
    const preset = status.board.preset;
    check(preset && preset.name === 'best from sweep', 'no preset in the leaderboard');
    const prefer = preset && preset.changes['lens.camera_prefer'];
    check(
      prefer && after.lens.camera_prefer === prefer,
      `camera_prefer ${after.lens.camera_prefer}`,
    );
    check(
      JSON.stringify(after) !== JSON.stringify(before),
      'applying the preset changed no setting',
    );
    const presets = await api(`${engine.url}/api/presets`);
    check(
      presets.presets.some((p) => p.name === 'best from sweep' && !p.builtin),
      'the preset is not on the Experiments page',
    );
  } catch (err) {
    problems.push(`error: ${err.stack || err.message}`);
  } finally {
    if (page && process.env.PG_SHOTS) {
      fs.mkdirSync(process.env.PG_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PG_SHOTS, 'sweep.png'), fullPage: true });
    }
    await browser.close();
    if (problems.length) console.log(engine.output.join('').slice(-6000));
    engine.stop();
  }
  if (problems.length) {
    console.log('FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
