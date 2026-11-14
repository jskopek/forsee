/**
 * @forsee/plugin-api — the public contract of Forsee.
 *
 * Types plus a few constants, with no runtime dependencies. Everything a
 * plugin author or an engine package needs to agree on lives here. See
 * `common.ts` for the coordinate, time and data conventions every type follows.
 */
export * from './api';
export * from './commands';
export * from './common';
export * from './composition';
export * from './context';
export * from './contributions';
export * from './events';
export * from './gaze';
export * from './inference';
export * from './layout';
export * from './manifest';
export * from './prediction';
export * from './regions';
export * from './rpc';
export * from './settings';
export * from './speech';
export * from './storage';

/** Package name, for diagnostics. */
export const PLUGIN_API_PACKAGE = '@forsee/plugin-api';
