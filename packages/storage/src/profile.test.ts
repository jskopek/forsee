import {
  createKernel,
  FakeClock,
  MemoryFileSystem,
  SequentialIdSource,
  type Kernel,
} from '@forsee/core';
import { describe, expect, it } from 'vitest';
import type { ProfileMigration } from './contracts';
import { isStorageError } from './errors';
import { CURRENT_SCHEMA_VERSION, PROFILE_MIGRATIONS, runMigrations } from './migrations';
import { fixture } from './test-helpers';

describe('openProfile', () => {
  it('creates a profile on first run and opens the same one afterwards', async () => {
    const f = fixture();
    const first = await f.open({ name: 'Sam' });
    expect(first.created).toBe(true);
    expect(first.migrations).toEqual([]);
    expect(first.store.metadata).toEqual({
      schemaVersion: 1,
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Sam',
      deviceId: '00000000-0000-4000-8000-000000000002',
      createdAt: Date.UTC(2026, 10, 13, 12),
      appVersion: '1.0.0',
    });
    expect(JSON.parse(await f.files.readText('profile.json'))).toEqual(first.store.metadata);

    const second = await f.open({ name: 'Ignored' });
    expect(second.created).toBe(false);
    expect(second.store.metadata).toEqual(first.store.metadata);
  });

  it('defaults the name and records the app version that opened it last', async () => {
    const f = fixture();
    const first = await f.open();
    expect(first.store.metadata.name).toBe('Profile');
    const upgraded = await f.open({ appVersion: '1.1.0' });
    expect(upgraded.store.metadata.appVersion).toBe('1.1.0');
    expect(upgraded.store.metadata.id).toBe(first.store.metadata.id);
    expect(
      (JSON.parse(await f.files.readText('profile.json')) as { appVersion: string }).appVersion,
    ).toBe('1.1.0');
  });

  it.each([
    ['not json', '{oops'],
    ['not an object', '[1]'],
    ['no schema version', '{"id":"a"}'],
    ['negative version', '{"schemaVersion":-1}'],
    ['fractional version', '{"schemaVersion":1.5}'],
    ['missing id', '{"schemaVersion":1,"name":"n","deviceId":"d","createdAt":1,"appVersion":"1"}'],
    [
      'empty device id',
      '{"schemaVersion":1,"id":"i","name":"n","deviceId":"","createdAt":1,"appVersion":"1"}',
    ],
  ])('rejects an invalid profile.json (%s)', async (_label, content) => {
    const f = fixture();
    await f.files.writeText('profile.json', content);
    const error = await f.open().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isStorageError(error, 'invalid-profile')).toBe(true);
  });
});

describe('migrations', () => {
  it('upgrades a version 0 profile and is idempotent', async () => {
    const f = fixture();
    await f.files.writeText('profile.json', JSON.stringify({ schemaVersion: 0, id: 'p-1' }));
    const opened = await f.open({ name: 'x' });
    expect(opened.created).toBe(false);
    expect(opened.migrations).toEqual([PROFILE_MIGRATIONS[0]!.name]);
    expect(opened.store.metadata).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'p-1',
      name: 'Profile',
      appVersion: '1.0.0',
    });
    const saved = JSON.parse(await f.files.readText('profile.json')) as { deviceId: string };
    expect(saved.deviceId).toBe(opened.store.metadata.deviceId);

    const again = await f.open();
    expect(again.migrations).toEqual([]);
    expect(again.store.metadata).toEqual(opened.store.metadata);
  });

  it('keeps fields an interrupted earlier run already set', async () => {
    const f = fixture();
    await f.files.writeText(
      'profile.json',
      JSON.stringify({ schemaVersion: 0, id: 'p', deviceId: 'keep-me', name: 'N', createdAt: 5 }),
    );
    const opened = await f.open();
    expect(opened.store.metadata).toMatchObject({ deviceId: 'keep-me', name: 'N', createdAt: 5 });
  });

  it('refuses a profile from a newer schema and leaves it untouched', async () => {
    const f = fixture();
    const content = JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1, id: 'future' });
    await f.files.writeText('profile.json', content);
    const error = await f.open().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isStorageError(error, 'newer-schema')).toBe(true);
    expect((error as Error).message).toMatch(/Update Forsee/);
    expect(await f.files.readText('profile.json')).toBe(content);
  });

  describe('runMigrations', () => {
    const ctx = (files: MemoryFileSystem) => ({
      files,
      newId: () => 'id',
      wallNow: () => 0,
      appVersion: '1',
    });
    const step = (from: number, calls: string[]): ProfileMigration => ({
      from,
      to: from + 1,
      name: `${from}-to-${from + 1}`,
      run(profile) {
        calls.push(`${from}`);
        return Promise.resolve({ ...profile, [`step${from}`]: true });
      },
    });

    it('applies ordered steps, saving after each', async () => {
      const files = new MemoryFileSystem();
      const calls: string[] = [];
      const saved: number[] = [];
      const result = await runMigrations(
        { schemaVersion: 1 },
        [step(2, calls), step(1, calls), step(3, calls)],
        4,
        ctx(files),
        (p) => {
          saved.push(p.schemaVersion as number);
          return Promise.resolve();
        },
      );
      expect(calls).toEqual(['1', '2', '3']);
      expect(saved).toEqual([2, 3, 4]);
      expect(result.profile).toMatchObject({ schemaVersion: 4, step1: true, step3: true });
      expect(result.applied).toEqual(['1-to-2', '2-to-3', '3-to-4']);
    });

    it('resumes from a partially migrated profile', async () => {
      const calls: string[] = [];
      await runMigrations(
        { schemaVersion: 2 },
        [step(1, calls), step(2, calls)],
        3,
        ctx(new MemoryFileSystem()),
        () => Promise.resolve(),
      );
      expect(calls).toEqual(['2']);
    });

    it('fails clearly on a gap in the chain', async () => {
      const error = await runMigrations(
        { schemaVersion: 1 },
        [step(2, [])],
        3,
        ctx(new MemoryFileSystem()),
        () => Promise.resolve(),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isStorageError(error, 'migration-failed')).toBe(true);
    });

    it('wraps a failing step', async () => {
      const failing: ProfileMigration = {
        from: 0,
        to: 1,
        name: 'bad',
        run: () => Promise.reject(new Error('nope')),
      };
      const error = await runMigrations(
        { schemaVersion: 0 },
        [failing],
        1,
        ctx(new MemoryFileSystem()),
        () => Promise.resolve(),
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isStorageError(error, 'migration-failed')).toBe(true);
      expect((error as Error).cause).toBeInstanceOf(Error);
    });
  });
});

