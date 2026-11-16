/* global setTimeout, fetch, __dirname, getComputedStyle */
// End-to-end test of the tuning tools against the real engine and its simulated phone:
//
//   node sidecars/phone-gaze/engine/tests/ui/tuning_e2e.cjs
//
// Starts `python -m phonegaze --sim camera` with HOME in a temporary folder. Drives: the Tuning
// page (eye images with overlays switched on and off, live numbers, freeze frame), a settings
// round trip on the Experiments page (change, applied live to the running estimators, persisted
// to config.json, reset), presets (apply a built-in one, save, export, import, delete), the glint
// assist border, and the fallback pointer. Fails on any browser console error or page error.
// PG_SHOTS=folder saves screenshots.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const ENGINE_DIR = path.resolve(__dirname, '..', '..');

function log(...args) {
  console.log(`[tuning-e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tuning-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ sim: { port: simPort } }));
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
    cfgPath,
    home,
    output: out,
    stop() {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function main() {
  const engine = await startEngine();
  const shots = process.env.PG_SHOTS || null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const problems = [];
  const check = (ok, what) => {
    if (!ok) problems.push(what);
    log(ok ? 'ok  ' : 'FAIL', what);
  };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    const shot = async (name) => {
      if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
    };

    await page.goto(engine.url);
    await page.locator('#conn-pill', { hasText: 'Engine: connected' }).waitFor({ timeout: 15000 });
    await waitFor(
      async () => (await getJson(`${engine.url}/api/state`)).pipeline.processed > 10,
      90000,
      'frames from the simulator',
    );

    // 1. Tuning page: both eyes, overlays, numbers, freeze.
    await page.click('#nav a[href="#tuning"]');
    for (const side of ['left', 'right'])
      await page
        .locator(`[data-testid="tuning-eye-${side}"][data-loaded="1"]`)
        .waitFor({ timeout: 30000 });
    await waitFor(
      async () =>
        (await page.locator('[data-key="left.iris_radius_image_px"]').textContent()) !== '–',
      20000,
      'iris numbers',
    );
    const radius = parseFloat(
      await page.locator('[data-key="left.iris_radius_image_px"]').textContent(),
    );
    check(radius > 10 && radius < 200, `iris radius shown (${radius} px)`);
    const dist = await page.getByTestId('tuning-distance').textContent();
    const src = await page.getByTestId('tuning-distance-source').textContent();
    check(/cm/.test(dist) && src !== '–', `distance and source shown (${dist}, ${src})`);
    const rates = await page.getByTestId('tuning-rate-iris').textContent();
    check(/%/.test(rates), `iris fit rate shown (${rates})`);
    await shot('tuning-01');

    // Overlays: switching the iris fit off changes the image request.
    const srcBefore = await page.getByTestId('tuning-eye-left').getAttribute('src');
    check(/ellipse/.test(srcBefore), 'ellipse layer requested by default');
    await page.getByTestId('layer-ellipse').uncheck();
    await waitFor(
      async () =>
        !/ellipse/.test((await page.getByTestId('tuning-eye-left').getAttribute('src')) || ''),
      10000,
      'image without the ellipse layer',
    );
    check(true, 'ellipse layer switched off');
    await page.getByTestId('layer-ellipse').check();

    // Freeze: the frame number stops changing while frames keep flowing.
    await page.getByTestId('tuning-freeze').click();
    await page.getByTestId('tuning-frozen').filter({ hasText: 'yes' }).waitFor({ timeout: 5000 });
    const f1 = (await getJson(`${engine.url}/api/tuning/stats`)).seq;
    const p1 = (await getJson(`${engine.url}/api/state`)).pipeline.processed;
    await new Promise((r) => setTimeout(r, 1500));
    const f2 = (await getJson(`${engine.url}/api/tuning/stats`)).seq;
    const p2 = (await getJson(`${engine.url}/api/state`)).pipeline.processed;
    check(f1 === f2 && p2 > p1, `freeze holds frame ${f1} while the engine runs (${p1} -> ${p2})`);
    await page.getByTestId('tuning-freeze').click();
    await page.getByTestId('tuning-frozen').filter({ hasText: 'no' }).waitFor({ timeout: 5000 });

    // A quick setting on the Tuning page applies live: circle fit.
    const fitSel = page.getByTestId('setting-estimators.iris_fit');
    await fitSel.selectOption('circle');
    await waitFor(
      async () => {
        const st = await getJson(`${engine.url}/api/tuning/stats`);
        const e = st.eyes.left;
        return e.ellipse_ratio === 1;
      },
      10000,
      'circle fits (minor / major = 1)',
    );
    check(true, 'iris_fit=circle applied live (ellipse ratio 1.0)');
    await fitSel.selectOption('ellipse');

    // 2. Settings round trip on the Experiments page: change, live, persisted, reset.
    await page.click('#nav a[href="#experiments"]');
    const input = page.getByTestId('setting-estimators.reflection_min_confidence');
    await input.waitFor({ timeout: 15000 });
    await input.fill('0.95');
    const resp = page.waitForResponse(
      (r) => r.url().endsWith('/api/config') && r.request().method() === 'POST',
    );
    await input.dispatchEvent('change');
    await resp;
    await waitFor(
      async () => (await getJson(`${engine.url}/api/tuning/stats`)).rates.reflection === 0,
      15000,
      'reflections rejected after raising the threshold',
    );
    check(true, 'reflection_min_confidence=0.95 rejects reflections live');
    const saved = JSON.parse(fs.readFileSync(engine.cfgPath, 'utf8'));
    check(saved.estimators.reflection_min_confidence === 0.95, 'setting persisted to config.json');
    await page
      .locator('.setting[data-path="estimators.reflection_min_confidence"] button', {
        hasText: 'Reset',
      })
      .click();
    await waitFor(
      async () => (await getJson(`${engine.url}/api/tuning/stats`)).rates.reflection > 0.3,
      20000,
      'reflections back after reset',
    );
    const reset = JSON.parse(fs.readFileSync(engine.cfgPath, 'utf8'));
    check(reset.estimators.reflection_min_confidence === 0.3, 'reset persisted');

    // 3. Presets: apply a built-in, save, export, delete, import.
    await page.getByTestId('preset-table').waitFor({ timeout: 10000 });
    await page.getByTestId('preset-apply-steady pointer').click();
    await waitFor(
      async () => (await getJson(`${engine.url}/api/config`)).values.filters.preset === 'steady',
      5000,
      'steady pointer applied',
    );
    check(true, 'built-in preset applied');
    await page.getByTestId('preset-name').fill('my test preset');
    await page.getByTestId('preset-save').click();
    await page.locator('[data-preset="my test preset"]').waitFor({ timeout: 5000 });
    const exported = await getJson(
      `${engine.url}/api/presets/export?name=${encodeURIComponent('my test preset')}`,
    );
    check(exported.changes['filters.preset'] === 'steady', 'export holds the changes');
    await page.locator('[data-preset="my test preset"] button', { hasText: 'Delete' }).click();
    await page.locator('[data-preset="my test preset"]').waitFor({ state: 'detached' });
    const file = path.join(engine.home, 'imported.json');
    fs.writeFileSync(file, JSON.stringify({ ...exported, name: 'imported preset' }));
    await page.getByTestId('preset-import-file').setInputFiles(file);
    await page.locator('[data-preset="imported preset"]').waitFor({ timeout: 5000 });
    check(true, 'preset saved, exported, deleted and imported');
    await page.getByTestId('preset-apply-rear 2x, reflection').click();
    await waitFor(
      async () => (await getJson(`${engine.url}/api/config`)).values.ui.glint_marker === 'border',
      5000,
      'rear 2x, reflection applied',
    );
    const cfgNow = (await getJson(`${engine.url}/api/config`)).values;
    check(
      cfgNow.filters.preset === 'custom' && cfgNow.lens.max_exposure_ms === 16,
      'replace preset reset the filter and set the camera controls',
    );
    await shot('presets');

    // 4. Glint assist border is drawn (the preset turned it on).
    await page.reload();
    await page.locator('#conn-pill', { hasText: 'Engine: connected' }).waitFor({ timeout: 15000 });
    await waitFor(
      async () =>
        (await page
          .getByTestId('glint-layer')
          .evaluate((el) => getComputedStyle(el).borderTopWidth)) === '24px',
      10000,
      'glint border',
    );
    check(true, 'glint border drawn');

    // 5. Fallback pointer: a pointer without calibration.
    await fetch(`${engine.url}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: { 'outputs.fallback_pointer': 'uncalibrated' } }),
    });
    await waitFor(
      async () => {
        const st = await getJson(`${engine.url}/api/tuning/stats`);
        return st.fallback.mode === 'uncalibrated' && st.fallback.source;
      },
      10000,
      'fallback pointer running',
    );
    check(true, 'fallback pointer produces input without calibration');
  } finally {
    await browser.close();
    engine.stop();
  }
  if (problems.length) {
    console.log(engine.output.join('').slice(-4000));
    console.error(`FAILED:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  log('all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
