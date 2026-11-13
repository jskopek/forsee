import type { ValidationResult } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { fixture } from './test-helpers';

interface Layout {
  readonly id: string;
  readonly rows: number;
}

function validateLayout(value: unknown): ValidationResult<Layout> {
  const v = value as Partial<Layout> | null;
  if (typeof v?.id === 'string' && typeof v.rows === 'number') {
    return { ok: true, value: { id: v.id, rows: v.rows } };
  }
  return { ok: false, issues: [{ path: '/rows', message: 'rows must be a number' }] };
}

describe('plugin private storage', () => {
  it('gets, sets, deletes and lists keys', async () => {
    const f = fixture();
    const { store } = await f.open();
    const data = store.pluginData('community.phrases');
    expect(await data.get('a')).toBeUndefined();
    expect(await data.keys()).toEqual([]);
    await data.set('b', { n: [1, 2] });
    await data.set('a', 'x');
    await data.set('a', 'y');
    expect(await data.get('a')).toBe('y');
    expect(await data.get('b')).toEqual({ n: [1, 2] });
    expect(await data.keys()).toEqual(['a', 'b']);
    await data.delete('a');
    await data.delete('missing');
    expect(await data.keys()).toEqual(['b']);
    expect(JSON.parse(await f.files.readText('plugins/community.phrases/data.json'))).toEqual({
      schemaVersion: 1,
      values: { b: { n: [1, 2] } },
    });
  });

  it('isolates plugins from each other', async () => {
    const { store } = await fixture().open();
    const a = store.pluginData('plugin-a');
    const b = store.pluginData('plugin-b');
    await a.set('k', 'from a');
    expect(await b.get('k')).toBeUndefined();
    await b.set('k', 'from b');
    expect(await a.get('k')).toBe('from a');
  });

  it('loses no updates under concurrency', async () => {
    const { store } = await fixture().open();
    const data = store.pluginData('p');
    await Promise.all(Array.from({ length: 20 }, (_, i) => data.set(`k${i}`, i)));
    expect(await data.keys()).toHaveLength(20);
  });

  it('handles keys that look like object internals', async () => {
    const { store } = await fixture().open();
    const data = store.pluginData('p');
    expect(await data.get('__proto__')).toBeUndefined();
    expect(await data.get('constructor')).toBeUndefined();
    await data.set('__proto__', 1);
    expect(await data.get('__proto__')).toBe(1);
    expect(await data.keys()).toEqual(['__proto__']);
  });

  it.each(['..', '../../profile', 'a/b', '/abs', 'a\\b', '', 'UPPER', '.hidden', 'a..b'])(
    'refuses the plugin id %j',
    async (id) => {
      const f = fixture();
      const { store } = await f.open();
      expect(() => store.pluginData(id)).toThrow(/plugin id/);
      expect(await f.files.exists('plugins')).toBe(false);
    },
  );

  it('does not write outside the plugin folder', async () => {
    const f = fixture();
    const { store } = await f.open();
    await store.pluginData('safe').set('../../profile.json', 'x');
    const profile = JSON.parse(await f.files.readText('profile.json')) as { name: string };
    expect(profile.name).toBe('Profile');
    expect((await f.files.list('plugins')).map((e) => e.name)).toEqual(['safe']);
  });

  it('rejects undefined values and reports corrupt data', async () => {
    const f = fixture();
    const { store } = await f.open();
    const data = store.pluginData('p');
    await expect(data.set('k', undefined as never)).rejects.toMatchObject({
      code: 'invalid-document',
    });
    await f.files.writeText('plugins/p/data.json', '[]');
    await expect(data.get('k')).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('document helpers', () => {
  it('reads, writes, lists and deletes a collection with validation', async () => {
    const f = fixture();
    const { store } = await f.open();
    const layouts = store.collection('layouts', { validate: validateLayout });
    expect(await layouts.list()).toEqual([]);
    expect(await layouts.read('mine')).toBeUndefined();
    await layouts.write('mine', { id: 'mine', rows: 4 });
    await layouts.write('another one', { id: 'x', rows: 2 });
    expect(await layouts.list()).toEqual(['another one', 'mine']);
    expect(await layouts.read('mine')).toEqual({ id: 'mine', rows: 4 });
    expect(await f.files.exists('layouts/mine.json')).toBe(true);
    await layouts.delete('mine');
    await layouts.delete('mine');
    expect(await layouts.list()).toEqual(['another one']);
  });

  it('rejects invalid documents on write and on read, and skips them in readAll', async () => {
    const f = fixture();
    const { store } = await f.open();
    const layouts = store.collection('layouts', { validate: validateLayout });
    await expect(layouts.write('bad', { id: 'x', rows: 'many' } as never)).rejects.toMatchObject({
      code: 'invalid-document',
    });
    expect(await f.files.exists('layouts/bad.json')).toBe(false);

    await layouts.write('good', { id: 'g', rows: 1 });
    await f.files.writeText('layouts/hand-edited.json', '{"id":"h"}');
    await f.files.writeText('layouts/broken.json', '{');
    await expect(layouts.read('hand-edited')).rejects.toMatchObject({ code: 'invalid-document' });
    expect(await layouts.readAll()).toEqual([{ name: 'good', value: { id: 'g', rows: 1 } }]);
    expect(f.errors.map((e) => e.context).sort()).toEqual([
      'storage.collection.invalid:layouts/broken.json',
      'storage.collection.invalid:layouts/hand-edited.json',
    ]);
  });

  it('rejects unsafe document names and directories', async () => {
    const f = fixture();
    const { store } = await f.open();
    const phrases = store.collection('phrases');
    for (const name of ['../profile', '..', 'a/b', '', 'a\\b', '/x']) {
      await expect(phrases.write(name, 1)).rejects.toMatchObject({ code: 'invalid-path' });
      await expect(phrases.read(name)).rejects.toMatchObject({ code: 'invalid-path' });
      await expect(phrases.delete(name)).rejects.toMatchObject({ code: 'invalid-path' });
    }
    expect(() => store.collection('../up')).toThrow();
    expect(() => store.collection('/abs')).toThrow();
    expect(() => store.document('../x.json')).toThrow();
  });

  it('stores a single document such as the user language data', async () => {
    const f = fixture();
    const { store } = await f.open();
    const counts = store.document<{ words: Record<string, number> }>('lm/user-counts.json');
    expect(await counts.read()).toBeUndefined();
    await counts.write({ words: { hello: 3 } });
    expect(await counts.read()).toEqual({ words: { hello: 3 } });
    expect(JSON.parse(await f.files.readText('lm/user-counts.json'))).toEqual({
      words: { hello: 3 },
    });
    await counts.delete();
    expect(await counts.read()).toBeUndefined();
  });
});
