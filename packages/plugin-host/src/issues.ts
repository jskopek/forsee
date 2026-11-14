import type { ValidationIssue, ValidationResult } from '@forsee/plugin-api';
import { isPlainObject } from './guards';

/** Collects validation issues with JSON-pointer-like paths. */
export class Issues {
  readonly list: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }

  get ok(): boolean {
    return this.list.length === 0;
  }

  /** Adds every issue of `other` with `prefix` prepended to its path. */
  addAll(prefix: string, other: readonly ValidationIssue[]): void {
    for (const issue of other) this.add(`${prefix}${issue.path}`, issue.message);
  }

  result<T>(value: () => T): ValidationResult<T> {
    return this.ok ? { ok: true, value: value() } : { ok: false, issues: this.list };
  }

  /** Checks that `value` is a plain object with only `allowed` keys. Returns it or `null`. */
  object(
    path: string,
    value: unknown,
    allowed: readonly string[],
    what = 'an object',
  ): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      this.add(path, `Expected ${what}`);
      return null;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(`${path}/${key}`, `Unknown property "${key}"`);
    }
    return value;
  }

  /** Requires a string with optional bounds and pattern. */
  string(
    path: string,
    value: unknown,
    options: {
      readonly required?: boolean;
      readonly min?: number;
      readonly max: number;
      readonly pattern?: RegExp;
      readonly patternMessage?: string;
    },
  ): value is string {
    if (value === undefined) {
      if (options.required !== false) this.add(path, 'Required');
      return false;
    }
    if (typeof value !== 'string') {
      this.add(path, 'Expected a string');
      return false;
    }
    if (value.length < (options.min ?? 0)) {
      this.add(path, options.min === 1 ? 'Must not be empty' : `Shorter than ${options.min}`);
      return false;
    }
    if (value.length > options.max) {
      this.add(path, `Longer than ${options.max} characters`);
      return false;
    }
    if (options.pattern && !options.pattern.test(value)) {
      this.add(path, options.patternMessage ?? 'Invalid format');
      return false;
    }
    return true;
  }

  /** Requires a finite number within optional bounds. */
  number(
    path: string,
    value: unknown,
    options: {
      readonly required?: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly exclusiveMin?: number;
      readonly integer?: boolean;
    } = {},
  ): value is number {
    if (value === undefined) {
      if (options.required !== false) this.add(path, 'Required');
      return false;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, 'Expected a finite number');
      return false;
    }
    if (options.integer && !Number.isInteger(value)) {
      this.add(path, 'Expected an integer');
      return false;
    }
    if (options.min !== undefined && value < options.min) {
      this.add(path, `Must be >= ${options.min}`);
      return false;
    }
    if (options.max !== undefined && value > options.max) {
      this.add(path, `Must be <= ${options.max}`);
      return false;
    }
    if (options.exclusiveMin !== undefined && !(value > options.exclusiveMin)) {
      this.add(path, `Must be > ${options.exclusiveMin}`);
      return false;
    }
    return true;
  }

  /** Requires an array with bounded length. */
  array(
    path: string,
    value: unknown,
    options: { readonly required?: boolean; readonly min?: number; readonly max: number },
  ): value is readonly unknown[] {
    if (value === undefined) {
      if (options.required !== false) this.add(path, 'Required');
      return false;
    }
    if (!Array.isArray(value)) {
      this.add(path, 'Expected an array');
      return false;
    }
    if (value.length < (options.min ?? 0)) {
      this.add(path, `Needs at least ${options.min} item${options.min === 1 ? '' : 's'}`);
      return false;
    }
    if (value.length > options.max) {
      this.add(path, `More than ${options.max} items`);
      return false;
    }
    return true;
  }
}
