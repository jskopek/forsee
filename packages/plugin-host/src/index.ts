/**
 * @forsee/plugin-host — loader, permissions, sandbox and RPC for plugins
 * (work packages B9 and B10). Contracts are in `contracts.ts`.
 */
export * from './contracts';
export * from './contribution-validators';
export * from './manifest';
export * from './manifest-schema';
export { compareSemVer, isSemVer, parseSemVer, SEMVER_PATTERN, type SemVer } from './semver';
export { isSafeRelativePath, isValidHost } from './patterns';
export { LIMITS, toCloneSafe } from './guards';

/** Package name, for diagnostics. */
export const PLUGIN_HOST_PACKAGE = '@forsee/plugin-host';
