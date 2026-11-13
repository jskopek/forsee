import { encodeUtf8, MemoryFileSystem } from '@forsee/core';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importArchive } from './archive';
import { CURRENT_SCHEMA_VERSION } from './migrations';
import { fixture } from './test-helpers';

async function populated() {
  const f = fixture();
  const { store } = await f.open({ name: 'Sam' });
  await store.settings.save({ 'app.general': { locale: 'en-GB' } });
  await store.collection('layouts').write('mine', { id: 'mine' });
  await store.pluginData('community.x').set('k', [1, 2, 3]);
  await store.document('lm/user-counts.json').write({ a: 1 });
  await f.files.writeBytes('phrases/audio/hello.wav', Uint8Array.from([0, 1, 2, 250, 255]));
  await store.history.append([
    {
      schemaVersion: 1,
      kind: 'utterance',
      id: 'u1',
      deviceId: store.metadata.deviceId,
      hlc: '001763035200000-000000-dev',
      createdAt: Date.UTC(2026, 10, 13),
      sender: 'user',
      body: 'Grüße 👋',
    },
  ]);
  return { f, store };
}

async function snapshot(files: MemoryFileSystem): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await files.list(dir)) {
      const p = dir === '' ? e.name : `${dir}/${e.name}`;
      if (e.kind === 'directory') await walk(p);
      else out[p] = [...(await files.readBytes(p))];
    }
  };
  await walk('');
  return out;
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message: string },
  );

