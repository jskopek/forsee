import type {
  ExtensionChange,
  LayoutDefinition,
  OutputSink,
  RegionState,
} from '@forsee/plugin-api';
import { describe, expect, it, vi } from 'vitest';
import { ContextStore } from './context-store';
import { ExtensionRegistry } from './extensions';
import { RegionModel } from './regions';
import { FakeClock } from './testing';

const layout = (id: string): LayoutDefinition => ({
  schemaVersion: 1,
  id,
  name: id,
  family: 'precise',
  locale: 'en-GB',
  initialPage: 'p',
  pages: [{ id: 'p', name: 'Letters', rows: [] }],
});

const sink = (id: string): OutputSink => ({ id, name: id, send: () => Promise.resolve() });

describe('ExtensionRegistry', () => {
  it('registers, lists in order and looks up by id', () => {
    const registry = new ExtensionRegistry();
    registry.register('layouts', 'app', layout('qwerty'));
    registry.register('layouts', 'plugin.a', layout('plugin.a/abc'));
    registry.register('outputSinks', 'plugin.a', sink('plugin.a/share'));
    expect(registry.list('layouts').map((c) => [c.id, c.owner])).toEqual([
      ['qwerty', 'app'],
      ['plugin.a/abc', 'plugin.a'],
    ]);
    expect(registry.get('outputSinks', 'plugin.a/share')?.contribution.name).toBe('plugin.a/share');
    expect(registry.list('themes')).toEqual([]);
  });

  it('rejects duplicate ids within a point but allows the same id on another point', () => {
    const registry = new ExtensionRegistry();
    registry.register('layouts', 'a', layout('x'));
    expect(() => registry.register('layouts', 'b', layout('x'))).toThrow(
      expect.objectContaining({ code: 'duplicate' }),
    );
    expect(() => registry.register('outputSinks', 'b', sink('x'))).not.toThrow();
  });

  it('rejects unknown points and missing ids', () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.register('nope' as 'layouts', 'a', layout('x'))).toThrow(
      expect.objectContaining({ code: 'invalid-argument' }),
    );
    expect(() => registry.register('layouts', 'a', layout(''))).toThrow();
  });

  it('emits changes and disposes one registration or a whole owner', () => {
    const registry = new ExtensionRegistry();
    const changes: ExtensionChange[] = [];
    registry.events.on('changed', (c) => changes.push(c));
    const reg = registry.register('layouts', 'p', layout('p/1'));
    registry.register('layouts', 'p', layout('p/2'));
    registry.register('outputSinks', 'p', sink('p/s'));
    registry.register('layouts', 'other', layout('o/1'));
    reg.dispose();
    reg.dispose();
    expect(registry.listByOwner('p')).toHaveLength(2);
    expect(registry.disposeOwner('p')).toBe(2);
    expect(registry.list('layouts').map((c) => c.id)).toEqual(['o/1']);
    expect(changes.filter((c) => c.change === 'removed').map((c) => c.id)).toEqual([
      'p/1',
      'p/2',
      'p/s',
    ]);
  });

  it('a stale disposable does not remove a re-registered contribution', () => {
    const registry = new ExtensionRegistry();
    const first = registry.register('layouts', 'p', layout('x'));
    first.dispose();
    registry.register('layouts', 'p', layout('x'));
    first.dispose();
    expect(registry.list('layouts')).toHaveLength(1);
  });
});

