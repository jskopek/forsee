/* global setTimeout, fetch, __dirname */
// End-to-end test of the second camera (experimental): simulated phone + the simulator's
// webcam -> engine -> the Second camera page, calibration and validation in headless Chromium.
//
//   node sidecars/phone-gaze/engine/tests/ui/second_camera_e2e.cjs
//
// Starts `python -m phonegaze --sim camera` with second_camera on (screen_pose "prior", the
// webcam-only model), checks the page shows the webcam, the solved phone position and the
// switches, compares the solved phone pose with the simulator's truth, calibrates and validates
// through the real UI, then moves the simulated phone (2 cm, about 4 degrees, with the gyro
// reporting it), checks the page reports the move, and validates with track_phone off and on.
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
const SCREEN = { width: 1512, height: 982 };

function log(...args) {
  console.log(`[second camera ${new Date().toISOString().slice(11, 19)}]`, ...args);
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

async function startEngine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-2cam-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  const cfg = {
    sim: { port: simPort },
    calibration: { settle_ms: 700, collect_ms: 800, pose_rounds: 1 },
    second_camera: { enabled: true, screen_pose: 'prior', webcam_model: true, fps: 10 },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const py = process.env.PG_PYTHON || path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  const args = [
    '-m',
    'phonegaze',
    '--sim',
    'camera',
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

/** Rotation angle (degrees) and translation distance (cm) between two {R, t} poses. */
function poseDiff(a, b) {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a.R[j][i] * b.R[j][i];
  const ang = (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  const dt = Math.hypot(a.t[0] - b.t[0], a.t[1] - b.t[1], a.t[2] - b.t[2]) * 100;
  return { rot_deg: +ang.toFixed(2), t_cm: +dt.toFixed(2) };
}

async function truthPose(simUrl) {
  const r = await fetch(`${simUrl}/sim/webcam.jpg`);
  await r.arrayBuffer();
  return JSON.parse(r.headers.get('x-sim-webcam')).webcamFromPhone;
}

async function runCalibration(page, testId, timeoutMs) {
  await page.goto(page.url().replace(/#.*$/, '#dashboard'));
  await page.getByTestId(testId).click();
  await page.getByTestId('calib').waitFor();
  if (testId === 'calibrate') {
    await page.getByTestId('opt-flash').uncheck();
    await page.getByTestId('opt-moving').uncheck();
    await page.getByTestId('opt-rounds').selectOption('1');
  }
  await page.waitForTimeout(300);
  await page.keyboard.press('Space');
  await page.getByTestId('calib-report').waitFor({ timeout: timeoutMs });
  const headline = await page.getByTestId('report-headline').textContent();
  await page.getByTestId('report-done').click();
  await page.getByTestId('calib').waitFor({ state: 'detached' });
  return headline;
}

function validationTable(state) {
  const out = {};
  for (const [name, m] of Object.entries(state.calibration.validation || {})) {
    out[name] = m && typeof m.accuracy_deg === 'number' ? +m.accuracy_deg.toFixed(2) : null;
  }
  return out;
}

async function main() {
  const engine = await startEngine();
  const browser = await chromium.launch();
  const result = {};
  const problems = [];
  const check = (ok, what) => {
    if (!ok) problems.push(what);
  };
  try {
    const page = await (await browser.newContext({ viewport: SCREEN })).newPage();
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    await page.goto(`${engine.url}/#second-camera`);
    await page.locator('#conn-pill', { hasText: 'Engine: connected' }).waitFor({ timeout: 15000 });
    await page.getByTestId('sc-state').waitFor({ timeout: 30000 });
    const t0 = Date.now();
    await page.getByTestId('sc-state').filter({ hasText: 'Anchored' }).waitFor({ timeout: 120000 });
    result.anchored_after_s = +((Date.now() - t0) / 1000).toFixed(1);
    log('anchored after', result.anchored_after_s, 's');
    await waitFor(
      () => page.getByTestId('sc-preview').evaluate((img) => img.naturalWidth > 0),
      20000,
      'the webcam preview',
    );
    const pos = await page.getByTestId('sc-phone-pos').textContent();
    check(/cm from the top-left corner/.test(pos), `phone position not shown: ${pos}`);
    for (const p of ['enabled', 'screen_pose', 'track_phone', 'hfov_deg', 'wide_head_box']) {
      const n = await page.locator(`[data-path="second_camera.${p}"]`).count();
      check(n === 1, `switch second_camera.${p} not on the page`);
    }
    await sleep(6000);
    let sc = await getJson(`${engine.url}/api/second_camera`);
    result.pose_error = poseDiff(
      await truthPose(engine.simUrl),
      sc.solver.estimate.webcam_from_phone,
    );
    result.self_check = sc.self_check;
    log('phone pose error vs truth:', JSON.stringify(result.pose_error));

    result.calibration = await runCalibration(page, 'calibrate', 240000);
    let st = await getJson(`${engine.url}/api/state`);
    result.models = st.calibration.models;
    check(
      st.calibration.models.includes('geometric_2cam'),
      'geometric_2cam was not fitted: ' +
        JSON.stringify(st.calibration.reports.map((r) => [r.model, r.ok, r.message])),
    );
    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation = validationTable(st);
    log('validation (deg):', JSON.stringify(result.validation));

    // Move the phone; the gyro reports it, the page shows it, the pose is solved again.
    const moves0 = (await getJson(`${engine.url}/api/second_camera`)).solver.moves;
    const before = await truthPose(engine.simUrl);
    await page.goto(`${engine.url}/#second-camera`);
    await postJson(`${engine.simUrl}/sim/phone/move`, {
      translation: [0.02, -0.01, 0.0],
      rotation: [3.0, -2.0, 1.0],
      durationS: 0.6,
    });
    await waitFor(
      async () => (await getJson(`${engine.url}/api/second_camera`)).solver.moves > moves0,
      10000,
      'the move to be detected',
    );
    await page.getByText(/Moves detected: [1-9]/).waitFor({ timeout: 10000 });
    await page.getByTestId('sc-state').filter({ hasText: 'Anchored' }).waitFor({ timeout: 60000 });
    await sleep(6000);
    sc = await getJson(`${engine.url}/api/second_camera`);
    const after = await truthPose(engine.simUrl);
    result.pose_error_after_move = poseDiff(after, sc.solver.estimate.webcam_from_phone);
    result.true_move = poseDiff(before, after);
    log(
      'after the move:',
      JSON.stringify(result.pose_error_after_move),
      'true move',
      JSON.stringify(result.true_move),
    );

    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation_phone_moved = validationTable(st);
    log('phone moved, track_phone off (deg):', JSON.stringify(result.validation_phone_moved));

    await page.goto(`${engine.url}/#second-camera`);
    await page.locator('[data-path="second_camera.track_phone"] input').check();
    await waitFor(
      async () => (await getJson(`${engine.url}/api/config`)).values.second_camera.track_phone,
      5000,
      'track_phone to be on',
    );
    await sleep(1000);
    await runCalibration(page, 'validate', 120000);
    st = await getJson(`${engine.url}/api/state`);
    result.validation_phone_moved_tracked = validationTable(st);
    log(
      'phone moved, track_phone on (deg):',
      JSON.stringify(result.validation_phone_moved_tracked),
    );
    sc = await getJson(`${engine.url}/api/second_camera`);
    check(sc.transform && sc.transform.shift_m > 0.005, 'track_phone is not applying the move');
  } catch (err) {
    problems.push(err.message);
    console.log(engine.output.join('').split('\n').slice(-40).join('\n'));
  } finally {
    await browser.close();
    engine.stop();
  }
  console.log(JSON.stringify(result, null, 2));
  if (process.env.PG_RESULTS)
    fs.writeFileSync(process.env.PG_RESULTS, JSON.stringify(result, null, 2));
  if (!problems.length) {
    // The solve against the truth: MediaPipe's head pose on the synthetic face is biased by a few
    // degrees in each camera, so these bounds are loose; the change of pose (what track_phone
    // uses) must be measured much better.
    check(
      result.pose_error.rot_deg < 14 && result.pose_error.t_cm < 14,
      'phone pose too far from the truth',
    );
    const off = result.validation_phone_moved || {};
    const on = result.validation_phone_moved_tracked || {};
    check(
      typeof on.geometric === 'number' && on.geometric < off.geometric,
      `track_phone did not help the geometric model after the phone moved (${off.geometric} -> ${on.geometric})`,
    );
  }
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
