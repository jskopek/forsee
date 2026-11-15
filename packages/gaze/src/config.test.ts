import { SettingsRegistry, isForseeError, validateSettingFields } from '@forsee/core';
import { DWELL_CLASSES } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DWELL_CONFIG,
  DEFAULT_GAZE_ENGINE_CONFIG,
  DEFAULT_HIT_TEST_CONFIG,
  GAZE_SETTINGS_NAMESPACE,
  GAZE_SETTING_FIELDS,
  adjustDwell,
  assertDwellConfig,
  dwellConfigToSettings,
  gazeConfigFromSettings,
  likelihoodFactor,
  resolveGazeEngineConfig,
  validateDwellConfig,
  validateGazeEngineConfig,
  validateHitTestConfig,
} from './config';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('defaults', () => {
  it('are valid and JSON round-trip', () => {
    expect(validateDwellConfig(clone(DEFAULT_DWELL_CONFIG))).toEqual({
      ok: true,
      value: DEFAULT_DWELL_CONFIG,
    });
    expect(validateGazeEngineConfig(clone(DEFAULT_GAZE_ENGINE_CONFIG))).toEqual({
      ok: true,
      value: DEFAULT_GAZE_ENGINE_CONFIG,
    });
    expect(validateHitTestConfig(clone(DEFAULT_HIT_TEST_CONFIG)).ok).toBe(true);
  });

  it('make destructive keys the slowest class', () => {
    const { classMs } = DEFAULT_DWELL_CONFIG;
    for (const cls of DWELL_CLASSES)
      expect(classMs.destructive).toBeGreaterThanOrEqual(classMs[cls]);
    expect(DEFAULT_DWELL_CONFIG.wakeMs).toBeGreaterThan(classMs.destructive);
  });
});

describe('validateDwellConfig', () => {
  it('reports every problem with a path', () => {
    const result = validateDwellConfig({
      classMs: { letter: 'fast', prediction: 900, function: 50, destructive: 1500 },
      decayPerSecond: -1,
      adaptive: { enabled: 'yes', minFactor: 0, maxFactor: 10 },
      repeatIntervalMs: 1200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path).sort()).toEqual(
      [
        '/adaptive/enabled',
        '/adaptive/maxFactor',
        '/adaptive/minFactor',
        '/classMs/function',
        '/classMs/letter',
        '/decayPerSecond',
        '/wakeMs',
      ].sort(),
    );
  });

  it('rejects non-objects', () => {
    expect(validateDwellConfig(null).ok).toBe(false);
    expect(validateDwellConfig([]).ok).toBe(false);
  });

  it('assertDwellConfig throws invalid-argument with details', () => {
    try {
      assertDwellConfig({});
      expect.unreachable();
    } catch (error) {
      expect(isForseeError(error, 'invalid-argument')).toBe(true);
    }
  });
});

describe('resolveGazeEngineConfig', () => {
  it('merges a deep patch over the defaults', () => {
    const config = resolveGazeEngineConfig({
      filter: { oneEuro: { beta: 0.02 } },
      tickIntervalMs: 0,
    });
    expect(config.filter.oneEuro).toEqual({
      ...DEFAULT_GAZE_ENGINE_CONFIG.filter.oneEuro,
      beta: 0.02,
    });
    expect(config.filter.kind).toBe('one-euro');
    expect(config.tickIntervalMs).toBe(0);
    expect(config.fixation).toEqual(DEFAULT_GAZE_ENGINE_CONFIG.fixation);
  });

  it('rejects invalid values', () => {
    expect(() => resolveGazeEngineConfig({ filter: { kind: 'kalman' as 'none' } })).toThrow();
    expect(() => resolveGazeEngineConfig({ selection: { neutralLikelihood: 0 } })).toThrow();
  });
});

describe('likelihoodFactor', () => {
  const adaptive = DEFAULT_DWELL_CONFIG.adaptive;

  it('is 1 with no opinion, at the neutral likelihood, or when disabled', () => {
    expect(likelihoodFactor(undefined, adaptive)).toBe(1);
    expect(likelihoodFactor(0.05, adaptive)).toBeCloseTo(1, 12);
    expect(likelihoodFactor(0.9, { ...adaptive, enabled: false })).toBe(1);
  });

  it('decreases monotonically with likelihood, within the bounds', () => {
    let previous = Infinity;
    for (let l = 0; l <= 1.0001; l += 0.01) {
      const f = likelihoodFactor(l, adaptive);
      expect(f).toBeLessThanOrEqual(previous);
      expect(f).toBeGreaterThanOrEqual(adaptive.minFactor);
      expect(f).toBeLessThanOrEqual(adaptive.maxFactor);
      previous = f;
    }
    expect(likelihoodFactor(1, adaptive)).toBe(adaptive.minFactor);
    expect(likelihoodFactor(0, adaptive)).toBe(adaptive.maxFactor);
  });
});

