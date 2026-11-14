import type { JsonValue, ValidationIssue } from '@forsee/plugin-api';
import type { DocumentCollection, DocumentOptions, JsonDocument } from './contracts';
import { StorageError } from './errors';
import type { FileStore } from './file-store';
import { assertSafePath, assertSafeSegment } from './paths';

function validated<T>(options: DocumentOptions<T>, value: unknown, where: string): T {
  if (!options.validate) return value as T;
  const result = options.validate(value);
  if (result.ok) return result.value;
  throw new StorageError('invalid-document', `${where} is invalid: ${summarise(result.issues)}`, {
    details: result.issues.map((i) => ({ path: i.path, message: i.message })),
  });
}

function summarise(issues: readonly ValidationIssue[]): string {
  const first = issues[0];
  if (!first) return 'unknown problem';
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return `${first.path === '' ? '/' : first.path}: ${first.message}${more}`;
}

/** One JSON file with an optional validation hook (user language data, for example). */
export function createJsonDocument<T>(
  store: FileStore,
  path: string,
  options: DocumentOptions<T> = {},
): JsonDocument<T> {
  assertSafePath(path);
  return {
    async read() {
      const raw = await store.getDocument(path);
      return raw === undefined ? undefined : validated(options, raw, path);
    },
    async write(value) {
      const checked = validated(options, value, path);
      await store.putDocument(path, checked as unknown as JsonValue);
    },
    async delete() {
      await store.deleteDocument(path);
    },
  };
}

/** A folder of `<name>.json` documents (user layouts, phrase sets). */
export function createDocumentCollection<T>(
  store: FileStore,
  directory: string,
  options: DocumentOptions<T> = {},
): DocumentCollection<T> {
  assertSafePath(directory);
  const pathOf = (name: string): string => {
    assertSafeSegment(name, 'document name');
    return `${directory}/${name}.json`;
  };
  const nameOf = (path: string): string => path.slice(directory.length + 1, -'.json'.length);

  const read = async (name: string): Promise<T | undefined> => {
    const path = pathOf(name);
    const raw = await store.getDocument(path);
    return raw === undefined ? undefined : validated(options, raw, path);
  };

  return {
    async list() {
      return (await store.listDocuments(directory)).map(nameOf).filter((n) => n !== '');
    },
    read,
    async readAll() {
      const result: { name: string; value: T }[] = [];
      for (const path of await store.listDocuments(directory)) {
        const name = nameOf(path);
        if (name === '') continue;
        try {
          const value = await read(name);
          if (value !== undefined) result.push({ name, value });
        } catch (error) {
          store.report(error, `storage.collection.invalid:${path}`);
        }
      }
      return result;
    },
    async write(name, value) {
      const path = pathOf(name);
      await store.putDocument(path, validated(options, value, path) as unknown as JsonValue);
    },
    async delete(name) {
      await store.deleteDocument(pathOf(name));
    },
  };
}
