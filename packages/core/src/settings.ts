import {
  SETTING_AUDIENCES,
  SETTING_DANGERS,
  SETTING_UNITS,
  type Disposable,
  type SettingChange,
  type SettingsCommit,
  type SettingField,
  type SettingOption,
  type SettingsSnapshot,
  type SettingValue,
  type ValidationIssue,
  type ValidationResult,
} from '@forsee/plugin-api';
import { toDisposable } from './disposable';
import { defaultErrorReporter, ForseeError, type ErrorReporter } from './errors';
import { EventBus } from './event-bus';
import type { SettingsPersistence } from './services';

/** Events emitted by the settings registry. */
export interface SettingsEventMap {
  /** A value changed (by `set`, `reset`, `setMany`, `resetMany` or `load`). Not emitted when the value is unchanged. */
  changed: SettingChange;
  /**
   * Once per operation, after its `changed` events, with all of its
   * effective changes (never empty). Listeners that reconfigure something
   * expensive should use this, so a preset applies in one step.
   */
  committed: SettingsCommit;
  /** A namespace's schema was registered or removed. */
  schemaChanged: { readonly namespace: string; readonly change: 'added' | 'removed' };
}

/** Options for `SettingsRegistry`. */
export interface SettingsRegistryOptions {
  readonly persistence?: SettingsPersistence;
  readonly reportError?: ErrorReporter;
}

/** One entry of `SettingsRegistry.setMany`. */
export interface SettingAssignment {
  readonly namespace: string;
  readonly key: string;
  readonly value: SettingValue;
}

