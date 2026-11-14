import { decodeUtf8, encodeUtf8, type ProfileFileSystem } from '@forsee/core';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { StorageError } from './errors';
import { assertSafePath } from './paths';
import { CURRENT_SCHEMA_VERSION, readSchemaVersion } from './migrations';

/**
 * Export and import of a whole profile as one zip file, so a user can open
 * it with ordinary tools. Zip support is the MIT-licensed `fflate`.
 */

/** Options for `importArchive`. */
export interface ImportOptions {
  /** Replace an existing profile instead of refusing. The UI must confirm first. */
  readonly overwrite?: boolean;
  /**
   * Give the imported profile this device id. Pass a fresh id when importing
   * onto a different device than the one that exported, so the two devices
   * never share an HLC device id.
   */
  readonly deviceId?: string;
  /** Upper limit on the total unpacked size. Default 512 MiB. */
  readonly maxBytes?: number;
  /** Upper limit on the number of files. Default 20,000. */
  readonly maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const MIN_ZIP_TIME = Date.UTC(1980, 0, 1);

/** Every file under the profile root, as `[path, bytes]`, sorted by path. */
async function readTree(files: ProfileFileSystem): Promise<[string, Uint8Array][]> {
  const found: [string, Uint8Array][] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await files.list(dir)) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.kind === 'directory') await walk(path);
      else found.push([path, await files.readBytes(path)]);
    }
  };
  await walk('');
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Zips every file of the profile. Callers should flush pending writes first
 * (`ProfileStore.exportArchive` does). Recordings (`phrases/audio/`) are
 * stored uncompressed; everything else is deflated. Entry times are the
 * given wall time, so the output is deterministic for a given profile.
 */
export async function exportProfile(
  files: ProfileFileSystem,
  wallNow: number,
): Promise<Uint8Array> {
  const zippable: Zippable = {};
  for (const [path, bytes] of await readTree(files)) {
    zippable[path] = path.startsWith('phrases/audio/') ? [bytes, { level: 0 }] : bytes;
  }
  return zipSync(zippable, { mtime: Math.max(wallNow, MIN_ZIP_TIME) });
}

function invalid(message: string, cause?: unknown): StorageError {
  return new StorageError('invalid-archive', message, cause === undefined ? undefined : { cause });
}

/** Decodes and checks an archive into `[path, bytes]` pairs without touching any file system. */
function unpack(archive: Uint8Array, options: ImportOptions): Map<string, Uint8Array> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  let totalBytes = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(archive, {
      filter(file) {
        // Runs before inflating, so a zip bomb is refused before it is unpacked.
        count += 1;
        totalBytes += file.originalSize;
        if (count > maxFiles) throw invalid(`Archive has more than ${maxFiles} files`);
        if (totalBytes > maxBytes) throw invalid('Archive is too large when unpacked');
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw invalid('Not a valid zip archive', cause);
  }

  // Drop folder entries and operating-system litter.
  const names = Object.keys(raw).filter(
    (name) =>
      !name.endsWith('/') &&
      !name.startsWith('__MACOSX/') &&
      !name.includes('/__MACOSX/') &&
      name.split('/').pop() !== '.DS_Store',
  );
  // Archives made by "Compress" in a file manager wrap everything in one folder.
  if (!names.includes('profile.json')) {
    const wrapper = names.find((n) => n.endsWith('/profile.json') && n.split('/').length === 2);
    if (wrapper) {
      const prefix = wrapper.slice(0, wrapper.length - 'profile.json'.length);
      if (names.every((n) => n.startsWith(prefix))) {
        const stripped = new Map(names.map((n) => [n, n.slice(prefix.length)]));
        const entries = new Map<string, Uint8Array>();
        for (const [name, inner] of stripped) entries.set(inner, raw[name]!);
        return validateEntries(entries);
      }
    }
  }
  const entries = new Map<string, Uint8Array>();
  for (const name of names) entries.set(name, raw[name]!);
  return validateEntries(entries);
}

function validateEntries(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const paths = new Set(entries.keys());
  for (const path of paths) {
    try {
      // Zip-slip: absolute paths, "..", backslashes, drive letters and empty segments are refused.
      assertSafePath(path);
    } catch (cause) {
      throw invalid(`Archive contains an unsafe path: ${JSON.stringify(path)}`, cause);
    }
    // A name cannot be both a file and a folder.
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      if (paths.has(segments.slice(0, i).join('/'))) {
        throw invalid(`Archive path conflicts with a file: ${JSON.stringify(path)}`);
      }
    }
  }
  return entries;
}

/**
 * Imports a profile archive made by `exportProfile`. Everything is decoded
 * and validated (safe paths, a readable `profile.json` whose schema is not
 * newer than this build's) before the first byte is written, and
 * `profile.json` is written last, so an interrupted import never looks like
 * a complete profile. Refuses (`not-empty`) a target that already has files
 * unless `options.overwrite` is set.
 *
 * Satisfies `ProfileImporter` (the options are optional).
 */
export async function importArchive(
  files: ProfileFileSystem,
  archive: Uint8Array,
  options: ImportOptions = {},
): Promise<void> {
  const entries = unpack(archive, options);

  const profileBytes = entries.get('profile.json');
  if (!profileBytes) throw invalid('Archive has no profile.json at its top level');
  let profile: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(profileBytes));
    readSchemaVersion(parsed);
    profile = parsed as Record<string, unknown>;
  } catch (cause) {
    throw invalid('profile.json in the archive is not valid', cause);
  }
  const version = readSchemaVersion(profile);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new StorageError(
      'newer-schema',
      `This archive uses schema version ${version}, but this version of Forsee only understands up to ${CURRENT_SCHEMA_VERSION}.`,
      { details: { found: version, supported: CURRENT_SCHEMA_VERSION } },
    );
  }
  if (options.deviceId !== undefined) {
    if (options.deviceId === '') throw new RangeError('deviceId must not be empty');
    entries.set(
      'profile.json',
      encodeUtf8(JSON.stringify({ ...profile, deviceId: options.deviceId }, null, 2) + '\n'),
    );
  }

  const existing = await files.list('');
  if (existing.length > 0) {
    if (!options.overwrite) {
      throw new StorageError(
        'not-empty',
        'The target already contains a profile; pass overwrite to replace it',
      );
    }
    for (const entry of existing) await files.delete(entry.name, { recursive: true });
  }

  const ordered = [...entries].filter(([path]) => path !== 'profile.json');
  for (const [path, bytes] of ordered) await files.writeBytes(path, bytes);
  await files.writeBytes('profile.json', entries.get('profile.json')!);
}
