import type { JsonValue, ProfileMetadata } from '@forsee/plugin-api';
import type { MigrationContext, ProfileMigration } from './contracts';
import { StorageError } from './errors';

/** Schema version this build reads and writes. */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Built-in migration chain, ordered by `from`. Version 0 is the shape the
 * plan described before `deviceId` and `appVersion` were added to
 * `profile.json`; it exists mainly as the worked example of the mechanism.
 *
 * To change the on-disk format: bump `CURRENT_SCHEMA_VERSION`, add a step
 * `{ from: N, to: N + 1 }` here, and add a test.
 */
export const PROFILE_MIGRATIONS: readonly ProfileMigration[] = [
  {
    from: 0,
    to: 1,
    name: '0-to-1: add device id and app version',
    run(profile, context) {
      return Promise.resolve({
        ...profile,
        // Idempotent: keep whatever an interrupted earlier run already set.
        deviceId: typeof profile.deviceId === 'string' ? profile.deviceId : context.newId(),
        appVersion:
          typeof profile.appVersion === 'string' ? profile.appVersion : context.appVersion,
        createdAt: typeof profile.createdAt === 'number' ? profile.createdAt : context.wallNow(),
        name: typeof profile.name === 'string' ? profile.name : 'Profile',
      });
    },
  },
];

/** Result of `runMigrations`. */
export interface MigrationOutcome {
  readonly profile: Record<string, unknown>;
  /** Names of the steps applied, in order. */
  readonly applied: readonly string[];
}

/**
 * Reads `schemaVersion` of a raw `profile.json`. Throws `invalid-profile` if
 * it is missing or not a non-negative integer.
 */
export function readSchemaVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StorageError('invalid-profile', 'profile.json is not an object');
  }
  const version = (raw as Record<string, unknown>).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new StorageError('invalid-profile', 'profile.json has no valid schemaVersion');
  }
  return version;
}

/**
 * Brings a raw profile up to `target`. Refuses (`newer-schema`) a profile
 * written by a newer schema before touching anything. Each step's result is
 * saved with `save` before the next step runs, so a crash resumes where it
 * stopped; steps are keyed by their `from` version, so running again on an
 * up-to-date profile applies nothing.
 */
export async function runMigrations(
  raw: unknown,
  migrations: readonly ProfileMigration[],
  target: number,
  context: MigrationContext,
  save: (profile: Record<string, unknown>) => Promise<void>,
): Promise<MigrationOutcome> {
  let version = readSchemaVersion(raw);
  if (version > target) {
    throw new StorageError(
      'newer-schema',
      `This profile uses schema version ${version}, but this version of Forsee only understands up to ${target}. Update Forsee to open it.`,
      { details: { found: version, supported: target } },
    );
  }
  let profile = { ...(raw as Record<string, unknown>) };
  const applied: string[] = [];
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step || step.to <= step.from || step.to > target) {
      throw new StorageError(
        'migration-failed',
        `No migration from schema version ${version} towards ${target}`,
      );
    }
    try {
      profile = { ...(await step.run(profile, context)), schemaVersion: step.to };
      await save(profile);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError('migration-failed', `Migration "${step.name}" failed`, { cause });
    }
    applied.push(step.name);
    version = step.to;
  }
  return { profile, applied };
}

/** Validates a migrated `profile.json` into `ProfileMetadata`. */
export function validateProfileMetadata(raw: Record<string, unknown>): ProfileMetadata {
  const str = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') {
      throw new StorageError(
        'invalid-profile',
        `profile.json: "${key}" must be a non-empty string`,
      );
    }
    return value;
  };
  const createdAt = raw.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw new StorageError('invalid-profile', 'profile.json: "createdAt" must be a number');
  }
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: str('id'),
    name: str('name'),
    deviceId: str('deviceId'),
    createdAt,
    appVersion: str('appVersion'),
  };
}

/** `ProfileMetadata` as a JSON document. */
export function metadataToJson(metadata: ProfileMetadata): JsonValue {
  return { ...metadata };
}
