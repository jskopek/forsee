/* global setTimeout, fetch, __dirname */
// End-to-end test of the guided collection run (Collect page, phonegaze/collect.py) against the
// real engine and its simulated phone.
//
//   node sidecars/phone-gaze/engine/tests/ui/collect_e2e.cjs
//
// Starts `python -m phonegaze` with HOME pointed at a temporary folder (recordings go there),
// connects the simulator, and through the page: creates a run from the "quick comparison" set,
// removes one condition, reorders, adds one; checks that a condition refuses to start while no
// face is found; records two conditions with the short protocol (the simulated person looks at
// every dot: the engine forwards each dot to the simulator); pauses with Esc and continues; redoes
// a condition; skips one; finishes the run. Then it reads the files: the run file, each
// condition's collect.json, and the raw stream, and checks that frames fall inside every dot's
// interval (same clock), that validation dots differ from calibration dots, and that pause, redo
// and skip left the right traces. PG_PYTHON chooses the interpreter (default: the engine's .venv).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const ENGINE_DIR = path.resolve(__dirname, '..', '..');
const SCREEN = { width: 1512, height: 982 }; // the simulator's default screen

function log(...args) {
  console.log(`[collect-e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-collect-home-'));
  const port = await freePort();
  const simPort = await freePort();
  fs.mkdirSync(path.join(home, '.phonegaze'), { recursive: true });
  const cfgPath = path.join(home, '.phonegaze', 'config.json');
  // Shorter dots than the defaults so the test is quick; the protocol is otherwise unchanged.
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      sim: { port: simPort },
      calibration: { settle_ms: 300, collect_ms: 400 },
      collect: { settle_s: 0.5 },
    }),
  );
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
    home,
    simUrl: `http://127.0.0.1:${simPort}`,
    output: out,
    stop() {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

/** Receive times (engine clock) of every frame in a recording's raw stream (PGZ1 framing). */
function frameTimes(file) {
  const buf = fs.readFileSync(file);
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    if (buf.toString('ascii', off, off + 4) !== 'PGZ1') throw new Error(`bad magic at ${off}`);
    const n = buf.readUInt32BE(off + 4);
    const header = JSON.parse(buf.toString('utf8', off + 8, off + 8 + n));
    off += 8 + n;
    for (const p of header.parts || []) off += p.bytes;
    if (header.type === 'frame') out.push(header.recv);
  }
  return out;
}

/** Click Continue on every prompt until the condition's result (or `until`) shows. */
async function driveProtocol(page, until = 'collect-result', timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.getByTestId(until).isVisible()) return;
    const cont = page.getByTestId('collect-continue');
    if (await cont.isVisible()) await cont.click().catch(() => {});
    await page.waitForTimeout(150);
  }
  throw new Error(`the protocol did not reach ${until}`);
}

async function waitReady(page) {
  await page.getByTestId('collect-ready').filter({ hasText: 'Ready' }).waitFor({ timeout: 60000 });
}

async function startCondition(page) {
  await page.getByTestId('collect-overlay').waitFor({ state: 'detached', timeout: 10000 });
  await page.getByTestId('collect-setup').waitFor({ timeout: 30000 });
  await waitReady(page);
  await page.getByTestId('collect-go').click();
  await page.getByTestId('collect-overlay').waitFor({ timeout: 10000 });
}

async function pauseDuringCalibration(page) {
  await page.getByTestId('collect-continue').click();
  await page.waitForTimeout(1600); // two dots or so
  await page.keyboard.press('Escape');
  await page.getByTestId('collect-paused').waitFor({ timeout: 5000 });
}

