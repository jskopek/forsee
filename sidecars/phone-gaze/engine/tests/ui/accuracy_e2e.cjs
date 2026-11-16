/* global setTimeout, clearTimeout, fetch, WebSocket, __dirname */
// End-to-end accuracy test: simulated phone -> engine -> calibration driven in headless Chromium
// -> validation, scored against the simulator's true gaze.
//
//   node sidecars/phone-gaze/engine/tests/ui/accuracy_e2e.cjs [arkit] [camera]
//
// For each mode it starts `python -m phonegaze --sim <mode>` with a temporary HOME, runs a full
// grid calibration through the real UI while the simulated person looks at each dot, runs a
// validation, then measures live gaze from ws://.../gaze against the simulator's truth for the
// chosen model and the geometric model. It then moves the simulated head (5 cm sideways, 5 cm
// closer, 8 degrees of yaw) and validates again without recalibrating.
//
// Environment: PG_PYTHON (interpreter, default the engine's .venv), PG_RESULTS (write the numbers
// as JSON to this file), PG_NO_ASSERT=1 (print only).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const ENGINE_DIR = path.resolve(__dirname, '..', '..');
const SCREEN = { width: 1512, height: 982 }; // the simulator's default screen

// Upper bounds in degrees. The measured numbers are in the README; the bounds leave room for
// run-to-run noise on a slower machine without letting a real regression through. The camera
// path's geometric model is NOT robust to head movement after a one-position calibration (its
// eyeball centre comes from MediaPipe's eye corners, which shift by about a millimetre relative
// to the eyeball when the head turns; 1 mm is about 5 degrees), so its bound there is loose and
// the reflection model, which is robust, carries the real check.
const BOUNDS = {
  arkit: [
    ['validation', 'chosen', 1.5],
    ['live_chosen', 'mean_deg', 2.5],
    ['validation_after_head_move', 'geometric', 2.0],
    ['validation_3_poses_new_position', 'geometric', 1.5],
  ],
  camera: [
    ['validation', 'chosen', 1.0],
    ['live_chosen', 'mean_deg', 2.0],
    ['validation_after_head_move', 'reflection', 3.0],
    ['validation_after_head_move', 'geometric', 12.0],
    ['validation_3_poses_new_position', 'reflection', 1.5],
    ['validation_3_poses_new_position', 'geometric', 5.0],
  ],
};

