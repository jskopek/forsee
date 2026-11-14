import { ForseeError, isForseeError } from '@forsee/core';
import type { JsonObject, JsonValue, ValidationIssue } from '@forsee/plugin-api';

/**
 * Validation and copying helpers for data crossing from a plugin into the
 * host. For sandboxed plugins every argument comes from untrusted code, so
 * nothing is assumed about its shape; for first-party plugins the same
 * checks keep bugs out of the kernel.
 */

/** Size limits applied to plugin input. */
export const LIMITS = {
  /** Local part of a contribution or panel id. */
  localIdLength: 128,
  /** Full command id. */
  commandIdLength: 256,
  /** Titles, names, labels. */
  labelLength: 200,
  /** Descriptions. */
  descriptionLength: 2000,
  /** Text inserted, spoken, accepted or replaced. */
  textLength: 20_000,
  /** Storage, context and setting keys. */
  keyLength: 256,
  /** Serialised size (in UTF-16 code units) of a command's arguments or a context value. */
  smallJsonSize: 64 * 1024,
  /** Serialised size of one private storage value. */
  storageJsonSize: 1024 * 1024,
  /** Nesting depth of any JSON value. */
  jsonDepth: 32,
  /** Elements of any array argument. */
  arrayLength: 10_000,
  /** Targets per panel. */
  panelTargets: 500,
  /** `history.listRecent` limit. */
  historyLimit: 500,
  /** Setting fields per schema. */
  settingFields: 200,
  /** Candidates per list in a prediction result. */
  candidates: 100,
} as const;

/** Throws `invalid-argument`. */
export function invalid(message: string, issues?: readonly ValidationIssue[]): never {
  throw new ForseeError(
    'invalid-argument',
    message,
    issues === undefined
      ? undefined
      : { details: issues.map((i) => ({ path: i.path, message: i.message })) },
  );
}

/** Whether `value` is a plain object (prototype `Object.prototype` or `null`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads an own property without walking the prototype chain. */
export function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** Characters never allowed in ids and keys: controls, separators, bidi overrides. */
const UNSAFE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'u',
);

/** Checks a string argument. */
export function requireString(
  value: unknown,
  name: string,
  options: { readonly max?: number; readonly min?: number; readonly pattern?: RegExp } = {},
): string {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  const max = options.max ?? LIMITS.textLength;
  const min = options.min ?? 0;
  if (value.length > max) invalid(`${name} is longer than ${max} characters`);
  if (value.length < min) invalid(`${name} must not be empty`);
  if (options.pattern && !options.pattern.test(value)) invalid(`${name} has an invalid format`);
  return value;
}

/** Checks a short single-line identifier or key (no control or bidi characters). */
export function requireKey(value: unknown, name: string, max: number = LIMITS.keyLength): string {
  const key = requireString(value, name, { min: 1, max });
  if (UNSAFE_CHARS.test(key)) invalid(`${name} contains control characters`);
  return key;
}

/** Checks an optional string argument. */
export function optionalString(
  value: unknown,
  name: string,
  max: number = LIMITS.descriptionLength,
): string | undefined {
  return value === undefined ? undefined : requireString(value, name, { max });
}

/** Checks a boolean argument. */
export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(`${name} must be a boolean`);
  return value;
}

