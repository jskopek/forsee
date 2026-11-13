/**
 * @forsee/host — the platform boundary: the `HostBridge` interface, an
 * in-memory host for tests and a browser host. Real timers and
 * `crypto.randomUUID` live here (and in the desktop and mobile shells), never
 * in engine packages.
 */
export * from './bridge';
export * from './browser-files';
export * from './kv-files';
export * from './memory-host';
export * from './opfs-files';
export * from './web-host';

/** Package name, for diagnostics. */
export const HOST_PACKAGE = '@forsee/host';
