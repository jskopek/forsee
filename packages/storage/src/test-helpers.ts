import {
  FakeClock,
  MemoryFileSystem,
  SequentialIdSource,
  type ErrorReporter,
  type ProfileFileSystem,
} from '@forsee/core';
import type { OpenProfileResult, OpenProfileOptions } from './contracts';
import { openProfile } from './profile';

/** Shared fixtures for the storage tests (not exported from the package). */
export interface Fixture {
  readonly files: MemoryFileSystem;
  readonly clock: FakeClock;
  readonly ids: SequentialIdSource;
  readonly errors: { readonly error: unknown; readonly context: string }[];
  readonly reportError: ErrorReporter;
  open(
    overrides?: Partial<OpenProfileOptions>,
    files?: ProfileFileSystem,
  ): Promise<OpenProfileResult>;
}

export function fixture(wall = Date.UTC(2026, 10, 13, 12)): Fixture {
  const files = new MemoryFileSystem();
  const clock = new FakeClock({ wall });
  const ids = new SequentialIdSource();
  const errors: { error: unknown; context: string }[] = [];
  const reportError: ErrorReporter = (error, context) => {
    errors.push({ error, context });
  };
  return {
    files,
    clock,
    ids,
    errors,
    reportError,
    open: (overrides = {}, target = files) =>
      openProfile(target, {
        appVersion: '1.0.0',
        newId: () => ids.uuid(),
        wallNow: () => clock.wallNow(),
        reportError,
        ...overrides,
      }),
  };
}
