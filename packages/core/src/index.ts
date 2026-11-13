/**
 * @forsee/core — the kernel: event bus, commands, composition buffer,
 * conversation log, settings, extension registry, regions, context store,
 * plus the injected platform abstractions (clock, ids, profile file system)
 * and their test doubles. Pure TypeScript: no DOM, no Node.
 */
export * from './cancellation';
export * from './commands';
export * from './composition';
export * from './context-store';
export * from './conversation';
export * from './disposable';
export * from './errors';
export * from './event-bus';
export * from './extensions';
export * from './graphemes';
export * from './hlc';
export * from './kernel';
export * from './memory-fs';
export * from './platform';
export * from './regions';
export * from './services';
export * from './settings';
export * from './testing';
export * from './utf8';

/** Package name, for diagnostics. */
export const CORE_PACKAGE = '@forsee/core';
