import { validateLayout } from '@forsee/layouts';
import { validateManifest } from '@forsee/plugin-host';
import { createTestPluginApi } from '@forsee/plugin-host/testing';
import { describe, expect, it, vi } from 'vitest';
import manifestJson from '../manifest.json';
import {
  keyboardLayoutId,
  KEYBOARDS_PLUGIN_ID,
  KEYBOARDS_SETTING_FIELDS,
  keyboardsModule,
  manifest,
  migrateLayoutId,
  showSettingKey,
  STANDARD_LAYOUTS,
} from './index';

async function activate() {
  const test = await createTestPluginApi({
    manifest,
    origin: 'first-party',
    services: { validateLayout },
  });
  await keyboardsModule.activate(test.api);
  return test;
}

const ALL = ['en-qwerty', 'en-alphabetical', 'de-qwertz', 'en-coarse-groups'];

describe('forsee.keyboards', () => {
  it('has a manifest the real validator accepts as first-party, needing no permission', () => {
    const result = validateManifest(manifestJson, { firstParty: true });
    expect(result.ok).toBe(true);
    expect(manifest.permissions).toEqual([]);
  });

  it('offers the standard layouts under its own id', async () => {
    const { kernel } = await activate();
    const layouts = kernel.extensions.list('layouts');
    expect(layouts.map((l) => l.id)).toEqual(ALL.map(keyboardLayoutId));
    expect(layouts.every((l) => l.owner === KEYBOARDS_PLUGIN_ID)).toBe(true);
    expect(layouts[0]?.contribution.id).toBe('forsee.keyboards/en-qwerty');
    expect(STANDARD_LAYOUTS.map((l) => l.family)).toEqual([
      'precise',
      'precise',
      'precise',
      'coarse',
    ]);
  });

  it('has one setting per layout, all on', async () => {
    const { kernel } = await activate();
    expect(KEYBOARDS_SETTING_FIELDS.map((f) => f.key)).toEqual(ALL.map(showSettingKey));
    expect(Object.values(kernel.settings.getAll(KEYBOARDS_PLUGIN_ID))).toEqual(ALL.map(() => true));
  });

  it('withdraws a layout switched off, keeping the others registered as they were', async () => {
    const { kernel } = await activate();
    const qwerty = kernel.extensions.list('layouts')[0]?.contribution;
    kernel.settings.set(KEYBOARDS_PLUGIN_ID, showSettingKey('de-qwertz'), false);
    await vi.waitFor(() =>
      expect(kernel.extensions.list('layouts').map((l) => l.id)).not.toContain(
        keyboardLayoutId('de-qwertz'),
      ),
    );
    // Untouched layouts are the same registrations (no flicker of the active one).
    expect(kernel.extensions.list('layouts')[0]?.contribution).toBe(qwerty);

    kernel.settings.set(KEYBOARDS_PLUGIN_ID, showSettingKey('de-qwertz'), true);
    await vi.waitFor(() => expect(kernel.extensions.list('layouts')).toHaveLength(4));
  });

  it('offers nothing when every layout is off (the app falls back)', async () => {
    const { kernel } = await activate();
    for (const id of ALL) kernel.settings.set(KEYBOARDS_PLUGIN_ID, showSettingKey(id), false);
    await vi.waitFor(() => expect(kernel.extensions.list('layouts')).toEqual([]));
  });

  it('maps the old built-in ids to the plugin ids', () => {
    expect(migrateLayoutId('forsee/en-coarse-groups')).toBe('forsee.keyboards/en-coarse-groups');
    expect(migrateLayoutId('forsee.keyboards/en-qwerty')).toBe('forsee.keyboards/en-qwerty');
    expect(migrateLayoutId('someone.else/dvorak')).toBe('someone.else/dvorak');
  });
});