function log(...args) {
  console.log(`[accuracy ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function startEngine(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-acc-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  const cfg = {
    sim: { port: simPort },
    calibration: { settle_ms: 700, collect_ms: 800, pose_rounds: 1 },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const py = process.env.PG_PYTHON || path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  const args = [
    '-m',
    'phonegaze',
    '--sim',
    mode,
    '--no-browser',
    '--no-cursor',
    '--no-hotkeys',
    '--port',
    String(port),
    '--config',
    cfgPath,
  ];
  log('starting engine:', py, args.join(' '));
  const proc = spawn(py, args, {
    cwd: ENGINE_DIR,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
    setTimeout(() => fs.rmSync(home, { recursive: true, force: true }), 3500).unref();
  };
  try {
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Error(`engine exited ${proc.exitCode}`);
        const st = await getJson(`${url}/api/state`);
        return st.phone && st.phone.connected && st.pipeline && st.pipeline.fps > 1;
      },
      90000,
      'the engine and simulator to stream frames',
    );
  } catch (err) {
    stop();
    console.log(out.join(''));
    throw err;
  }
  const state = await getJson(`${url}/api/state`);
  return { url, simUrl: state.phone.url, output: out, stop };
}

async function runCalibration(page, testId, timeoutMs, rounds = 1) {
  await page.getByTestId(testId).click();
  await page.getByTestId('calib').waitFor();
  if (testId === 'calibrate') {
    await page.getByTestId('opt-flash').uncheck();
    await page.getByTestId('opt-moving').uncheck();
    await page.getByTestId('opt-rounds').selectOption(String(rounds));
  }
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  // Each further head position shows a prompt; the engine moves the simulated head itself.
  for (let r = 1; r < rounds; r++) {
    await page.getByTestId('pose-prompt').waitFor({ timeout: timeoutMs });
    await page.keyboard.press('Space');
    await page.getByTestId('pose-prompt').waitFor({ state: 'detached', timeout: 10000 });
  }
  await page.getByTestId('calib-report').waitFor({ timeout: timeoutMs });
  const headline = await page.getByTestId('report-headline').textContent();
  await page.getByTestId('report-done').click();
  await page.getByTestId('calib').waitFor({ state: 'detached' });
  return headline;
}

/** Live gaze from /gaze against the simulator's truth at `n` random points. */
async function liveError(engine, n, seed, scr) {
  const ws = new WebSocket(`${engine.url.replace('http', 'ws')}/gaze`);
  const samples = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'gaze' && m.valid) samples.push({ at: Date.now(), x: m.x, y: m.y });
  };
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('gaze socket did not open')), 5000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
  });
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const errs = [];
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const x = SCREEN.width * (0.1 + 0.8 * rand());
    const y = SCREEN.height * (0.1 + 0.8 * rand());
    await postJson(`${engine.simUrl}/sim/gaze`, { x, y, instant: true });
    await sleep(700);
    const t0 = Date.now();
    await sleep(500);
    const win = samples.filter((p) => p.at >= t0);
    const truth = await getJson(`${engine.simUrl}/sim/truth`);
    if (!win.length) {
      missing++;
      continue;
    }
    const mx = win.reduce((a, p) => a + p.x, 0) / win.length;
    const my = win.reduce((a, p) => a + p.y, 0) / win.length;
    const tx = truth.target ? truth.target[0] : x;
    const ty = truth.target ? truth.target[1] : y;
    const mmPerPt = scr.width_mm && scr.width ? scr.width_mm / scr.width : 0.2;
    const distMm = (truth.distance || 0.6) * 1000;
    const errPt = Math.hypot(mx - tx, my - ty);
    errs.push((Math.atan2(errPt * mmPerPt, distMm) * 180) / Math.PI);
  }
  ws.close();
  errs.sort((a, b) => a - b);
  const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  return {
    mean_deg: mean,
    median_deg: errs.length ? errs[Math.floor(errs.length / 2)] : null,
    n: errs.length,
    missing,
  };
}

function validationTable(state) {
  const out = {};
  for (const [name, m] of Object.entries(state.calibration.validation || {})) {
    out[name] = m && typeof m.accuracy_deg === 'number' ? +m.accuracy_deg.toFixed(2) : null;
  }
  return out;
}

async function runMode(browser, mode) {
  const engine = await startEngine(mode);
  const result = { mode };
  const problems = [];
  try {
    const context = await browser.newContext({ viewport: SCREEN });
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.goto(engine.url);
    await page.locator('#conn-pill', { hasText: 'Engine: connected' }).waitFor({ timeout: 15000 });
    const st0 = await getJson(`${engine.url}/api/state`);
    result.fps = +(st0.pipeline.fps || 0).toFixed(1);
    result.camera = st0.camera && st0.camera.id;
    log(mode, 'streaming at', result.fps, 'fps from', result.camera);

    result.calibration = await runCalibration(page, 'calibrate', 240000);
    let st = await getJson(`${engine.url}/api/state`);
    result.chosen = st.calibration.chosen;
    result.cross_validated = {};
    for (const r of st.calibration.reports || []) {
      if (r.ok) result.cross_validated[r.model] = +(r.loo_error_deg ?? NaN).toFixed(2);
    }
    log(mode, 'calibration:', result.calibration);

    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation = validationTable(st);
    log(mode, 'validation (deg):', JSON.stringify(result.validation));

    result.live_chosen = await liveError(engine, 8, 7, st.screen || {});
    log(mode, `live, ${result.chosen}:`, JSON.stringify(result.live_chosen));
    if (result.validation.geometric !== undefined) {
      await postJson(`${engine.url}/api/model`, { pinned: 'geometric' });
      result.live_geometric = await liveError(engine, 8, 11, st.screen || {});
      log(mode, 'live, geometric:', JSON.stringify(result.live_geometric));
      await postJson(`${engine.url}/api/model`, { pinned: '' });
    }

    // Move the head without recalibrating.
    const scene = await getJson(`${engine.simUrl}/sim/scene`);
    const hp = scene.headPositionWorld;
    await postJson(`${engine.simUrl}/sim/head`, {
      position: [hp[0] + 0.05, hp[1], hp[2] - 0.05],
      rotation: [8, 0, 0],
    });
    await sleep(1500);
    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation_after_head_move = validationTable(st);
    log(mode, 'after head move (deg):', JSON.stringify(result.validation_after_head_move));

    // Calibrate again from three head positions, then validate at a fourth, unseen one.
    await postJson(`${engine.simUrl}/sim/head`, { position: hp, rotation: [0, 0, 0] });
    await sleep(1000);
    result.calibration_3_poses = await runCalibration(page, 'calibrate', 360000, 3);
    st = await getJson(`${engine.url}/api/state`);
    result.chosen_3_poses = st.calibration.chosen;
    log(mode, 'calibration, 3 head positions:', result.calibration_3_poses);
    await postJson(`${engine.simUrl}/sim/head`, {
      position: [hp[0] - 0.03, hp[1] + 0.01, hp[2] + 0.04],
      rotation: [-7, 3, 0],
    });
    await sleep(1500);
    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation_3_poses_new_position = validationTable(st);
    log(
      mode,
      '3 positions, validated at a new one (deg):',
      JSON.stringify(result.validation_3_poses_new_position),
    );
    await context.close();
  } catch (err) {
    problems.push(`${mode}: ${err.message}`);
    console.log(engine.output.join('').split('\n').slice(-40).join('\n'));
  } finally {
    engine.stop();
  }

  if (!problems.length) {
    for (const [section, key, bound] of BOUNDS[mode] || []) {
      const table = result[section] || {};
      const v = key === 'chosen' ? table[result.chosen] : table[key];
      if (!(typeof v === 'number' && v <= bound))
        problems.push(
          `${mode}: ${section}.${key === 'chosen' ? result.chosen : key} = ${v}, bound ${bound}`,
        );
    }
  }
  return { result, problems };
}

async function main() {
  const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['arkit', 'camera'];
  const browser = await chromium.launch();
  const results = [];
  const problems = [];
  try {
    for (const mode of modes) {
      const r = await runMode(browser, mode);
      results.push(r.result);
      problems.push(...r.problems);
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
  if (process.env.PG_RESULTS)
    fs.writeFileSync(process.env.PG_RESULTS, JSON.stringify(results, null, 2));
  if (problems.length && !process.env.PG_NO_ASSERT) {
    console.log('FAILED:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  if (problems.length) for (const p of problems) console.log(`  (not asserted) ${p}`);
  log('PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
