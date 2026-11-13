import { isForseeError } from '@forsee/core';
import type { LayoutDefinition } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { getBuiltinLayout } from './catalogue';
import type { LayoutView } from './contracts';
import { createLayoutRuntime, groupRows } from './runtime';
import { validateLayout } from './validator';

const insert = (text: string) => ({ command: 'composition.insert', args: { text } });

const LAYOUT: LayoutDefinition = (() => {
  const result = validateLayout({
    schemaVersion: 1,
    id: 'test/rt',
    name: 'Runtime test',
    family: 'coarse',
    locale: 'en',
    initialPage: 'main',
    pages: [
      {
        id: 'main',
        name: 'Main',
        rows: [
          {
            keys: [
              {
                id: 'abc',
                label: 'ABC',
                group: true,
                keys: [
                  { id: 'a', label: 'a', action: insert('a') },
                  { id: 'b', label: 'b', action: insert('b') },
                  { id: 'c', label: 'c', action: insert('c'), returnToPage: 'other' },
                ],
              },
              { id: 'plain', label: 'x', action: insert('x') },
              {
                id: 'go',
                label: 'go',
                action: { command: 'layout.showPage', args: { page: 'other' } },
              },
              {
                id: 'del',
                label: 'Delete',
                action: { command: 'composition.deleteGrapheme' },
                behaviour: {
                  type: 'escalate',
                  steps: [
                    { command: 'composition.deleteGrapheme' },
                    { command: 'composition.deleteWord' },
                    { command: 'composition.clear' },
                  ],
                  stepDwellClasses: ['function', 'destructive'],
                },
              },
              {
                id: 'rep',
                label: 'Rep',
                action: { command: 'composition.undo' },
                behaviour: { type: 'repeat' },
              },
              {
                id: 'shift',
                label: 'Shift',
                action: { command: 'layout.showPage', args: { page: 'upper' } },
              },
            ],
          },
        ],
      },
      {
        id: 'other',
        name: 'Other',
        rows: [
          {
            keys: [
              {
                id: 'home',
                label: 'home',
                action: { command: 'layout.showPage', args: { page: 'main' } },
              },
              { id: 'o1', label: '1', action: insert('1') },
            ],
          },
        ],
      },
      {
        id: 'upper',
        name: 'Upper',
        rows: [
          {
            keys: [{ id: 'A', label: 'A', returnToPage: 'main', action: insert('A') }],
          },
        ],
      },
    ],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
})();

function make() {
  const runtime = createLayoutRuntime(LAYOUT);
  const views: LayoutView[] = [];
  runtime.onDidChangeView((v) => views.push(v));
  return { runtime, views };
}

describe('LayoutRuntime pages', () => {
  it('starts on the initial page with no group open', () => {
    const { runtime } = make();
    expect(runtime.view.pageId).toBe('main');
    expect(runtime.view.openGroup).toBeNull();
    expect(runtime.view.layoutId).toBe('test/rt');
    expect(runtime.view.rows).toBe(LAYOUT.pages[0]?.rows);
  });

  it('switches page with a layout.showPage key and returns null (nothing to execute)', () => {
    const { runtime, views } = make();
    expect(runtime.activate('go', 0)).toBeNull();
    expect(runtime.view.pageId).toBe('other');
    expect(views).toHaveLength(1);
    expect(views[0]?.pageId).toBe('other');
  });

  it('switches page by method and rejects unknown pages', () => {
    const { runtime, views } = make();
    runtime.showPage('upper');
    expect(runtime.view.pageId).toBe('upper');
    runtime.showPage('upper');
    expect(views).toHaveLength(1);
    try {
      runtime.showPage('missing');
      expect.unreachable();
    } catch (error) {
      expect(isForseeError(error, 'invalid-argument')).toBe(true);
    }
    expect(runtime.view.pageId).toBe('upper');
  });

  it('returns to the page named by returnToPage after the key fires (one-shot shift)', () => {
    const { runtime } = make();
    expect(runtime.activate('shift', 0)).toBeNull();
    expect(runtime.view.pageId).toBe('upper');
    expect(runtime.activate('A', 0)).toEqual(insert('A'));
    expect(runtime.view.pageId).toBe('main');
  });

  it('stays on the page for keys without returnToPage and does not emit', () => {
    const { runtime, views } = make();
    expect(runtime.activate('plain', 0)).toEqual(insert('x'));
    expect(runtime.view.pageId).toBe('main');
    expect(views).toHaveLength(0);
  });

  it('back() without a group goes to the initial page', () => {
    const { runtime } = make();
    runtime.showPage('other');
    runtime.back();
    expect(runtime.view.pageId).toBe('main');
  });

  it('ignores activations of keys that are not visible', () => {
    const { runtime, views } = make();
    expect(runtime.activate('o1', 0)).toBeNull();
    expect(runtime.activate('nonexistent', 0)).toBeNull();
    expect(views).toHaveLength(0);
  });

  it('stops notifying after the subscription is disposed and isolates listener errors', () => {
    const errors: unknown[] = [];
    const runtime = createLayoutRuntime(LAYOUT, { onListenerError: (e) => errors.push(e) });
    const seen: string[] = [];
    runtime.onDidChangeView(() => {
      throw new Error('boom');
    });
    const sub = runtime.onDidChangeView((v) => seen.push(v.pageId));
    runtime.showPage('other');
    sub.dispose();
    runtime.showPage('main');
    expect(seen).toEqual(['other']);
    expect(errors).toHaveLength(2);
  });
});

describe('LayoutRuntime group keys', () => {
  it('opens a group with its keys plus an automatic back key, in the same view slot', () => {
    const { runtime, views } = make();
    expect(runtime.activate('abc', 0)).toBeNull();
    expect(runtime.view.openGroup?.id).toBe('abc');
    expect(runtime.view.pageId).toBe('main');
    const ids = runtime.view.rows.flatMap((r) =>
      r.keys.filter((k) => k.spacer !== true).map((k) => k.id),
    );
    expect(ids).toEqual(['a', 'b', 'c', '$back']);
    expect(views).toHaveLength(1);
  });

  it('returns to the page after a sub-key is selected, and returns that key action', () => {
    const { runtime, views } = make();
    runtime.activate('abc', 0);
    expect(runtime.activate('b', 0)).toEqual(insert('b'));
    expect(runtime.view.openGroup).toBeNull();
    expect(runtime.view.pageId).toBe('main');
    expect(views).toHaveLength(2);
  });

  it('applies the sub-key returnToPage and emits once', () => {
    const { runtime, views } = make();
    runtime.activate('abc', 0);
    expect(runtime.activate('c', 0)).toEqual(insert('c'));
    expect(runtime.view.pageId).toBe('other');
    expect(runtime.view.openGroup).toBeNull();
    expect(views).toHaveLength(2);
  });

  it('the back key closes the group without an action', () => {
    const { runtime } = make();
    runtime.activate('abc', 0);
    expect(runtime.activate('$back', 0)).toBeNull();
    expect(runtime.view.openGroup).toBeNull();
    expect(runtime.view.pageId).toBe('main');
  });

  it('back() and showPage() close an open group', () => {
    const { runtime } = make();
    runtime.activate('abc', 0);
    runtime.back();
    expect(runtime.view.openGroup).toBeNull();
    runtime.activate('abc', 0);
    runtime.showPage('other');
    expect(runtime.view.openGroup).toBeNull();
    expect(runtime.view.pageId).toBe('other');
  });

  it('ignores page keys while a group is open', () => {
    const { runtime } = make();
    runtime.activate('abc', 0);
    expect(runtime.activate('plain', 0)).toBeNull();
    expect(runtime.view.openGroup?.id).toBe('abc');
  });

  it('arranges group keys by columns, padding the last row with spacers', () => {
    const group = LAYOUT.pages[0]?.rows[0]?.keys[0];
    if (group?.group !== true) throw new Error('no group');
    // 3 keys + back = 4 items: default columns = ceil(sqrt(4)) = 2
    const rows = groupRows(group);
    expect(rows.map((r) => r.keys.length)).toEqual([2, 2]);
    const wide = groupRows({ ...group, columns: 3 });
    expect(wide.map((r) => r.keys.length)).toEqual([3, 3]);
    expect(wide[1]?.keys.filter((k) => k.spacer === true)).toHaveLength(2);
    const one = groupRows({ ...group, columns: 1 });
    expect(one.map((r) => r.keys.length)).toEqual([1, 1, 1, 1]);
  });

  it('works on the built-in coarse layout end to end', () => {
    const layout = getBuiltinLayout('forsee/en-coarse-groups');
    if (!layout) throw new Error('missing');
    const runtime = createLayoutRuntime(layout);
    runtime.activate('grp-wxyz', 0);
    expect(runtime.activate('k-y', 0)).toEqual(insert('y'));
    expect(runtime.view.openGroup).toBeNull();
  });
});

describe('LayoutRuntime key behaviours', () => {
  it('escalate picks the step for repeatIndex 0, 1, 2 and clamps at the last', () => {
    const { runtime } = make();
    expect(runtime.activate('del', 0)).toEqual({ command: 'composition.deleteGrapheme' });
    expect(runtime.activate('del', 1)).toEqual({ command: 'composition.deleteWord' });
    expect(runtime.activate('del', 2)).toEqual({ command: 'composition.clear' });
    expect(runtime.activate('del', 3)).toEqual({ command: 'composition.clear' });
    expect(runtime.activate('del', 99)).toEqual({ command: 'composition.clear' });
  });

  it('treats a bad repeatIndex as 0', () => {
    const { runtime } = make();
    expect(runtime.activate('del', -4)).toEqual({ command: 'composition.deleteGrapheme' });
    expect(runtime.activate('del', Number.NaN)).toEqual({ command: 'composition.deleteGrapheme' });
    expect(runtime.activate('del', 1.9)).toEqual({ command: 'composition.deleteWord' });
  });

  it('reports per-step dwell classes, falling back to the key class', () => {
    const { runtime } = make();
    expect(runtime.dwellClassFor('del', 0)).toBe('function');
    expect(runtime.dwellClassFor('del', 1)).toBe('destructive');
    // only two classes given for three steps: the third falls back to the key's class
    expect(runtime.dwellClassFor('del', 2)).toBe('function');
    expect(runtime.dwellClassFor('del', 7)).toBe('function');
    expect(runtime.dwellClassFor('plain', 0)).toBe('letter');
    expect(runtime.dwellClassFor('abc', 0)).toBe('letter');
    expect(runtime.dwellClassFor('$back', 0)).toBe('function');
    expect(runtime.dwellClassFor('a', 0)).toBe('letter');
  });

  it('throws for dwellClassFor of an unknown key', () => {
    const { runtime } = make();
    expect(() => runtime.dwellClassFor('nope', 0)).toThrow();
  });

  it('repeat keys fire their action every time', () => {
    const { runtime } = make();
    for (const i of [0, 1, 2, 5])
      expect(runtime.activate('rep', i)).toEqual({ command: 'composition.undo' });
  });

  it('single keys fire only the first time', () => {
    const { runtime } = make();
    expect(runtime.activate('plain', 0)).toEqual(insert('x'));
    expect(runtime.activate('plain', 1)).toBeNull();
  });

  it('the built-in backspace escalates from letter to word to clear', () => {
    const layout = getBuiltinLayout('forsee/en-qwerty');
    if (!layout) throw new Error('missing');
    const runtime = createLayoutRuntime(layout);
    expect(runtime.activate('k-backspace', 0)?.command).toBe('composition.deleteGrapheme');
    expect(runtime.activate('k-backspace', 1)?.command).toBe('composition.deleteWord');
    expect(runtime.activate('k-backspace', 2)?.command).toBe('composition.clear');
    expect(runtime.dwellClassFor('k-backspace', 2)).toBe('destructive');
  });

  it('the built-in qwerty shift is one-shot and caps lock latches', () => {
    const layout = getBuiltinLayout('forsee/en-qwerty');
    if (!layout) throw new Error('missing');
    const runtime = createLayoutRuntime(layout);
    runtime.activate('k-shift', 0);
    expect(runtime.view.pageId).toBe('upper');
    expect(runtime.activate('u-q', 0)).toEqual(insert('Q'));
    expect(runtime.view.pageId).toBe('letters');

    runtime.activate('k-shift', 0);
    runtime.activate('u-caps', 0);
    expect(runtime.view.pageId).toBe('caps');
    expect(runtime.activate('c-q', 0)).toEqual(insert('Q'));
    expect(runtime.view.pageId).toBe('caps');
    runtime.activate('c-shift', 0);
    expect(runtime.view.pageId).toBe('letters');
  });
});