describe('adjustDwell', () => {
  it('steps every class faster or slower and reports the new values', () => {
    const faster = adjustDwell(DEFAULT_DWELL_CONFIG, { direction: 'faster' });
    expect(faster.changed).toEqual({
      letter: 700,
      prediction: 800,
      function: 900,
      destructive: 1400,
    });
    expect(faster.config.classMs).toEqual(faster.changed);
    expect(faster.atLimit).toBe(false);
    expect(DEFAULT_DWELL_CONFIG.classMs.letter).toBe(800);
    const slower = adjustDwell(faster.config, { direction: 'slower' });
    expect(slower.config.classMs).toEqual(DEFAULT_DWELL_CONFIG.classMs);
  });

  it('can target one class with a custom step', () => {
    const result = adjustDwell(DEFAULT_DWELL_CONFIG, {
      direction: 'slower',
      classes: ['letter'],
      stepMs: 50,
    });
    expect(result.changed).toEqual({ letter: 850 });
    expect(result.config.classMs.prediction).toBe(900);
  });

  it('stays within bounds and says so', () => {
    let config = DEFAULT_DWELL_CONFIG;
    for (let i = 0; i < 20; i++)
      config = adjustDwell(config, { direction: 'faster', classes: ['letter'] }).config;
    expect(config.classMs.letter).toBe(200);
    const atMin = adjustDwell(config, { direction: 'faster', classes: ['letter'] });
    expect(atMin.atLimit).toBe(true);
    expect(atMin.changed.letter).toBe(200);
    const atMax = adjustDwell(DEFAULT_DWELL_CONFIG, {
      direction: 'slower',
      classes: ['destructive'],
      maxMs: 1550,
    });
    expect(atMax).toMatchObject({ changed: { destructive: 1550 }, atLimit: true });
    expect(validateDwellConfig(config).ok).toBe(true);
  });

  it('rejects nonsensical steps', () => {
    expect(() => adjustDwell(DEFAULT_DWELL_CONFIG, { direction: 'faster', stepMs: 0 })).toThrow();
  });
});

describe('settings', () => {
  it('the app.gaze schema is valid for the core settings registry', () => {
    expect(validateSettingFields(GAZE_SETTING_FIELDS)).toEqual([]);
    const registry = new SettingsRegistry();
    registry.registerSchema(GAZE_SETTINGS_NAMESPACE, GAZE_SETTING_FIELDS);
    const values = registry.getAll(GAZE_SETTINGS_NAMESPACE);
    const config = gazeConfigFromSettings(values);
    expect(config.dwell).toEqual(DEFAULT_DWELL_CONFIG);
    expect(config.method).toBe('dwell');
    expect(config.hitTest).toEqual({
      expansionPx: DEFAULT_HIT_TEST_CONFIG.expansionPx,
      hysteresisPx: DEFAULT_HIT_TEST_CONFIG.hysteresisPx,
    });
    expect(resolveGazeEngineConfig(config.engine)).toEqual(DEFAULT_GAZE_ENGINE_CONFIG);
  });

  it('round-trips an adjusted dwell config through setting values', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema(GAZE_SETTINGS_NAMESPACE, GAZE_SETTING_FIELDS);
    const adjusted = adjustDwell(DEFAULT_DWELL_CONFIG, { direction: 'faster' }).config;
    for (const [key, value] of Object.entries(dwellConfigToSettings(adjusted))) {
      registry.set(GAZE_SETTINGS_NAMESPACE, key, value);
    }
    registry.set(GAZE_SETTINGS_NAMESPACE, 'selectionMethod', 'switch');
    const config = gazeConfigFromSettings(registry.getAll(GAZE_SETTINGS_NAMESPACE));
    expect(config.dwell).toEqual(adjusted);
    expect(config.method).toBe('switch');
  });

  it('maps blink allowance and fixation spread into the engine config', () => {
    const config = gazeConfigFromSettings({
      'selection.holdMs': 500,
      'fixation.dispersionPx': 120,
    });
    const engine = resolveGazeEngineConfig(config.engine);
    expect(engine.selection.holdMs).toBe(500);
    expect(engine.fixation.dispersionPx).toBe(120);
  });

  it('marks every setting that changes selection as needing confirmation', () => {
    const risky = GAZE_SETTING_FIELDS.filter((f) => (f.danger ?? 'none') !== 'none').map(
      (f) => f.key,
    );
    expect(risky).toEqual(
      expect.arrayContaining([
        'selectionMethod',
        'dwell.letterMs',
        'dwell.decayPerSecond',
        'dwell.wakeMs',
        'targets.hysteresisPx',
        'selection.holdMs',
      ]),
    );
    expect(GAZE_SETTING_FIELDS.find((f) => f.key === 'selectionMethod')?.danger).toBe('lockout');
  });
});
