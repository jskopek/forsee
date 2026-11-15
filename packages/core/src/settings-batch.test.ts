import type { SettingChange, SettingField } from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { isForseeError } from './errors';
import {
  formatSettingValue,
  safeRange,
  SettingsRegistry,
  stepSettingValue,
  validateSettingFields,
} from './settings';
import { SettingsTrial } from './settings-trial';
import { FakeClock } from './testing';

const FIELDS: readonly SettingField[] = [
  {
    key: 'letterMs',
    label: 'Letter dwell',
    type: 'number',
    default: 800,
    min: 100,
    max: 10_000,
    step: 100,
    unit: 'ms',
    safeMin: 200,
    safeMax: 5000,
    danger: 'caution',
  },
  { key: 'adaptive', label: 'Adaptive', type: 'boolean', default: true },
  {
    key: 'factor',
    label: 'Factor',
    type: 'number',
    default: 0.6,
    min: 0.25,
    max: 1,
    step: 0.05,
    unit: 'x',
    enabledWhen: { key: 'adaptive', equals: true },
  },
  { key: 'mode', label: 'Mode', type: 'select', default: 'a', options: ['a', 'b'] },
];

function registry(): SettingsRegistry {
  const r = new SettingsRegistry({ reportError: () => undefined });
  r.registerSchema('ns', FIELDS);
  return r;
}

describe('setting metadata validation', () => {
  it('accepts the metadata fields', () => {
    expect(validateSettingFields(FIELDS)).toEqual([]);
  });

  it('rejects safe bounds outside min/max, an inverted safe range, or a default outside it', () => {
    const base = { key: 'n', label: 'N', type: 'number', default: 5, min: 0, max: 10 } as const;
    expect(validateSettingFields([{ ...base, safeMin: -1 }])).toHaveLength(1);
    expect(validateSettingFields([{ ...base, safeMax: 11 }])).toHaveLength(1);
    expect(validateSettingFields([{ ...base, safeMin: 8, safeMax: 6 }])).toHaveLength(1);
    expect(validateSettingFields([{ ...base, safeMin: 6 }])).toHaveLength(1);
  });

  it('rejects safe bounds on non-numbers and unknown enum values', () => {
    expect(
      validateSettingFields([{ key: 'b', label: 'B', type: 'boolean', default: true, safeMin: 1 }]),
    ).toHaveLength(1);
    expect(
      validateSettingFields([
        { key: 'b', label: 'B', type: 'boolean', default: true, danger: 'nope' as never },
      ]),
    ).toHaveLength(1);
    expect(
      validateSettingFields([
        { key: 'b', label: 'B', type: 'boolean', default: true, audience: 'all' as never },
      ]),
    ).toHaveLength(1);
  });

  it('checks that enabledWhen names another key with a valid value', () => {
    const b = { key: 'b', label: 'B', type: 'boolean', default: true } as const;
    expect(
      validateSettingFields([b, { ...b, key: 'c', enabledWhen: { key: 'x', equals: true } }]),
    ).toHaveLength(1);
    expect(
      validateSettingFields([b, { ...b, key: 'c', enabledWhen: { key: 'b', equals: 'yes' } }]),
    ).toHaveLength(1);
  });
});

describe('SettingsRegistry batch operations', () => {
  it('setMany validates everything first and changes nothing on failure', () => {
    const r = registry();
    const changed = vi.fn();
    r.events.on('changed', changed);
    try {
      r.setMany([
        { namespace: 'ns', key: 'letterMs', value: 600 },
        { namespace: 'ns', key: 'mode', value: 'z' },
      ]);
      expect.unreachable();
    } catch (error) {
      expect(isForseeError(error) && error.code).toBe('invalid-argument');
    }
    expect(r.get('ns', 'letterMs')).toBe(800);
    expect(changed).not.toHaveBeenCalled();
  });

  it('emits changed per key, then one committed with all effective changes', () => {
    const r = registry();
    const order: string[] = [];
    let commit: readonly SettingChange[] = [];
    r.events.on('changed', (c) => order.push(c.key));
    r.events.on('committed', ({ changes }) => {
      order.push('commit');
      commit = changes;
    });
    r.setMany([
      { namespace: 'ns', key: 'letterMs', value: 600 },
      { namespace: 'ns', key: 'adaptive', value: true }, // unchanged
      { namespace: 'ns', key: 'mode', value: 'b' },
    ]);
    expect(order).toEqual(['letterMs', 'mode', 'commit']);
    expect(commit.map((c) => [c.key, c.previous, c.value])).toEqual([
      ['letterMs', 800, 600],
      ['mode', 'a', 'b'],
    ]);
  });

  it('does not emit committed when nothing changes', () => {
    const r = registry();
    const committed = vi.fn();
    r.events.on('committed', committed);
    r.set('ns', 'mode', 'a');
    r.setMany([]);
    r.resetMany([{ namespace: 'ns', key: 'mode' }]);
    expect(committed).not.toHaveBeenCalled();
  });

  it('saves once per batch', async () => {
    const save = vi.fn(() => Promise.resolve());
    const r = new SettingsRegistry({ persistence: { load: () => Promise.resolve({}), save } });
    r.registerSchema('ns', FIELDS);
    r.setMany([
      { namespace: 'ns', key: 'letterMs', value: 600 },
      { namespace: 'ns', key: 'mode', value: 'b' },
    ]);
    r.resetMany([
      { namespace: 'ns', key: 'letterMs' },
      { namespace: 'ns', key: 'mode' },
    ]);
    await r.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(r.export()).toEqual({});
  });

  it('resetMany throws not-found before changing anything', () => {
    const r = registry();
    r.set('ns', 'mode', 'b');
    expect(() =>
      r.resetMany([
        { namespace: 'ns', key: 'mode' },
        { namespace: 'ns', key: 'missing' },
      ]),
    ).toThrow();
    expect(r.get('ns', 'mode')).toBe('b');
  });

  it('isSet and isModified tell a stored default from a change', () => {
    const r = registry();
    expect(r.isSet('ns', 'mode')).toBe(false);
    r.set('ns', 'mode', 'a');
    expect(r.isSet('ns', 'mode')).toBe(true);
    expect(r.isModified('ns', 'mode')).toBe(false);
    r.set('ns', 'mode', 'b');
    expect(r.isModified('ns', 'mode')).toBe(true);
  });
});

