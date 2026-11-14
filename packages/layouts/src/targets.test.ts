import type { LayoutDefinition } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { getBuiltinLayout } from './catalogue';
import { resolveKeyDwellClass } from './dwell';
import { computeGeometry } from './geometry';
import { createLayoutRuntime } from './runtime';
import { generateTargets, keyIdOfTarget, keyText, targetId, targetsForView } from './targets';

const BOUNDS = { x: 0, y: 0, width: 1200, height: 400 };
const OPTIONS = { gapPx: 4, edgeGrowthPx: 0 };

function qwerty(): LayoutDefinition {
  const layout = getBuiltinLayout('forsee/en-qwerty');
  if (!layout) throw new Error('missing built-in');
  return layout;
}

function page(layout: LayoutDefinition, id: string) {
  const found = layout.pages.find((p) => p.id === id);
  if (!found) throw new Error(`no page ${id}`);
  return found;
}

describe('generateTargets', () => {
  const layout = qwerty();
  const letters = page(layout, 'letters');
  const rects = computeGeometry(letters, BOUNDS, OPTIONS);
  const targets = generateTargets(layout.id, letters.id, rects);
  const byKey = (keyId: string) =>
    targets.find((t) => t.id === targetId(layout.id, 'letters', keyId));

  it('makes one target per key with ids <layoutId>/<pageId>/<keyId>', () => {
    expect(targets).toHaveLength(rects.length);
    expect(byKey('k-q')?.id).toBe('forsee/en-qwerty/letters/k-q');
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
  });

  it('copies the rectangle and label', () => {
    const q = rects.find((r) => r.key.id === 'k-q');
    expect(byKey('k-q')?.rect).toEqual(q?.rect);
    expect(byKey('k-q')?.label).toBe('q');
  });

  it('sets text for character keys only', () => {
    expect(byKey('k-q')?.text).toBe('q');
    expect(byKey('k-space')?.text).toBe(' ');
    expect(byKey('k-comma')?.text).toBe(',');
    expect(byKey('k-backspace')?.text).toBeUndefined();
    expect(byKey('k-shift')?.text).toBeUndefined();
  });

  it('classifies keys by what they do', () => {
    expect(byKey('k-q')?.dwellClass).toBe('letter');
    expect(byKey('k-space')?.dwellClass).toBe('letter');
    expect(byKey('k-shift')?.dwellClass).toBe('function');
    expect(byKey('k-undo')?.dwellClass).toBe('function');
    expect(byKey('k-backspace')?.dwellClass).toBe('function');
  });

  it('repeats only for escalate and repeat keys', () => {
    expect(byKey('k-backspace')?.afterActivate).toBe('repeat');
    expect(byKey('k-q')?.afterActivate).toBeUndefined();
    expect(byKey('k-clear')?.afterActivate).toBeUndefined();
  });

  it('carries no command, so the runtime stays in charge', () => {
    for (const t of targets) expect(t.command).toBeUndefined();
  });

  it('lets an explicit dwellClass win and flags repeat behaviours', () => {
    const custom = {
      id: 'x',
      rows: [
        {
          keys: [
            {
              id: 'slow-a',
              label: 'a',
              dwellClass: 'destructive' as const,
              action: { command: 'composition.insert', args: { text: 'a' } },
            },
            {
              id: 'rep',
              label: 'rep',
              behaviour: { type: 'repeat' as const },
              action: { command: 'composition.undo' },
            },
            {
              id: 'delword',
              label: 'dw',
              action: { command: 'composition.deleteWord' },
            },
            {
              id: 'icon-only',
              label: '',
              icon: 'x',
              action: { command: 'speech.stop' },
            },
          ],
        },
      ],
    };
    const out = generateTargets('l', 'p', computeGeometry(custom, BOUNDS, OPTIONS));
    expect(out.map((t) => t.dwellClass)).toEqual([
      'destructive',
      'function',
      'destructive',
      'function',
    ]);
    expect(out[1]?.afterActivate).toBe('repeat');
    expect(out[3]?.label).toBeUndefined();
    expect(out[0]?.text).toBe('a');
  });

  it('maps target ids back to key ids', () => {
    expect(keyIdOfTarget(layout.id, 'letters', 'forsee/en-qwerty/letters/k-q')).toBe('k-q');
    expect(keyIdOfTarget(layout.id, 'letters', 'other/letters/k-q')).toBeUndefined();
  });
});

describe('keyText and classes', () => {
  it('ignores insert keys without text and escalating keys', () => {
    expect(
      keyText({ id: 'a', label: 'a', action: { command: 'composition.insert' } }),
    ).toBeUndefined();
    expect(
      keyText({
        id: 'b',
        label: 'b',
        action: { command: 'composition.insert', args: { text: 'b' } },
        behaviour: { type: 'escalate', steps: [{ command: 'composition.clear' }] },
      }),
    ).toBeUndefined();
  });

  it('classifies a group of letters as letter, a mixed group as function', () => {
    const layout = getBuiltinLayout('forsee/en-coarse-groups');
    const main = layout?.pages[0];
    const groups = main?.rows.flatMap((r) => r.keys).filter((k) => k.group === true) ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(resolveKeyDwellClass(g)).toBe('letter');
    expect(
      resolveKeyDwellClass({
        id: 'm',
        label: 'm',
        group: true,
        keys: [
          { id: 'm1', label: '1', action: { command: 'composition.insert', args: { text: '1' } } },
          { id: 'm2', label: 'x', action: { command: 'composition.clear' } },
        ],
      }),
    ).toBe('function');
  });
});

describe('targetsForView', () => {
  it('follows the runtime view, including an open group with its back key', () => {
    const layout = getBuiltinLayout('forsee/en-coarse-groups');
    if (!layout) throw new Error('missing');
    const runtime = createLayoutRuntime(layout);
    const closed = targetsForView(runtime.view, BOUNDS, OPTIONS);
    expect(closed.targets.map((t) => t.id)).toContain('forsee/en-coarse-groups/main/grp-abcde');

    runtime.activate('grp-abcde', 0);
    const open = targetsForView(runtime.view, BOUNDS, OPTIONS);
    const ids = open.targets.map((t) => keyIdOfTarget(layout.id, 'main', t.id));
    expect(ids).toEqual(['k-a', 'k-b', 'k-c', 'k-d', 'k-e', '$back']);
    expect(open.targets.find((t) => t.text === 'c')?.label).toBe('C');
    // the group fills the same bounding area
    const right = Math.max(...open.targets.map((t) => t.rect.x + t.rect.width));
    const bottom = Math.max(...open.targets.map((t) => t.rect.y + t.rect.height));
    expect(right).toBe(BOUNDS.width);
    expect(bottom).toBe(BOUNDS.height);
  });
});
