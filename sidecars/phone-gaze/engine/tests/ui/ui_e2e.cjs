/* global setTimeout, fetch, __dirname */
// End-to-end test of the browser UI against the real engine and its simulated phone.
//
//   node sidecars/phone-gaze/engine/tests/ui/ui_e2e.cjs
//
// Starts `python -m phonegaze` (no --sim; the test connects to the simulator through the UI) with
// HOME pointed at a temporary folder, so nothing touches the real ~/.phonegaze. Set PG_URL to test
// an engine that is already running instead, PG_SHOTS to a folder to save screenshots, and
// PG_PYTHON to choose the interpreter (default: the engine's .venv).
//
// Drives: load, connect to the simulator, aiming previews, change settings, a full calibration
// (coded flash, moving dot, two head positions), validation, quick refine, live view, a short
// recording, and fails on any browser console error or page error.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const ENGINE_DIR = path.resolve(__dirname, '..', '..');
const SCREEN = { width: 1512, height: 982 }; // the simulator's default screen

function log(...args) {
  console.log(`[ui-e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function startEngine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ui-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ sim: { port: simPort } }));
  const py = process.env.PG_PYTHON || path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  const args = [
    '-m',
    'phonegaze',
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
  try {
    await waitFor(
      async () => {
        if (proc.exitCode !== null) throw new Error(`engine exited ${proc.exitCode}`);
        const r = await fetch(`${url}/api/state`);
        return r.ok;
      },
      60000,
      'the engine to start',
    );
  } catch (err) {
    proc.kill('SIGKILL');
    console.log(out.join(''));
    throw err;
  }
  return {
    url,
    output: out,
    stop() {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function setSetting(page, settingPath, value) {
  const input = page.getByTestId(`setting-${settingPath}`);
  await input.fill(String(value));
  const resp = page.waitForResponse(
    (r) => r.url().endsWith('/api/config') && r.request().method() === 'POST',
  );
  await input.dispatchEvent('change');
  const body = await (await resp).json();
  if (body.errors && body.errors[settingPath])
    throw new Error(`${settingPath}: ${body.errors[settingPath]}`);
  return body;
}

async function runCalibrationReport(page, timeoutMs) {
  const report = page.getByTestId('calib-report');
  await report.waitFor({ timeout: timeoutMs });
  const headline = await page.getByTestId('report-headline').textContent();
  const rows = await page.locator('[data-testid="model-table"] tbody tr').count();
  const heat = await page.getByTestId('heatmap').count();
  return { headline, rows, heat };
}

async function main() {
  const engine = process.env.PG_URL
    ? { url: process.env.PG_URL, stop() {}, output: [] }
    : await startEngine();
  const shots = process.env.PG_SHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const problems = [];
  const summary = {};
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: SCREEN,
      colorScheme: process.env.PG_DARK ? 'dark' : 'light',
    });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    const shot = async (name) => {
      if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    };

    // 1. Load and connect.
    await page.goto(engine.url);
    await page.locator('#conn-pill', { hasText: 'Engine: connected' }).waitFor({ timeout: 15000 });
    log('page loaded, WebSocket connected');
    await page.getByTestId('connect-sim').click();
    await page
      .getByTestId('phone-state')
      .filter({ hasText: 'Simulator connected' })
      .waitFor({ timeout: 60000 });
    await waitFor(
      async () => parseFloat((await page.getByTestId('stat-fps').textContent()) || '0') > 1,
      60000,
      'frames from the simulator',
    );
    summary.fps = await page.getByTestId('stat-fps').textContent();
    log('connected to the simulator at', summary.fps);
    await shot('01-dashboard');

    // 2. Aiming view shows the previews.
    await page.click('#nav a[href="#aim"]');
    await page.locator('[data-testid="preview-wide"][data-loaded="1"]').waitFor({ timeout: 30000 });
    await waitFor(
      async () => (await page.locator('[data-testid="crops"] img[data-loaded="1"]').count()) >= 1,
      30000,
      'eye crops',
    );
    summary.iris = await page.getByTestId('iris-px').textContent();
    summary.hints = await page.getByTestId('hints').textContent();
    log('aim view: iris', summary.iris, '| hints:', summary.hints);
    await shot('02-aim');

    // 3. Change settings live (shorter dots so the test is quick; two head positions).
    await page.click('#nav a[href="#experiments"]');
    await page.getByTestId('setting-calibration.settle_ms').waitFor({ timeout: 15000 });
    await setSetting(page, 'calibration.settle_ms', 350);
    await setSetting(page, 'calibration.collect_ms', 500);
    const changed = await page
      .locator('.setting.changed[data-path="calibration.settle_ms"]')
      .count();
    if (changed !== 1) problems.push('changed setting is not marked as changed');
    const state = await (await fetch(`${engine.url}/api/config`)).json();
    if (state.values.calibration.settle_ms !== 350)
      problems.push(`settle_ms not applied: ${state.values.calibration.settle_ms}`);
    await page.getByTestId('preset-name').fill('fast dots');
    await page.getByTestId('preset-save').click();
    log('settings changed and saved as a preset');
    await shot('03-experiments');

    // 4. Full calibration: flash, moving dot, two head positions.
    await page.click('#nav a[href="#dashboard"]');
    await page.getByTestId('calibrate').click();
    await page.getByTestId('calib').waitFor();
    await page.getByTestId('opt-flash').check();
    await page.getByTestId('opt-moving').check();
    await page.getByTestId('opt-rounds').selectOption('2');
    await page.waitForTimeout(300);
    await page.keyboard.press('Space');
    await page.getByTestId('pose-prompt').waitFor({ timeout: 90000 });
    await shot('04-pose-prompt');
    await page.keyboard.press('Space');
    const full = await runCalibrationReport(page, 120000);
    summary.calibration = full;
    log('calibration report:', full.headline, `(${full.rows} models)`);
    if (!full.rows) problems.push('calibration report has no models');
    if (!full.heat) problems.push('calibration report has no heat map');
    await shot('05-calibration-report');
    if (shots)
      await page
        .getByTestId('heatmap')
        .screenshot({ path: path.join(shots, '05-calibration-report-heatmap.png') });
    await page.getByTestId('report-done').click();
    await page.getByTestId('calib').waitFor({ state: 'detached' });

    // 5. Validation.
    await page.getByTestId('validate').click();
    await page.getByTestId('calib-go').waitFor();
    await page.keyboard.press('Space');
    const val = await runCalibrationReport(page, 60000);
    summary.validation = val;
    summary.regionTable = await page.getByTestId('region-table').count();
    log('validation report:', val.headline);
    if (!val.rows) problems.push('validation report has no models');
    await shot('06-validation-report');
    if (shots)
      await page
        .getByTestId('heatmap')
        .screenshot({ path: path.join(shots, '06-validation-report-heatmap.png') });
    await page.getByTestId('report-done').click();
    await page.getByTestId('calib').waitFor({ state: 'detached' });

    // 6. Quick refine.
    await page.getByTestId('refine').click();
    await page.getByTestId('calib-go').click();
    const ref = await runCalibrationReport(page, 60000);
    summary.refine = ref.headline;
    await page.getByTestId('report-done').click();
    await page.getByTestId('calib').waitFor({ state: 'detached' });

    // 7. Esc cancels a calibration.
    await page.getByTestId('calibrate').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.getByTestId('calib').waitFor({ state: 'detached', timeout: 5000 });
    log('escape cancelled a calibration');

    // The dashboard shows the models with both errors.
    const modelRows = await page.locator('[data-testid="models-table"] tbody tr').count();
    summary.dashboardModels = modelRows;
    if (!modelRows) problems.push('dashboard shows no models after calibration');
    await shot('07-dashboard-after');

    // 8. Live view receives gaze.
    await page.click('#nav a[href="#live"]');
    await waitFor(
      async () => /Rate: [1-9]/.test((await page.getByTestId('live-info').textContent()) || ''),
      15000,
      'gaze samples in the live view',
    );
    summary.live = await page.getByTestId('live-info').textContent();
    log('live view:', summary.live);
    await shot('08-live');

    // 8b. Drift correction from selections: a look-point through the API (a target the size of
    // the screen, so it is never an outlier) shows up in the experiments card's side-by-side
    // numbers; the card's switch changes the setting.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${engine.url}/api/lookpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: SCREEN.width / 2,
          y: SCREEN.height / 2,
          id: `e2e-${i}`,
          rect: { x: 0, y: 0, width: SCREEN.width, height: SCREEN.height },
        }),
      });
      if (!res.ok) problems.push(`lookpoint answered ${res.status}`);
      await page.waitForTimeout(700);
    }
    await page.click('#nav a[href="#experiments"]');
    await page.getByTestId('drift-card').waitFor({ timeout: 10000 });
    await waitFor(
      async () =>
        /This session\s*[1-9]/.test((await page.getByTestId('drift-stats').textContent()) || ''),
      10000,
      'drift numbers in the experiments card',
    );
    summary.drift = (await page.getByTestId('drift-stats').textContent()).replace(/\s+/g, ' ');
    await page.getByTestId('drift-toggle').check();
    await waitFor(
      async () =>
        (await (await fetch(`${engine.url}/api/config`)).json()).values.calibration
          .drift_correction === true,
      5000,
      'drift correction switched on from the card',
    );
    await page.getByTestId('drift-toggle').uncheck();
    log('drift card:', summary.drift);
    await shot('08b-drift');

    // 9. Recording.
    await page.click('#nav a[href="#recordings"]');
    await page.getByTestId('rec-label').fill('ui test');
    await page.getByTestId('rec-start').click();
    await page
      .getByTestId('rec-status')
      .filter({ hasText: 'Recording' })
      .waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.getByTestId('rec-stop').click();
    await waitFor(
      async () => (await page.locator('[data-testid="rec-list"] tbody tr').count()) >= 1,
      15000,
      'the recording in the list',
    );
    log('recording listed');
    await shot('09-recordings');
  } catch (err) {
    problems.push(`step failed: ${err.message}`);
  } finally {
    await browser.close();
    engine.stop();
  }
  console.log(JSON.stringify(summary, null, 2));
  if (problems.length) {
    console.log('FAILED:');
    for (const p of problems) console.log(`  - ${p}`);
    if (engine.output.length) console.log(engine.output.join('').split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  log('PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
