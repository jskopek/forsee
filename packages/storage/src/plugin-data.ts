import type { JsonObject, JsonValue } from '@forsee/plugin-api';
import type { PluginDataStore } from './contracts';
import { StorageError } from './errors';
import type { FileStore } from './file-store';
import { assertPluginId } from './paths';

/** `plugins/<id>/data.json` of a plugin. */
export function pluginDataPath(pluginId: string): string {
  assertPluginId(pluginId);
  return `plugins/${pluginId}/data.json`;
}

interface PluginDataFile {
  readonly schemaVersion: 1;
  readonly values: JsonObject;
}

function readValues(document: JsonValue | undefined, path: string): JsonObject {
  if (document === undefined) return {};
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new StorageError('corrupt', `${path} is not an object`);
  }
  const values = (document as Record<string, JsonValue | undefined>).values;
  if (values === undefined) return {};
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new StorageError('corrupt', `${path}: "values" is not an object`);
  }
  return values as JsonObject;
}

function wrap(values: JsonObject): JsonValue {
  const file: PluginDataFile = { schemaVersion: 1, values };
  return file as unknown as JsonValue;
}

/**
 * Private key-value storage of one plugin, kept in `plugins/<id>/data.json`.
 * The id is validated, so a plugin cannot name a folder outside its own.
 * Concurrent `set` and `delete` calls are serialised (read-modify-write).
 */
export function createPluginDataStore(store: FileStore, pluginId: string): PluginDataStore {
  const path = pluginDataPath(pluginId);
  return {
    async get(key) {
      const values = readValues(await store.getDocument(path), path);
      return Object.hasOwn(values, key) ? values[key] : undefined;
    },
    async set(key, value) {
      if (typeof key !== 'string')
        throw new StorageError('invalid-document', 'Key must be a string');
      if ((value as JsonValue | undefined) === undefined) {
        throw new StorageError('invalid-document', 'Value must not be undefined; use delete');
      }
      await store.updateDocument(path, (current) =>
        wrap({ ...readValues(current, path), [key]: value }),
      );
    },
    async delete(key) {
      await store.updateDocument(path, (current) => {
        if (current === undefined) return undefined;
        const values = { ...readValues(current, path) };
        if (!Object.hasOwn(values, key)) return current;
        delete values[key];
        return wrap(values);
      });
    },
    async keys() {
      return Object.keys(readValues(await store.getDocument(path), path)).sort();
    },
  };
}
