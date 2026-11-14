/**
 * Semantic versions (semver 2.0.0): `MAJOR.MINOR.PATCH`, optionally with a
 * `-prerelease` and a `+build` suffix. No ranges: the manifest only needs
 * "at least this version".
 */

/** Source of the semver regular expression, shared with the JSON Schema. */
export const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
  '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$';

const SEMVER = new RegExp(SEMVER_PATTERN);

/** Longest version string accepted. */
export const MAX_VERSION_LENGTH = 64;

/** A parsed version. */
export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

/** Parses a version, or returns `null` if it is not valid semver. */
export function parseSemVer(version: string): SemVer | null {
  if (version.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split('.') };
}

/** Whether `version` is valid semver. */
export function isSemVer(version: string): boolean {
  return parseSemVer(version) !== null;
}

/** Compares two parsed versions by semver precedence (build metadata ignored). */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // A version without prerelease has higher precedence than one with.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length === 0 ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