describe('settings screen helpers', () => {
  const [letter, , factor] = FIELDS as [SettingField, SettingField, SettingField];

  it('safeRange prefers safeMin/safeMax over min/max', () => {
    expect(safeRange(letter)).toEqual({ min: 200, max: 5000 });
    expect(safeRange(factor)).toEqual({ min: 0.25, max: 1 });
  });

  it('stepSettingValue stays inside the safe range and rounds to the step', () => {
    expect(stepSettingValue(letter, 800, -1)).toBe(700);
    expect(stepSettingValue(letter, 200, -1)).toBe(200);
    expect(stepSettingValue(letter, 5000, 1)).toBe(5000);
    expect(stepSettingValue(factor, 0.6, 1)).toBe(0.65);
    expect(stepSettingValue(factor, 0.3, -1)).toBe(0.25);
  });

  it('formatSettingValue shows units, seconds and option labels', () => {
    expect(formatSettingValue(letter, 800)).toBe('800 ms');
    expect(formatSettingValue(letter, 1200)).toBe('1.2 s');
    expect(formatSettingValue(letter, 1250)).toBe('1.25 s');
    expect(formatSettingValue(factor, 0.6)).toBe('0.60×');
    expect(formatSettingValue(FIELDS[1]!, false)).toBe('Off');
    expect(
      formatSettingValue(
        {
          key: 's',
          label: 'S',
          type: 'select',
          default: 1,
          options: [{ label: 'One', value: 1 }],
        },
        1,
      ),
    ).toBe('One');
  });
});

describe('SettingsTrial', () => {
  function setup() {
    const r = registry();
    const clock = new FakeClock();
    const trial = new SettingsTrial({ registry: r, clock, timeoutMs: 15_000 });
    return { r, clock, trial };
  }

  it('undoes the change when not kept in time', () => {
    const { r, clock, trial } = setup();
    trial.apply([{ namespace: 'ns', key: 'letterMs', value: 300 }]);
    expect(r.get('ns', 'letterMs')).toBe(300);
    expect(trial.pending?.deadline).toBe(15_000);
    clock.advance(14_999);
    expect(r.get('ns', 'letterMs')).toBe(300);
    clock.advance(1);
    expect(r.get('ns', 'letterMs')).toBe(800);
    expect(r.isSet('ns', 'letterMs')).toBe(false);
    expect(trial.pending).toBeNull();
  });

  it('keeps the change when confirmed', () => {
    const { r, clock, trial } = setup();
    trial.apply([{ namespace: 'ns', key: 'letterMs', value: 300 }]);
    trial.keep();
    clock.advance(60_000);
    expect(r.get('ns', 'letterMs')).toBe(300);
  });

  it('restores stored values from before the first change and restarts the countdown', () => {
    const { r, clock, trial } = setup();
    r.set('ns', 'letterMs', 1000);
    trial.apply([{ namespace: 'ns', key: 'letterMs', value: 900 }]);
    clock.advance(10_000);
    trial.apply([
      { namespace: 'ns', key: 'letterMs', value: 700 },
      { namespace: 'ns', key: 'mode', value: 'b' },
    ]);
    expect(trial.pending?.settings).toHaveLength(2);
    clock.advance(10_000); // the first countdown would have ended
    expect(r.get('ns', 'letterMs')).toBe(700);
    trial.revert();
    expect(r.get('ns', 'letterMs')).toBe(1000);
    expect(r.get('ns', 'mode')).toBe('a');
    expect(r.isSet('ns', 'mode')).toBe(false);
  });

  it('reverts a reset to the earlier value', () => {
    const { r, clock, trial } = setup();
    r.set('ns', 'letterMs', 2000);
    trial.reset([{ namespace: 'ns', key: 'letterMs' }]);
    expect(r.get('ns', 'letterMs')).toBe(800);
    clock.advance(15_000);
    expect(r.get('ns', 'letterMs')).toBe(2000);
  });

  it('changes nothing and starts no countdown for an invalid value', () => {
    const { r, trial } = setup();
    expect(() => trial.apply([{ namespace: 'ns', key: 'letterMs', value: 5 }])).toThrow();
    expect(trial.pending).toBeNull();
    expect(r.get('ns', 'letterMs')).toBe(800);
  });
});
