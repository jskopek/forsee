import type { KernelOptions } from '@forsee/core';
import type { PrivateStorageApi } from '@forsee/plugin-api';
import { expect, expectTypeOf, it } from 'vitest';
import { PROFILE_PATHS, STORAGE_PACKAGE, type PluginDataStore, type ProfileStore } from './index';

it('exports its package name and profile paths', () => {
  expect(STORAGE_PACKAGE).toBe('@forsee/storage');
  expect(PROFILE_PATHS.compositionSnapshot).toBe('state/composition.json');
});

it('plugs into the kernel and the plugin API', () => {
  type Persistence = NonNullable<KernelOptions['persistence']>;
  expectTypeOf<ProfileStore['settings']>().toExtend<NonNullable<Persistence['settings']>>();
  expectTypeOf<ProfileStore['history']>().toExtend<NonNullable<Persistence['conversation']>>();
  expectTypeOf<ProfileStore['composition']>().toExtend<NonNullable<Persistence['composition']>>();
  expectTypeOf<PluginDataStore>().toExtend<PrivateStorageApi>();
});