/** One entry of `SettingsRegistry.resetMany`. */
export interface SettingRef {
  readonly namespace: string;
  readonly key: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const STEP_TOLERANCE = 1e-9;

/** Normalises a select option (a bare string is shorthand for `{ label: s, value: s }`). */
export function normaliseOption(option: SettingOption | string): SettingOption {
  return typeof option === 'string' ? { label: option, value: option } : option;
}

/** Validates a value against a field's schema (rules in `SettingField`'s doc comment). */
export function validateSettingValue(
  field: SettingField,
  value: unknown,
): ValidationResult<SettingValue> {
  const fail = (message: string): ValidationResult<SettingValue> => ({
    ok: false,
    issues: [{ path: `/${field.key}`, message }],
  });
  switch (field.type) {
    case 'string':
      return typeof value === 'string' ? { ok: true, value } : fail('Expected a string');
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : fail('Expected a boolean');
    case 'number':
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('Expected a finite number');
      }
      if (field.min !== undefined && value < field.min) return fail(`Must be >= ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail(`Must be <= ${field.max}`);
      if (field.type === 'range' && field.step !== undefined && field.min !== undefined) {
        const steps = (value - field.min) / field.step;
        if (Math.abs(steps - Math.round(steps)) > STEP_TOLERANCE * Math.max(1, Math.abs(steps))) {
          return fail(`Must be a multiple of ${field.step} from ${field.min}`);
        }
      }
      return { ok: true, value };
    }
    case 'select': {
      const options = (field.options ?? []).map(normaliseOption);
      return options.some((o) => o.value === value)
        ? { ok: true, value: value as SettingValue }
        : fail('Not one of the options');
    }
  }
}

/** Validates a schema: keys, types, bounds, options and defaults. */
export function validateSettingFields(fields: readonly SettingField[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    const path = `/${index}`;
    if (!KEY_PATTERN.test(field.key)) issues.push({ path, message: `Invalid key "${field.key}"` });
    if (seen.has(field.key)) issues.push({ path, message: `Duplicate key "${field.key}"` });
    seen.add(field.key);
    if (field.label === '') issues.push({ path, message: 'Label must not be empty' });
    if (field.type === 'range') {
      if (field.min === undefined || field.max === undefined) {
        issues.push({ path, message: 'Range settings need min and max' });
      }
      if (field.step !== undefined && !(field.step > 0)) {
        issues.push({ path, message: 'step must be > 0' });
      }
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      issues.push({ path, message: 'min must be <= max' });
    }
    if (field.type === 'select' && (field.options ?? []).length === 0) {
      issues.push({ path, message: 'Select settings need options' });
    }
    const check = validateSettingValue(field, field.default);
    if (!check.ok) issues.push({ path, message: `Invalid default: ${check.issues[0]?.message}` });
    validateMetadata(field, path, issues);
  });
  fields.forEach((field, index) => {
    const condition = field.enabledWhen;
    if (condition === undefined) return;
    const target = fields.find((f) => f.key === condition.key);
    if (!target || target.key === field.key) {
      issues.push({
        path: `/${index}`,
        message: `enabledWhen refers to unknown key "${condition.key}"`,
      });
    } else if (!validateSettingValue(target, condition.equals).ok) {
      issues.push({
        path: `/${index}`,
        message: `enabledWhen value is not valid for "${condition.key}"`,
      });
    }
  });
  return issues;
}

function validateMetadata(field: SettingField, path: string, issues: ValidationIssue[]): void {
  const numeric = field.type === 'number' || field.type === 'range';
  if (field.order !== undefined && !Number.isFinite(field.order)) {
    issues.push({ path, message: 'order must be a finite number' });
  }
  if (field.unit !== undefined && !SETTING_UNITS.includes(field.unit)) {
    issues.push({ path, message: `Unknown unit "${String(field.unit)}"` });
  }
  if (field.audience !== undefined && !SETTING_AUDIENCES.includes(field.audience)) {
    issues.push({ path, message: `Unknown audience "${String(field.audience)}"` });
  }
  if (field.danger !== undefined && !SETTING_DANGERS.includes(field.danger)) {
    issues.push({ path, message: `Unknown danger "${String(field.danger)}"` });
  }
  if (field.category?.trim() === '') {
    issues.push({ path, message: 'category must not be empty' });
  }
  for (const bound of ['safeMin', 'safeMax'] as const) {
    const value = field[bound];
    if (value === undefined) continue;
    if (!numeric) {
      issues.push({ path, message: `${bound} only applies to number and range settings` });
      continue;
    }
    if (!Number.isFinite(value)) issues.push({ path, message: `${bound} must be finite` });
    if (field.min !== undefined && value < field.min) {
      issues.push({ path, message: `${bound} must be >= min` });
    }
    if (field.max !== undefined && value > field.max) {
      issues.push({ path, message: `${bound} must be <= max` });
    }
  }
  if (numeric && typeof field.default === 'number') {
    const { min, max } = safeRange(field);
    if (
      field.safeMin !== undefined &&
      field.safeMax !== undefined &&
      field.safeMin > field.safeMax
    ) {
      issues.push({ path, message: 'safeMin must be <= safeMax' });
    } else if (field.default < min || field.default > max) {
      issues.push({ path, message: 'The default must lie within safeMin and safeMax' });
    }
  }
}

/**
 * The range the gaze-operated settings screen offers for a number:
 * `safeMin`/`safeMax`, falling back to `min`/`max` (infinite when unbounded).
 */
export function safeRange(field: SettingField): { readonly min: number; readonly max: number } {
  return {
    min: field.safeMin ?? field.min ?? -Infinity,
    max: field.safeMax ?? field.max ?? Infinity,
  };
}

/**
 * The settings registry (plan section 4). Namespaces are `"app"` for the
 * app and the plugin id for each plugin; keys are unique per namespace.
 *
 * - Values for namespaces whose schema is not registered yet (a plugin not
 *   loaded) are kept as-is and validated when the schema arrives; invalid
 *   ones are dropped and reported. Removing a schema keeps stored values.
 * - `get`/`set` on an unregistered namespace or key throw `not-found`;
 *   invalid values throw `invalid-argument` with the issues in `details`.
 * - Only explicitly set values are stored and exported; defaults are not.
 * - Every successful change is saved through `persistence` in the
 *   background, in order; failures go to `reportError`.
 */
export class SettingsRegistry implements Disposable {
  readonly events: EventBus<SettingsEventMap>;
  private readonly schemas = new Map<string, Map<string, SettingField>>();
  private readonly stored = new Map<string, Map<string, SettingValue>>();
  private readonly persistence: SettingsPersistence | undefined;
  private readonly reportError: ErrorReporter;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: SettingsRegistryOptions = {}) {
    this.persistence = options.persistence;
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.events = new EventBus({ onListenerError: this.reportError });
  }

  /** Registers a namespace's schema. Throws `duplicate` or `invalid-argument`. */
  registerSchema(namespace: string, fields: readonly SettingField[]): Disposable {
    if (namespace === '') throw new ForseeError('invalid-argument', 'Namespace must not be empty');
    if (this.schemas.has(namespace)) {
      throw new ForseeError('duplicate', `Settings namespace already registered: ${namespace}`);
    }
    const issues = validateSettingFields(fields);
    if (issues.length > 0) {
      throw new ForseeError('invalid-argument', `Invalid settings schema for ${namespace}`, {
        details: issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const schema = new Map(fields.map((f) => [f.key, f] as const));
    this.schemas.set(namespace, schema);
    const values = this.stored.get(namespace);
    if (values) {
      for (const [key, value] of [...values]) {
        const field = schema.get(key);
        if (!field) continue; // unknown key: keep, a later schema version may know it
        if (!validateSettingValue(field, value).ok) {
          values.delete(key);
          this.reportError(
            new ForseeError(
              'invalid-argument',
              `Dropped invalid stored setting ${namespace}/${key}`,
            ),
            'settings.load',
          );
        }
      }
    }
    this.events.emit('schemaChanged', { namespace, change: 'added' });
    return toDisposable(() => {
      if (this.schemas.get(namespace) === schema) {
        this.schemas.delete(namespace);
        this.events.emit('schemaChanged', { namespace, change: 'removed' });
      }
    });
  }

  hasSchema(namespace: string): boolean {
    return this.schemas.has(namespace);
  }

  /** The fields of a namespace, in registration order. */
  getSchema(namespace: string): readonly SettingField[] | undefined {
    const schema = this.schemas.get(namespace);
    return schema ? [...schema.values()] : undefined;
  }

  /** Registered namespaces, sorted. */
  listNamespaces(): readonly string[] {
    return [...this.schemas.keys()].sort();
  }

  /** Current value, or the default. */
  get(namespace: string, key: string): SettingValue {
    const field = this.requireField(namespace, key);
    return this.stored.get(namespace)?.get(key) ?? field.default;
  }

  /** All values of a namespace (defaults filled in). */
  getAll(namespace: string): Readonly<Record<string, SettingValue>> {
    const schema = this.schemas.get(namespace);
    if (!schema) throw new ForseeError('not-found', `Unknown settings namespace: ${namespace}`);
    const out: Record<string, SettingValue> = {};
    for (const key of schema.keys()) out[key] = this.get(namespace, key);
    return out;
  }

  /** Validates without changing anything. */
  validate(namespace: string, key: string, value: unknown): ValidationResult<SettingValue> {
    return validateSettingValue(this.requireField(namespace, key), value);
  }

  /** Sets a value. Throws `not-found` or `invalid-argument`. */
  set(namespace: string, key: string, value: SettingValue): void {
    this.setMany([{ namespace, key, value }]);
  }

  /**
   * Sets several values at once (a preset, an import, a dwell adjustment).
   * All values are validated first; if any is invalid nothing changes and
   * `invalid-argument` (or `not-found`) is thrown. Emits `changed` for each
   * effective change, then one `committed`, and saves once.
   */
  setMany(assignments: readonly SettingAssignment[]): void {
    for (const { namespace, key, value } of assignments) {
      const result = validateSettingValue(this.requireField(namespace, key), value);
      if (!result.ok) {
        throw new ForseeError('invalid-argument', `Invalid value for ${namespace}/${key}`, {
          details: result.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
    }
    if (assignments.length === 0) return;
    const changes: SettingChange[] = [];
    for (const { namespace, key, value } of assignments) {
      const previous = this.get(namespace, key);
      let values = this.stored.get(namespace);
      if (!values) {
        values = new Map();
        this.stored.set(namespace, values);
      }
      values.set(key, value);
      if (previous !== value) changes.push({ namespace, key, value, previous });
    }
    this.commit(changes);
    this.save();
  }

  /** Returns a setting to its default. */
  reset(namespace: string, key: string): void {
    this.resetMany([{ namespace, key }]);
  }

  /**
   * Returns several settings to their defaults (for example a whole
   * category). Throws `not-found` before changing anything when a key is
   * unknown. One `committed` event and one save.
   */
  resetMany(refs: readonly SettingRef[]): void {
    for (const { namespace, key } of refs) this.requireField(namespace, key);
    if (refs.length === 0) return;
    const changes: SettingChange[] = [];
    for (const { namespace, key } of refs) {
      const field = this.requireField(namespace, key);
      const previous = this.get(namespace, key);
      this.stored.get(namespace)?.delete(key);
      if (previous !== field.default) {
        changes.push({ namespace, key, value: field.default, previous });
      }
    }
    this.commit(changes);
    this.save();
  }

  /** Whether a value is stored for the key (even one equal to the default). */
  isSet(namespace: string, key: string): boolean {
    return this.stored.get(namespace)?.has(key) ?? false;
  }

  /** Whether the current value differs from the default. */
  isModified(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== this.requireField(namespace, key).default;
  }

  /**
   * Replaces all stored values with `snapshot` (for example after import).
   * Values for registered fields are validated; invalid ones are dropped and
   * reported. Emits `changed` for every effective change. Does not save.
   */
  load(snapshot: SettingsSnapshot): void {
    const before = new Map<string, Map<string, SettingValue>>();
    for (const namespace of this.schemas.keys()) {
      before.set(namespace, new Map(Object.entries(this.getAll(namespace))));
    }
    this.stored.clear();
    for (const [namespace, values] of Object.entries(snapshot)) {
      if (typeof values !== 'object' || values === null) continue;
      const map = new Map<string, SettingValue>();
      const schema = this.schemas.get(namespace);
      for (const [key, value] of Object.entries(values)) {
        if (!isSettingValue(value)) continue;
        const field = schema?.get(key);
        if (field && !validateSettingValue(field, value).ok) {
          this.reportError(
            new ForseeError(
              'invalid-argument',
              `Dropped invalid stored setting ${namespace}/${key}`,
            ),
            'settings.load',
          );
          continue;
        }
        map.set(key, value);
      }
      if (map.size > 0) this.stored.set(namespace, map);
    }
    const changes: SettingChange[] = [];
    for (const [namespace, values] of before) {
      for (const [key, previous] of values) {
        const value = this.get(namespace, key);
        if (value !== previous) changes.push({ namespace, key, value, previous });
      }
    }
    this.commit(changes);
  }

  /** Loads from persistence (no-op without one). */
  async loadFromPersistence(): Promise<void> {
    if (!this.persistence) return;
    this.load(await this.persistence.load());
  }

  /** Explicitly set values, including those of namespaces not registered right now. */
  export(): SettingsSnapshot {
    const out: Record<string, Record<string, SettingValue>> = {};
    for (const [namespace, values] of this.stored) {
      if (values.size === 0) continue;
      out[namespace] = Object.fromEntries(values);
    }
    return out;
  }

  /** Resolves when every save started so far has finished. */
  flush(): Promise<void> {
    return this.saveChain;
  }

  dispose(): void {
    this.events.dispose();
  }

  private requireField(namespace: string, key: string): SettingField {
    const field = this.schemas.get(namespace)?.get(key);
    if (!field) throw new ForseeError('not-found', `Unknown setting: ${namespace}/${key}`);
    return field;
  }

  /** Emits `changed` for each change, then one `committed` (nothing when empty). */
  private commit(changes: readonly SettingChange[]): void {
    if (changes.length === 0) return;
    for (const change of changes) this.events.emit('changed', change);
    this.events.emit('committed', { changes });
  }

  private save(): void {
    const persistence = this.persistence;
    if (!persistence) return;
    const snapshot = this.export();
    this.saveChain = this.saveChain
      .then(() => persistence.save(snapshot))
      .catch((error: unknown) => this.reportError(error, 'settings.save'));
  }
}

function isSettingValue(value: unknown): value is SettingValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function decimalsOf(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const text = String(step);
  const exp = /e-(\d+)$/.exec(text);
  if (exp) return Number(exp[1]);
  return text.includes('.') ? (text.split('.')[1]?.length ?? 0) : 0;
}

/**
 * The value a "more" / "less" step on the settings screen gives: one `step`
 * (default 1) up or down, kept within `safeRange`, rounded to the step's
 * decimals. Returns the value unchanged at a bound.
 */
export function stepSettingValue(field: SettingField, value: number, direction: -1 | 1): number {
  const step = field.step ?? 1;
  const { min, max } = safeRange(field);
  const next = Math.min(max, Math.max(min, value + direction * step));
  return Number(next.toFixed(decimalsOf(step)));
}

/** Text for a setting's value on the settings screen ("0.8 s", "40 px", "On", an option's label). */
export function formatSettingValue(field: SettingField, value: SettingValue): string {
  switch (field.type) {
    case 'boolean':
      return value === true ? 'On' : 'Off';
    case 'select': {
      const option = (field.options ?? []).map(normaliseOption).find((o) => o.value === value);
      return option ? option.label : String(value);
    }
    case 'string':
      return value === '' ? '(automatic)' : String(value);
    case 'number':
    case 'range': {
      const n = Number(value);
      const decimals = decimalsOf(field.step ?? 1);
      if (field.unit === 'ms' && Math.abs(n) >= 1000) {
        return `${(n / 1000).toFixed(n % 100 === 0 ? 1 : 2)} s`;
      }
      const text = n.toFixed(decimals);
      if (field.unit === undefined) return text;
      if (field.unit === 'x') return `${text}×`;
      if (field.unit === '%') return `${text}%`;
      return `${text} ${field.unit}`;
    }
  }
}