/** Checks a finite number argument, optionally an integer within bounds. */
export function requireNumber(
  value: unknown,
  name: string,
  options: { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${name} must be a finite number`);
  }
  if (options.integer && !Number.isInteger(value)) invalid(`${name} must be an integer`);
  if (options.min !== undefined && value < options.min)
    invalid(`${name} must be >= ${options.min}`);
  if (options.max !== undefined && value > options.max)
    invalid(`${name} must be <= ${options.max}`);
  return value;
}

/** Checks a function argument (handler, listener). */
export function requireFunction(value: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') invalid(`${name} must be a function`);
  return value as (...args: unknown[]) => unknown;
}

/** Checks a plain object argument. */
export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Checks an array argument and its length. */
export function requireArray(
  value: unknown,
  name: string,
  max: number = LIMITS.arrayLength,
): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  if (value.length > max) invalid(`${name} has more than ${max} elements`);
  return value as readonly unknown[];
}

/**
 * Validates `value` as JSON and returns a deep copy, so the caller can
 * neither smuggle in non-JSON values (functions, class instances, cycles,
 * non-finite numbers) nor mutate the stored copy later. `size` counts
 * string characters plus a little per value, approximating the serialised size.
 */
export function copyJson(
  value: unknown,
  name: string,
  maxSize: number = LIMITS.smallJsonSize,
): JsonValue {
  let size = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, path: string, depth: number): JsonValue => {
    if (depth > LIMITS.jsonDepth) invalid(`${name} is nested too deeply at ${path || '/'}`);
    size += 4;
    if (size > maxSize) invalid(`${name} is larger than ${maxSize} characters`);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      size += v.length;
      if (size > maxSize) invalid(`${name} is larger than ${maxSize} characters`);
      return v;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) invalid(`${name} has a non-finite number at ${path || '/'}`);
      return v;
    }
    if (typeof v !== 'object') invalid(`${name} has a non-JSON value at ${path || '/'}`);
    if (seen.has(v)) invalid(`${name} contains a cycle at ${path || '/'}`);
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > LIMITS.arrayLength) invalid(`${name} has an array that is too long`);
        const out: JsonValue[] = [];
        for (let i = 0; i < v.length; i += 1) {
          const item: unknown = v[i];
          if (item === undefined) invalid(`${name} has undefined at ${path}/${i}`);
          out.push(visit(item, `${path}/${i}`, depth + 1));
        }
        return out;
      }
      if (!isPlainObject(v)) invalid(`${name} has a non-plain object at ${path || '/'}`);
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(v)) {
        const item = v[key];
        if (item === undefined) continue;
        size += key.length;
        if (key === '__proto__') invalid(`${name} has a forbidden key at ${path || '/'}`);
        out[key] = visit(item, `${path}/${key}`, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  try {
    return visit(value, '', 0);
  } catch (error) {
    if (isForseeError(error)) throw error;
    // A hostile getter or proxy threw while being read.
    return invalid(`${name} could not be read`);
  }
}

/** Like `copyJson` but requires a JSON object (or `undefined`). */
export function copyJsonObject(
  value: unknown,
  name: string,
  maxSize: number = LIMITS.smallJsonSize,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) invalid(`${name} must be a plain object`);
  return copyJson(value, name, maxSize) as JsonObject;
}

/**
 * Makes a result structured-clone-safe: a deep copy keeping plain objects,
 * arrays, strings, finite numbers, booleans, `null`, `undefined`,
 * `ArrayBuffer` and `Uint8Array`. Functions, symbols and other objects'
 * prototypes are dropped (class instances become plain objects of their own
 * enumerable fields); non-finite numbers become `null`; cycles become `null`.
 */
export function toCloneSafe(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return null;
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (depth > LIMITS.jsonDepth) return null;
  const obj = value;
  if (obj instanceof Uint8Array) return new Uint8Array(obj);
  if (obj instanceof ArrayBuffer) return obj.slice(0);
  if (seen.has(obj)) return null;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item: unknown) => {
        const copy = toCloneSafe(item, depth + 1, seen);
        return copy === undefined ? null : copy;
      });
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const copy = toCloneSafe((obj as Record<string, unknown>)[key], depth + 1, seen);
      if (copy !== undefined) out[key] = copy;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Converts anything thrown into a `ForseeError` (keeping `ForseeError`s as they are). */
export function toForseeError(error: unknown, fallbackMessage = 'Internal error'): ForseeError {
  if (isForseeError(error)) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new ForseeError('internal', message || fallbackMessage, { cause: error });
}
