/**
 * @forsee/gaze — gaze engine: filters, fixation detection, target registry,
 * selection methods, the assembled pipeline, and (B2) calibration maths.
 * Pure TypeScript: no DOM, no Node, no timers of its own; time comes from
 * sample timestamps and the injected `Clock`. Contracts are in `contracts.ts`.
 */
export * from './contracts';
export * from './config';
export * from './filter';
export * from './fixation';
export * from './geometry';
export * from './targets';
export * from './selection';
export * from './pipeline';
export * from './testing';

/** Package name, for diagnostics. */
export const GAZE_PACKAGE = '@forsee/gaze';