async function main() {
  const engine = await startEngine();
  const problems = [];
  const check = (ok, text) => {
    if (!ok) problems.push(text);
  };
  const summary = {};
  const browser = await chromium.launch();
  let page = null;
  try {
    await post(`${engine.url}/api/phone/connect`, { sim: true });
    await waitFor(
      async () => {
        const st = await (await fetch(`${engine.url}/api/state`)).json();
        return st.pipeline && st.pipeline.fps > 1;
      },
      90000,
      'frames from the simulator',
    );
    const context = await browser.newContext({ viewport: SCREEN });
    page = await context.newPage();
    page.on('console', (m) => {
      // A refused start (409) and a preview before the first frame (503) are expected answers.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        problems.push(`console: ${m.text()}`);
    });
    if (process.env.PG_DEBUG)
      page.on('response', (r) => {
        if (r.url().includes('/api/collect/') && !r.url().includes('/ready'))
          log('http', r.request().method(), r.url().replace(engine.url, ''), r.status());
      });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

    // 1. The dashboard is simple by default and links here.
    await page.goto(engine.url);
    await page.getByTestId('simple').waitFor({ timeout: 15000 });
    check(await page.getByTestId('simple-best').isVisible(), 'no Apply best preset button');
    check(!(await page.getByTestId('refine').isVisible()), 'Advanced is open by default');
    await page.getByTestId('simple-best').click();
    await page
      .getByTestId('simple-message')
      .filter({ hasText: 'best from sweep' })
      .waitFor({ timeout: 5000 });
    await page.getByTestId('simple-collect').click();

    // 2. A run from the quick set: remove back wide 1x, put back wide 2x first, add ultra wide.
    await page.getByTestId('collect-new').waitFor({ timeout: 15000 });
    await page.getByTestId('set-quick').check();
    await page.getByTestId('collect-length').selectOption('short');
    await page.getByTestId('collect-new').click();
    const rows = page.locator('[data-testid="collect-queue"] tbody tr');
    await waitFor(async () => (await rows.count()) === 3, 10000, 'three conditions');
    await page.getByTestId('q-remove-1').click();
    await waitFor(async () => (await rows.count()) === 2, 10000, 'two conditions');
    await page.getByTestId('q-up-1').click();
    await waitFor(
      async () => (await page.getByTestId('q-label-0').textContent()) === 'back wide 2x',
      10000,
      'back wide 2x first',
    );
    check(
      (await page.getByTestId('q-label-1').textContent()) === 'front ARKit',
      'front ARKit is not second',
    );
    await page.locator('.collect-add summary').click();
    await page.getByTestId('add-camera').selectOption('back_ultrawide');
    await page.getByTestId('add-zoom').fill('1');
    await page.getByTestId('add-submit').click();
    await waitFor(async () => (await rows.count()) === 3, 10000, 'the added condition');
    summary.estimate = await page.getByTestId('collect-estimate').textContent();
    log('queue ready:', summary.estimate);

    // 3. Condition 1 (back wide 2x): refuses to start without a face, then records; Esc + continue.
    await page.getByTestId('collect-next').click();
    await page.getByTestId('collect-setup').waitFor({ timeout: 30000 });
    await waitReady(page);
    const scene = await (await fetch(`${engine.simUrl}/sim/scene`)).json();
    const base = scene.headPositionWorld;
    await post(`${engine.simUrl}/sim/head`, { position: [base[0] + 0.5, base[1], base[2]] });
    await page
      .getByTestId('collect-ready')
      .filter({ hasText: 'No face' })
      .waitFor({ timeout: 30000 });
    await page.getByTestId('collect-go').click();
    await page
      .getByTestId('collect-refusal')
      .filter({ hasText: 'no face' })
      .waitFor({ timeout: 10000 });
    summary.refusal = await page.getByTestId('collect-refusal').textContent();
    check(!(await page.getByTestId('collect-overlay').count()), 'started without a face');
    log('refused without a face:', summary.refusal);
    await post(`${engine.simUrl}/sim/head`, { position: base, rotation: [0, 0, 0] });
    await startCondition(page);
    await pauseDuringCalibration(page);
    await page.getByTestId('collect-resume').click();
    await page.waitForTimeout(1200);
    summary.liveQuality = await page.getByTestId('collect-live-quality').textContent();
    check(/both eyes found/.test(summary.liveQuality || ''), 'no live quality line');
    await driveProtocol(page);
    summary.result1 = await page.getByTestId('collect-result-quality').textContent();
    log('condition 1:', summary.result1);

    // 4. Condition 2 (front ARKit): Esc, redo, then record.
    await page.getByTestId('collect-next').click();
    await startCondition(page);
    await pauseDuringCalibration(page);
    await page.getByTestId('collect-redo').click();
    await startCondition(page);
    await driveProtocol(page);
    summary.result2 = await page.getByTestId('collect-result-quality').textContent();
    log('condition 2 (after a redo):', summary.result2);

    // 5. Condition 3 (ultra wide): Esc, skip.
    await page.getByTestId('collect-next').click();
    await startCondition(page);
    await pauseDuringCalibration(page);
    await page.getByTestId('collect-skip').click();
    await page.getByTestId('q-status-2').filter({ hasText: 'skipped' }).waitFor({ timeout: 10000 });

    // 6. Finish: summary table and command.
    await page.getByTestId('collect-finish').click();
    await page.getByTestId('collect-summary').waitFor({ timeout: 15000 });
    summary.command = await page.getByTestId('collect-command').textContent();
    check(/run\.sh sweep \S+/.test(summary.command), 'no sweep command');
    check(
      (await page.locator('[data-testid^="sum-row-"]').count()) === 3,
      'summary does not list three conditions',
    );
    const cfg = await (await fetch(`${engine.url}/api/config`)).json();
    check(cfg.values.lens.auto_zoom === true, 'settings were not restored (lens.auto_zoom)');
    const st = await (await fetch(`${engine.url}/api/state`)).json();
    check(st.paused === false, 'the engine is still paused after the run');

    // 7. The files.
    const recRoot = path.join(engine.home, '.phonegaze', 'recordings');
    const runFiles = fs.readdirSync(path.join(recRoot, 'collect-runs'));
    check(runFiles.length === 1, `expected one run file, found ${runFiles.length}`);
    const run = JSON.parse(fs.readFileSync(path.join(recRoot, 'collect-runs', runFiles[0])));
    check(run.format === 'phonegaze-collect-run-1', 'run file format');
    check(
      JSON.stringify(run.conditions.map((c) => c.status)) ===
        JSON.stringify(['done', 'done', 'skipped']),
      `statuses ${run.conditions.map((c) => c.status)}`,
    );
    check(
      JSON.stringify(run.recordings.map((r) => r.label)) ===
        JSON.stringify(['back wide 2x', 'front ARKit']),
      `recordings in order: ${run.recordings.map((r) => r.label)}`,
    );
    const redo = run.conditions[1].attempts;
    check(
      redo.length === 2 && redo[0].outcome === 'aborted (redo)' && redo[1].outcome === 'completed',
      `redo attempts: ${JSON.stringify(redo.map((a) => a.outcome))}`,
    );
    check(
      run.conditions[2].attempts.length === 1 &&
        run.conditions[2].attempts[0].outcome === 'aborted (skip)',
      'skip attempt',
    );
    const aborted = JSON.parse(fs.readFileSync(path.join(redo[0].path, 'collect.json')));
    check(aborted.completed === false, 'the aborted attempt says completed');
    summary.manifests = [];
    for (const rec of run.recordings) {
      const m = JSON.parse(fs.readFileSync(path.join(rec.path, 'collect.json')));
      const keys = Object.keys(m).sort().join(',');
      check(
        keys === 'completed,condition,format,phases,run_id,screen,started',
        `manifest keys ${keys}`,
      );
      check(
        m.format === 'phonegaze-collect-1' && m.completed === true,
        'manifest format/completed',
      );
      check(m.run_id === run.run_id, 'manifest run_id');
      check(
        Object.keys(m.condition).sort().join(',') ===
          'camera_id,camera_label,id,label,notes,settings,zoom',
        `condition keys ${Object.keys(m.condition)}`,
      );
      check(m.screen.width_pt === SCREEN.width && m.screen.height_pt === SCREEN.height, 'screen');
      const names = m.phases.map((p) => p.name).join(',');
      check(names === 'calibration,poses,validation,pursuit', `phases ${names}`);
      const byName = Object.fromEntries(m.phases.map((p) => [p.name, p]));
      const cal = byName.calibration.dots;
      const val = byName.validation.dots;
      check(cal.length === 9, `calibration dots ${cal.length}`);
      check(val.length === 6, `validation dots ${val.length}`);
      check(new Set(cal.map((d) => d.id)).size === cal.length, 'calibration dot ids repeat');
      const groups = [...new Set(byName.poses.dots.map((d) => d.pose_group))];
      check(groups.length === 3, `pose groups ${groups}`);
      const near = val.filter((v) => cal.some((c) => Math.hypot(c.x - v.x, c.y - v.y) < 40));
      check(near.length === 0, 'a validation dot sits on a calibration dot');
      const times = frameTimes(path.join(rec.path, 'stream.pgz1'));
      let minFrames = Infinity;
      for (const p of m.phases) {
        for (const d of p.dots) {
          check(d.t_off > d.t_on, `dot ${d.id} interval`);
          const n = times.filter((t) => t >= d.t_on && t <= d.t_off).length;
          minFrames = Math.min(minFrames, n);
          check(n >= 1, `no frame inside dot ${d.id} (${p.name}) of ${rec.label}`);
        }
      }
      const samples = byName.pursuit.samples;
      check(samples.length >= 20, `pursuit samples ${samples.length}`);
      check(
        samples.every((s) => s[0] >= times[0] && s[0] <= times[times.length - 1]),
        'pursuit samples outside the recording',
      );
      const events = fs
        .readFileSync(path.join(rec.path, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const restarts = events.filter((e) => e.type === 'collect.phase' && e.restart).length;
      if (rec.label === 'back wide 2x')
        check(restarts === 1, `pause then continue: ${restarts} phase restarts`);
      summary.manifests.push({
        label: rec.label,
        camera: m.condition.camera_id,
        zoom: m.condition.zoom,
        frames: times.length,
        min_frames_per_dot: minFrames,
        quality: rec.quality,
      });
    }
    check(
      summary.manifests[1] && summary.manifests[1].camera === 'arkit-face',
      'second recording is not the ARKit camera',
    );
  } catch (err) {
    problems.push(`step failed: ${err.message}`);
    if (page && process.env.PG_SHOTS) {
      fs.mkdirSync(process.env.PG_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PG_SHOTS, 'collect-failure.png') });
      const text = await page.locator('#view').innerText();
      fs.writeFileSync(path.join(process.env.PG_SHOTS, 'collect-failure.txt'), text);
    }
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