describe('RegionModel', () => {
  it('starts with every region visible, normal and empty', () => {
    const model = new RegionModel();
    expect(model.list().map((r) => r.id)).toEqual([
      'composition',
      'quickfire',
      'predictions',
      'main',
      'side',
    ]);
    expect(model.get('side')).toEqual({
      id: 'side',
      panels: [],
      activePanel: null,
      visible: true,
      size: 'normal',
    });
  });

  it('assigns panels, activates the first, and moves panels between regions', () => {
    const model = new RegionModel();
    const changes: RegionState[] = [];
    model.events.on('changed', (s) => changes.push(s));
    model.assignPanel('side', 'a/phrases');
    model.assignPanel('side', 'b/history');
    model.assignPanel('side', 'c/first', 0);
    expect(model.get('side').panels).toEqual(['c/first', 'a/phrases', 'b/history']);
    expect(model.get('side').activePanel).toBe('a/phrases');
    model.assignPanel('main', 'a/phrases');
    expect(model.regionOf('a/phrases')).toBe('main');
    expect(model.get('side')).toMatchObject({
      panels: ['c/first', 'b/history'],
      activePanel: 'b/history',
    });
    expect(model.get('main').activePanel).toBe('a/phrases');
    expect(changes.length).toBeGreaterThan(0);
  });

  it('removes panels and picks a new active panel', () => {
    const model = new RegionModel();
    model.assignPanel('side', 'x');
    model.assignPanel('side', 'y');
    expect(model.removePanel('x')).toBe(true);
    expect(model.get('side').activePanel).toBe('y');
    expect(model.removePanel('y')).toBe(true);
    expect(model.get('side').activePanel).toBeNull();
    expect(model.removePanel('y')).toBe(false);
  });

  it('sets active panel, visibility and size, without events when unchanged', () => {
    const model = new RegionModel();
    const changed = vi.fn();
    model.events.on('changed', changed);
    model.assignPanel('side', 'x');
    model.assignPanel('side', 'y');
    model.setActivePanel('side', 'y');
    expect(() => model.setActivePanel('side', 'z')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    model.setVisible('side', false);
    model.setVisible('side', false);
    model.setSize('side', 'expanded');
    expect(model.stepSize('side', 1)).toBe('expanded');
    expect(model.stepSize('side', -1)).toBe('normal');
    expect(model.stepSize('side', -1)).toBe('compact');
    expect(model.stepSize('side', -1)).toBe('compact');
    expect(() => model.setSize('side', 'huge' as 'normal')).toThrow();
    expect(changed).toHaveBeenCalledTimes(7);
  });

  it('snapshots and restores, tolerating malformed data', () => {
    const model = new RegionModel();
    model.assignPanel('side', 'x');
    model.setSize('main', 'expanded');
    const snap = JSON.parse(JSON.stringify(model.snapshot())) as unknown;
    const other = new RegionModel();
    expect(other.restore(snap)).toBe(true);
    expect(other.list()).toEqual(model.list());
    expect(other.restore({ version: 2 })).toBe(false);
    expect(other.restore(null)).toBe(false);
    expect(
      other.restore({
        version: 1,
        regions: [
          { id: 'side', panels: ['a', 'a', 3], activePanel: 'zzz', size: 'giant', visible: 'no' },
          { id: 'bogus' },
          'junk',
        ],
      }),
    ).toBe(true);
    expect(other.get('side')).toEqual({
      id: 'side',
      panels: ['a'],
      activePanel: 'a',
      visible: true,
      size: 'normal',
    });
  });
});

describe('ContextStore', () => {
  it('sets entries with source and time, and lists by prefix', () => {
    const clock = new FakeClock({ wall: 1000 });
    const store = new ContextStore({ clock });
    store.set('plugin.time', { key: 'time.partOfDay', value: 'evening' });
    store.set('app', { key: 'time', value: 1 });
    store.set('plugin.people', { key: 'people.present', value: ['Sam'], confidence: 0.6 });
    expect(store.get('time.partOfDay')).toEqual({
      key: 'time.partOfDay',
      value: 'evening',
      source: 'plugin.time',
      updatedAt: 1000,
    });
    expect(store.list('time').map((e) => e.key)).toEqual(['time', 'time.partOfDay']);
    expect(store.list().map((e) => e.key)).toEqual(['people.present', 'time', 'time.partOfDay']);
    expect(store.list('tim')).toEqual([]);
  });

  it('hides expired entries and prunes them with events', () => {
    const clock = new FakeClock({ wall: 0 });
    const store = new ContextStore({ clock });
    const changes = vi.fn();
    store.events.on('changed', changes);
    store.set('p', { key: 'a', value: 1, ttlMs: 100 });
    expect(store.get('a')?.expiresAt).toBe(100);
    clock.advance(99);
    expect(store.get('a')).toBeDefined();
    clock.advance(1);
    expect(store.get('a')).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.prune()).toBe(1);
    expect(changes).toHaveBeenLastCalledWith({ key: 'a', entry: null });
  });

  it('validates input', () => {
    const store = new ContextStore({ clock: new FakeClock() });
    expect(() => store.set('p', { key: 'bad key', value: 1 })).toThrow();
    expect(() => store.set('p', { key: '.a', value: 1 })).toThrow();
    expect(() => store.set('p', { key: 'a', value: 1, ttlMs: 0 })).toThrow();
    expect(() => store.set('p', { key: 'a', value: 1, confidence: 2 })).toThrow();
  });

  it('deletes by key, guarded by source, and by source', () => {
    const store = new ContextStore({ clock: new FakeClock() });
    store.set('p1', { key: 'a', value: 1 });
    store.set('p1', { key: 'b', value: 1 });
    store.set('p2', { key: 'c', value: 1 });
    expect(store.delete('a', 'p2')).toBe(false);
    expect(store.delete('a', 'p1')).toBe(true);
    expect(store.delete('a')).toBe(false);
    expect(store.deleteBySource('p1')).toBe(1);
    expect(store.list().map((e) => e.key)).toEqual(['c']);
  });
});
