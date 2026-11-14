import { expect, it } from 'vitest';
import {
  createPluginApi,
  createPluginHost,
  invokeApiMethod,
  PLUGIN_HOST_PACKAGE,
  PLUGIN_MANIFEST_JSON_SCHEMA,
  PluginPermissionManager,
  trustTierOf,
  validateManifest,
  type ManifestValidator,
  type PluginApiFactory,
  type TrustTierOf,
} from './index';
import * as testing from './testing';

it('exports its package name', () => {
  expect(PLUGIN_HOST_PACKAGE).toBe('@forsee/plugin-host');
});

it('implements the B9 contracts', () => {
  const validator: ManifestValidator = validateManifest;
  const tier: TrustTierOf = trustTierOf;
  const factory: PluginApiFactory = createPluginApi;
  for (const value of [validator, tier, factory, createPluginHost, invokeApiMethod]) {
    expect(typeof value).toBe('function');
  }
  expect(PluginPermissionManager).toBeTypeOf('function');
  expect(PLUGIN_MANIFEST_JSON_SCHEMA.type).toBe('object');
});

it('ships test doubles in the testing entry', () => {
  expect(Object.keys(testing).sort()).toEqual(
    [
      'MemoryConsentStorage',
      'MemoryInstallStorage',
      'MemoryPluginFiles',
      'ScriptedConsentPrompt',
      'createMemoryPluginStorage',
      'createTestPluginApi',
      'testLayout',
      'testLayoutValidator',
      'testManifest',
    ].sort(),
  );
});
