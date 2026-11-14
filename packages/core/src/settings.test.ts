import type { SettingField, SettingsSnapshot } from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { isForseeError, type ForseeError } from './errors';
import type { SettingsPersistence } from './services';
import { SettingsRegistry, validateSettingFields, validateSettingValue } from './settings';

const FIELDS: readonly SettingField[] = [
  { key: 'name', label: 'Name', type: 'string', default: '' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
  { key: 'count', label: 'Count', type: 'number', default: 3, min: 0, max: 10 },
  { key: 'dwell', label: 'Dwell', type: 'range', default: 800, min: 200, max: 3000, step: 50 },
  { key: 'rate', label: 'Rate', type: 'range', default: 1, min: 0.5, max: 2, step: 0.1 },
  { key: 'tone', label: 'Tone', type: 'select', default: 'casual', options: ['casual', 'formal'] },
  {
    key: 'mode',
    label: 'Mode',
    type: 'select',
    default: 1,
    options: [
      { label: 'One', value: 1 },
      { label: 'Two', value: 2 },
    ],
  },
];

function memoryPersistence(initial: SettingsSnapshot = {}) {
  let stored = initial;
  const persistence = {
    load: vi.fn(() => Promise.resolve(stored)),
    save: vi.fn((s: SettingsSnapshot) => {
      stored = s;
      return Promise.resolve();
    }),
  } satisfies SettingsPersistence;
  return {
    persistence,
    get stored() {
      return stored;
    },
  };
}

describe('validateSettingValue', () => {
  const field = (key: string): SettingField => FIELDS.find((f) => f.key === key)!;
  it.each([
    ['name', 'x', true],
    ['name', 1, false],
    ['enabled', false, true],
    ['enabled', 'true', false],
    ['count', 10, true],
    ['count', 11, false],
    ['count', -1, false],
    ['count', Number.NaN, false],
    ['count', Infinity, false],
    ['dwell', 850, true],
    ['dwell', 860, false],
    ['dwell', 150, false],
    ['rate', 0.7, true],
    ['rate', 1.3, true],
    ['rate', 0.75, false],
    ['tone', 'formal', true],
    ['tone', 'rude', false],
    ['mode', 2, true],
    ['mode', '2', false],
  ])('%s = %j -> %s', (key, value, ok) => {
    expect(validateSettingValue(field(key), value).ok).toBe(ok);
  });
});

describe('validateSettingFields', () => {
  it('accepts a valid schema', () => {
    expect(validateSettingFields(FIELDS)).toEqual([]);
  });

  it.each<[string, SettingField[]]>([
    ['duplicate keys', [FIELDS[0]!, FIELDS[0]!]],
    ['bad key', [{ key: 'a b', label: 'A', type: 'string', default: '' }]],
    ['empty label', [{ key: 'a', label: '', type: 'string', default: '' }]],
    ['range without bounds', [{ key: 'a', label: 'A', type: 'range', default: 1 }]],
    ['min > max', [{ key: 'a', label: 'A', type: 'number', default: 1, min: 5, max: 1 }]],
    ['bad step', [{ key: 'a', label: 'A', type: 'range', default: 1, min: 0, max: 2, step: 0 }]],
    ['select without options', [{ key: 'a', label: 'A', type: 'select', default: 'x' }]],
    ['invalid default', [{ key: 'a', label: 'A', type: 'number', default: 'x' }]],
  ])('rejects %s', (_label, fields) => {
    expect(validateSettingFields(fields).length).toBeGreaterThan(0);
  });
});

describe('SettingsRegistry', () => {
  it('returns defaults, sets valid values and emits changes', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema('plugin.a', FIELDS);
    expect(registry.get('plugin.a', 'dwell')).toBe(800);
    const changes = vi.fn();
    registry.events.on('changed', changes);
    registry.set('plugin.a', 'dwell', 900);
    expect(registry.get('plugin.a', 'dwell')).toBe(900);
    expect(changes).toHaveBeenCalledWith({
      namespace: 'plugin.a',
      key: 'dwell',
      value: 900,
      previous: 800,
    });
    registry.set('plugin.a', 'dwell', 900);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(registry.getAll('plugin.a')).toMatchObject({ dwell: 900, tone: 'casual' });
  });

  it('throws invalid-argument with issues for invalid values and keeps the old value', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema('ns', FIELDS);
    let error: unknown;
    try {
      registry.set('ns', 'count', 99);
    } catch (e) {
      error = e;
    }
    expect(isForseeError(error, 'invalid-argument')).toBe(true);
    expect((error as ForseeError).details).toEqual([{ path: '/count', message: 'Must be <= 10' }]);
    expect(registry.get('ns', 'count')).toBe(3);
  });

  it('throws not-found for unknown namespaces and keys', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema('ns', FIELDS);
    expect(() => registry.get('other', 'x')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => registry.set('ns', 'missing', 1)).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(() => registry.getAll('other')).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('rejects invalid and duplicate schemas', () => {
    const registry = new SettingsRegistry();
    expect(() =>
      registry.registerSchema('ns', [{ key: 'a', label: 'A', type: 'number', default: 'x' }]),
    ).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    registry.registerSchema('ns', FIELDS);
    expect(() => registry.registerSchema('ns', FIELDS)).toThrow(
      expect.objectContaining({ code: 'duplicate' }),
    );
    expect(() => registry.registerSchema('', FIELDS)).toThrow();
  });

  it('keeps values of unregistered namespaces and validates them when the schema arrives', () => {
    const report = vi.fn();
    const registry = new SettingsRegistry({ reportError: report });
    registry.load({ 'plugin.late': { count: 5, dwell: 7, future: 'kept' } });
    expect(registry.export()).toEqual({ 'plugin.late': { count: 5, dwell: 7, future: 'kept' } });
    registry.registerSchema('plugin.late', FIELDS);
    expect(registry.get('plugin.late', 'count')).toBe(5);
    expect(registry.get('plugin.late', 'dwell')).toBe(800); // invalid stored value dropped
    expect(report).toHaveBeenCalledTimes(1);
    expect(registry.export()).toEqual({ 'plugin.late': { count: 5, future: 'kept' } });
  });

  it('keeps stored values when a schema is disposed and re-registered', () => {
    const registry = new SettingsRegistry();
    const reg = registry.registerSchema('ns', FIELDS);
    registry.set('ns', 'tone', 'formal');
    reg.dispose();
    expect(registry.hasSchema('ns')).toBe(false);
    registry.registerSchema('ns', FIELDS);
    expect(registry.get('ns', 'tone')).toBe('formal');
  });

  it('load emits changes for registered namespaces and drops invalid values', () => {
    const report = vi.fn();
    const registry = new SettingsRegistry({ reportError: report });
    registry.registerSchema('ns', FIELDS);
    registry.set('ns', 'count', 4);
    const changes = vi.fn();
    registry.events.on('changed', changes);
    registry.load({ ns: { tone: 'formal', enabled: 'nope' } });
    expect(registry.get('ns', 'count')).toBe(3);
    expect(registry.get('ns', 'tone')).toBe('formal');
    expect(registry.get('ns', 'enabled')).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reset returns to the default and does not export defaults', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema('ns', FIELDS);
    registry.set('ns', 'count', 7);
    registry.reset('ns', 'count');
    expect(registry.get('ns', 'count')).toBe(3);
    expect(registry.export()).toEqual({});
  });

  it('persists every change in order and loads from persistence', async () => {
    const mem = memoryPersistence({ ns: { count: 9 } });
    const registry = new SettingsRegistry({ persistence: mem.persistence });
    registry.registerSchema('ns', FIELDS);
    await registry.loadFromPersistence();
    expect(registry.get('ns', 'count')).toBe(9);
    registry.set('ns', 'count', 1);
    registry.set('ns', 'tone', 'formal');
    await registry.flush();
    expect(mem.stored).toEqual({ ns: { count: 1, tone: 'formal' } });
    expect(mem.persistence.save).toHaveBeenCalledTimes(2);
  });

  it('reports save failures without throwing at the caller', async () => {
    const report = vi.fn();
    const registry = new SettingsRegistry({
      reportError: report,
      persistence: {
        load: () => Promise.resolve({}),
        save: () => Promise.reject(new Error('disk')),
      },
    });
    registry.registerSchema('ns', FIELDS);
    expect(() => registry.set('ns', 'count', 1)).not.toThrow();
    await registry.flush();
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'settings.save');
  });

  it('lists schemas and namespaces', () => {
    const registry = new SettingsRegistry();
    registry.registerSchema('b', FIELDS);
    registry.registerSchema('a', FIELDS.slice(0, 1));
    expect(registry.listNamespaces()).toEqual(['a', 'b']);
    expect(registry.getSchema('a')).toEqual(FIELDS.slice(0, 1));
    expect(registry.validate('b', 'count', 50).ok).toBe(false);
  });
});