describe('kernel adapters', () => {
  it('round-trips settings through settings.json', async () => {
    const f = fixture();
    const { store } = await f.open();
    expect(await store.settings.load()).toEqual({});
    await store.settings.save({ 'app.general': { locale: 'fr-FR' }, 'community.x': { n: 3 } });
    expect(JSON.parse(await f.files.readText('settings.json'))).toEqual({
      version: 1,
      values: { 'app.general': { locale: 'fr-FR' }, 'community.x': { n: 3 } },
    });
    expect(await store.settings.load()).toEqual({
      'app.general': { locale: 'fr-FR' },
      'community.x': { n: 3 },
    });
  });

  it('rejects a settings file of the wrong shape', async () => {
    const f = fixture();
    const { store } = await f.open();
    await f.files.writeText('settings.json', '[]');
    await expect(store.settings.load()).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('round-trips the composition snapshot and tolerates a torn file', async () => {
    const f = fixture();
    const { store } = await f.open();
    expect(await store.composition.load()).toBeUndefined();
    await store.composition.save({ version: 1, text: 'hello wor', savedAt: 42 });
    expect(await store.composition.load()).toEqual({ version: 1, text: 'hello wor', savedAt: 42 });
    await f.files.writeText('state/composition.json', '{"version":1,"te');
    expect(await store.composition.load()).toBeUndefined();
    expect(f.errors.map((e) => e.context)).toEqual([
      'storage.composition.corrupt:state/composition.json',
    ]);
  });

  it('restores kernel state after dispose and re-create', async () => {
    const f = fixture();
    const make = async (): Promise<{ kernel: Kernel; flush: () => Promise<void> }> => {
      const { store } = await f.open();
      const kernel = createKernel({
        clock: new FakeClock({ wall: f.clock.wallNow() }),
        ids: new SequentialIdSource(1000),
        deviceId: store.metadata.deviceId,
        reportError: f.reportError,
        persistence: {
          settings: store.settings,
          conversation: store.history,
          composition: store.composition,
        },
      });
      await kernel.start();
      return { kernel, flush: () => store.flush() };
    };

    const first = await make();
    first.kernel.settings.set('app.general', 'locale', 'de-DE');
    await first.kernel.commands.execute('composition.insert', { text: 'Guten Mor' });
    first.kernel.conversation.append({ body: 'Guten Tag' });
    first.kernel.conversation.append({ body: 'Auf Wiedersehen' });
    await first.kernel.flush();
    await first.flush();
    first.kernel.dispose();

    const second = await make();
    expect(second.kernel.locale).toBe('de-DE');
    expect(second.kernel.composition.text).toBe('Guten Mor');
    expect(second.kernel.conversation.listRecent(10).map((r) => r.body)).toEqual([
      'Guten Tag',
      'Auf Wiedersehen',
    ]);
    // A new record sorts after the restored ones.
    const next = second.kernel.conversation.append({ body: 'Danke' });
    expect(second.kernel.conversation.listRecent(10).at(-1)).toBe(next);
    second.kernel.dispose();
    expect(f.errors).toEqual([]);
  });
});