describe('export and import', () => {
  it('round-trips the whole profile through a standard zip', async () => {
    const { f, store } = await populated();
    const archive = await store.exportArchive();
    expect([...archive.slice(0, 2)]).toEqual([0x50, 0x4b]); // "PK"

    const names = Object.keys(unzipSync(archive)).sort();
    expect(names).toEqual([
      'history/2026-11.jsonl',
      'layouts/mine.json',
      'lm/user-counts.json',
      'phrases/audio/hello.wav',
      'plugins/community.x/data.json',
      'profile.json',
      'settings.json',
    ]);

    const target = new MemoryFileSystem();
    await importArchive(target, archive);
    expect(await snapshot(target)).toEqual(await snapshot(f.files));

    const reopened = await fixture().open({}, target);
    expect(reopened.created).toBe(false);
    expect(reopened.store.metadata).toEqual(store.metadata);
    expect((await reopened.store.history.listRecent(5)).map((r) => r.body)).toEqual(['Grüße 👋']);
  });

  it('is deterministic for an unchanged profile', async () => {
    const { store } = await populated();
    expect(await store.exportArchive()).toEqual(await store.exportArchive());
  });

  it('flushes pending writes before exporting', async () => {
    const f = fixture();
    const { store } = await f.open();
    void store.settings.save({ 'app.general': { locale: 'sv-SE' } });
    const files = unzipSync(await store.exportArchive());
    expect(files['settings.json']).toBeDefined();
  });

  it('refuses a non-empty target and leaves it untouched', async () => {
    const { store } = await populated();
    const archive = await store.exportArchive();
    const target = new MemoryFileSystem();
    await target.writeText('profile.json', '{"mine":true}');
    const before = await snapshot(target);
    expect(await errorOf(importArchive(target, archive))).toMatchObject({ code: 'not-empty' });
    expect(await snapshot(target)).toEqual(before);
  });

  it('replaces a non-empty target when asked, removing leftovers', async () => {
    const { f, store } = await populated();
    const archive = await store.exportArchive();
    const target = new MemoryFileSystem();
    await target.writeText('old/leftover.txt', 'x');
    await target.writeText('profile.json', '{}');
    await importArchive(target, archive, { overwrite: true });
    expect(await target.exists('old')).toBe(false);
    expect(await snapshot(target)).toEqual(await snapshot(f.files));
  });

  it('gives the import a new device id when asked', async () => {
    const { store } = await populated();
    const target = new MemoryFileSystem();
    await importArchive(target, await store.exportArchive(), { deviceId: 'new-device' });
    const profile = JSON.parse(await target.readText('profile.json')) as Record<string, unknown>;
    expect(profile.deviceId).toBe('new-device');
    expect(profile.id).toBe(store.metadata.id);
  });

  it('accepts archives recompressed by ordinary tools, including a wrapper folder', async () => {
    const { store } = await populated();
    const entries = unzipSync(await store.exportArchive());
    const wrapped = zipSync({
      ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [`My Profile/${k}`, v])),
      '__MACOSX/My Profile/._profile.json': encodeUtf8('junk'),
      'My Profile/.DS_Store': encodeUtf8('junk'),
    });
    const target = new MemoryFileSystem();
    await importArchive(target, wrapped);
    expect(Object.keys(await snapshot(target)).sort()).toEqual(Object.keys(entries).sort());
  });

  describe('validation before writing', () => {
    const profileJson = (extra: object = {}) =>
      encodeUtf8(
        JSON.stringify({
          schemaVersion: 1,
          id: 'i',
          name: 'n',
          deviceId: 'd',
          createdAt: 1,
          appVersion: '1',
          ...extra,
        }),
      );

    it.each([
      '../evil.txt',
      'a/../../evil.txt',
      '/etc/passwd',
      'a\\..\\evil',
      'C:/evil.txt',
      'a//b.json',
      'plugins/../../x',
    ])('rejects the zip-slip path %j and writes nothing', async (path) => {
      const archive = zipSync({ 'profile.json': profileJson(), [path]: encodeUtf8('x') });
      const target = new MemoryFileSystem();
      expect(await errorOf(importArchive(target, archive))).toMatchObject({
        code: 'invalid-archive',
      });
      expect(await snapshot(target)).toEqual({});
    });

    it('rejects an archive without profile.json', async () => {
      const target = new MemoryFileSystem();
      const archive = zipSync({ 'settings.json': encodeUtf8('{}') });
      expect(await errorOf(importArchive(target, archive))).toMatchObject({
        code: 'invalid-archive',
      });
      expect(await snapshot(target)).toEqual({});
    });

    it('rejects garbage and a bad profile.json', async () => {
      const target = new MemoryFileSystem();
      expect(await errorOf(importArchive(target, encodeUtf8('not a zip')))).toMatchObject({
        code: 'invalid-archive',
      });
      const bad = zipSync({ 'profile.json': encodeUtf8('{nope') });
      expect(await errorOf(importArchive(target, bad))).toMatchObject({ code: 'invalid-archive' });
      const noVersion = zipSync({ 'profile.json': encodeUtf8('{}') });
      expect(await errorOf(importArchive(target, noVersion))).toMatchObject({
        code: 'invalid-archive',
      });
      expect(await snapshot(target)).toEqual({});
    });

    it('rejects an archive from a newer schema', async () => {
      const target = new MemoryFileSystem();
      const archive = zipSync({
        'profile.json': profileJson({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
      });
      expect(await errorOf(importArchive(target, archive))).toMatchObject({ code: 'newer-schema' });
      expect(await snapshot(target)).toEqual({});
    });

    it('rejects paths that are both a file and a folder', async () => {
      const archive = zipSync({
        'profile.json': profileJson(),
        plugins: encodeUtf8('file'),
        'plugins/x/data.json': encodeUtf8('{}'),
      });
      const target = new MemoryFileSystem();
      expect(await errorOf(importArchive(target, archive))).toMatchObject({
        code: 'invalid-archive',
      });
      expect(await snapshot(target)).toEqual({});
    });

    it('enforces size and count limits before unpacking', async () => {
      const archive = zipSync({
        'profile.json': profileJson(),
        'big.bin': new Uint8Array(10_000),
        'b.json': encodeUtf8('{}'),
      });
      expect(
        await errorOf(importArchive(new MemoryFileSystem(), archive, { maxBytes: 1000 })),
      ).toMatchObject({
        code: 'invalid-archive',
      });
      expect(
        await errorOf(importArchive(new MemoryFileSystem(), archive, { maxFiles: 2 })),
      ).toMatchObject({
        code: 'invalid-archive',
      });
    });

    it('does not remove an existing profile when the archive is invalid', async () => {
      const target = new MemoryFileSystem();
      await target.writeText('profile.json', '{"keep":true}');
      const archive = zipSync({ 'profile.json': profileJson(), '../x': encodeUtf8('x') });
      await errorOf(importArchive(target, archive, { overwrite: true }));
      expect(await target.readText('profile.json')).toBe('{"keep":true}');
    });
  });
});
