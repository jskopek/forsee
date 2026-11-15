import { BUILTIN_COMMAND_IDS } from '@forsee/plugin-api';
import type { LayoutDefinition, LayoutKey } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LAYOUTS,
  builtinCatalogue,
  createLayoutCatalogue,
  getBuiltinLayout,
  listLayouts,
  pickDefaultLayout,
} from './catalogue';
import deQwertz from '../layouts/de-qwertz.json';
import enAlphabetical from '../layouts/en-alphabetical.json';
import enCoarse from '../layouts/en-coarse-groups.json';
import enQwerty from '../layouts/en-qwerty.json';
import { createLayoutRuntime } from './runtime';
import { targetsForView } from './targets';
import { COARSE_MAX_TARGETS, validateLayout } from './validator';

const ALLOWED_COMMANDS = new Set<string>([...BUILTIN_COMMAND_IDS, 'layout.showPage']);

function allKeys(layout: LayoutDefinition): LayoutKey[] {
  const out: LayoutKey[] = [];
  for (const page of layout.pages) {
    for (const row of page.rows) {
      for (const key of row.keys) {
        out.push(key);
        if (key.group === true) out.push(...key.keys);
      }
    }
  }
  return out;
}

function commandsOf(key: LayoutKey): string[] {
  if (key.spacer === true || key.group === true) return [];
  const commands = [key.action.command];
  if (key.behaviour?.type === 'escalate')
    commands.push(...key.behaviour.steps.map((s) => s.command));
  return commands;
}

function targetCount(layout: LayoutDefinition, pageId: string): number {
  const page = layout.pages.find((p) => p.id === pageId);
  return (page?.rows ?? []).flatMap((r) => r.keys).filter((k) => k.spacer !== true).length;
}

describe('built-in layouts', () => {
  it('ship the expected set', () => {
    expect(BUILTIN_LAYOUTS.map((l) => l.id)).toEqual([
      'forsee/en-qwerty',
      'forsee/en-alphabetical',
      'forsee/de-qwertz',
      'forsee/en-coarse-groups',
    ]);
    expect(new Set(BUILTIN_LAYOUTS.map((l) => l.id)).size).toBe(BUILTIN_LAYOUTS.length);
  });

  it('are exactly the published JSON files (minus the $schema pointer)', () => {
    const files = [enQwerty, enAlphabetical, deQwertz, enCoarse];
    files.forEach((file, i) => {
      const { $schema, ...rest } = file as Record<string, unknown>;
      expect($schema).toBe('./layout.schema.json');
      expect(BUILTIN_LAYOUTS[i]).toEqual(rest);
    });
  });

  it.each(BUILTIN_LAYOUTS.map((l) => [l.id, l] as const))('%s validates', (_id, layout) => {
    expect(validateLayout(layout).ok).toBe(true);
  });

  it('only use built-in commands and layout.showPage', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      for (const key of allKeys(layout)) {
        for (const command of commandsOf(key)) {
          expect(ALLOWED_COMMANDS.has(command), `${layout.id}/${key.id}: ${command}`).toBe(true);
        }
      }
    }
  });

  it('type characters with composition.insert { text } and speak with composition.speak', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      const keys = allKeys(layout).filter((k) => k.spacer !== true && k.group !== true);
      for (const key of keys) {
        if (key.spacer === true || key.group === true) continue;
        if (key.action.command === 'composition.insert') {
          expect(Object.keys(key.action.args ?? {})).toEqual(['text']);
          expect(typeof key.action.args?.text).toBe('string');
        }
      }
      // Speak and Clear are not keyboard keys: Speak is in the app's control
      // bar, and holding Delete clears.
      const chrome = keys.filter(
        (k) =>
          k.spacer !== true &&
          k.group !== true &&
          (k.action.command === 'composition.speak' || k.action.command === 'composition.clear'),
      );
      expect(chrome, layout.id).toEqual([]);
      // `speech.speak` needs text; a key bound to it without text would fail.
      const bare = keys.filter(
        (k) =>
          k.spacer !== true &&
          k.group !== true &&
          k.action.command === 'speech.speak' &&
          typeof k.action.args?.text !== 'string',
      );
      expect(bare, layout.id).toEqual([]);
    }
  });

  it('give every layout a delete key that escalates letter, word, clear', () => {
    for (const layout of BUILTIN_LAYOUTS) {
      const deletes = allKeys(layout).filter(
        (k) => k.spacer !== true && k.group !== true && k.behaviour?.type === 'escalate',
      );
      expect(deletes.length, layout.id).toBeGreaterThan(0);
      for (const key of deletes) {
        if (key.spacer === true || key.group === true || key.behaviour?.type !== 'escalate')
          continue;
        expect(key.behaviour.steps.map((s) => s.command)).toEqual([
          'composition.deleteGrapheme',
          'composition.deleteWord',
          'composition.clear',
        ]);
        expect(key.behaviour.stepDwellClasses).toEqual(['function', 'destructive', 'destructive']);
      }
    }
  });

  it('share an identical numbers and punctuation page across the precise layouts', () => {
    const precise = BUILTIN_LAYOUTS.filter((l) => l.family === 'precise');
    expect(precise.length).toBeGreaterThanOrEqual(3);
    const pages = precise.map((l) => l.pages.find((p) => p.id === 'numbers'));
    for (const page of pages) expect(page).toBeDefined();
    for (const page of pages) expect(page).toEqual(pages[0]);
    // reachable from the letters page of each, and back again
    for (const layout of precise) {
      const runtime = createLayoutRuntime(layout);
      const toNumbers = allKeys(layout).find(
        (k) => k.spacer !== true && k.group !== true && k.action.args?.page === 'numbers',
      );
      expect(toNumbers, layout.id).toBeDefined();
      runtime.activate(toNumbers?.id ?? '', 0);
      expect(runtime.view.pageId).toBe('numbers');
      runtime.activate('n-letters', 0);
      expect(runtime.view.pageId).toBe('letters');
    }
  });

  it('cover the letters of their language (including the extra German ones)', () => {
    const typed = (layout: LayoutDefinition) =>
      new Set(
        allKeys(layout).flatMap((k) =>
          k.spacer === true || k.group === true
            ? []
            : [typeof k.action.args?.text === 'string' ? k.action.args.text : ''],
        ),
      );
    for (const id of ['forsee/en-qwerty', 'forsee/en-alphabetical', 'forsee/en-coarse-groups']) {
      const letters = typed(getBuiltinLayout(id)!);
      for (const c of 'abcdefghijklmnopqrstuvwxyz')
        expect(letters.has(c), `${id}: ${c}`).toBe(true);
    }
    const de = typed(getBuiltinLayout('forsee/de-qwertz')!);
    for (const c of 'abcdefghijklmnopqrstuvwxyzäöüß') expect(de.has(c), c).toBe(true);
    expect(de.has('Ä')).toBe(true);
    expect(getBuiltinLayout('forsee/de-qwertz')?.locale).toBe('de-DE');
  });

  it('keeps coarse layouts to 12 targets on every screen, groups included', () => {
    const coarse = BUILTIN_LAYOUTS.filter((l) => l.family === 'coarse');
    expect(coarse.length).toBeGreaterThan(0);
    const bounds = { x: 0, y: 0, width: 1000, height: 600 };
    for (const layout of coarse) {
      for (const page of layout.pages) {
        expect(targetCount(layout, page.id)).toBeLessThanOrEqual(COARSE_MAX_TARGETS);
        const runtime = createLayoutRuntime(layout);
        runtime.showPage(page.id);
        const groups = page.rows.flatMap((r) => r.keys).filter((k) => k.group === true);
        for (const group of groups) {
          runtime.showPage(page.id);
          runtime.activate(group.id, 0);
          const { targets } = targetsForView(runtime.view, bounds, { gapPx: 8, edgeGrowthPx: 0 });
          expect(targets.length, group.id).toBeLessThanOrEqual(COARSE_MAX_TARGETS);
        }
      }
    }
  });

  it('keeps precise layouts to about 30 to 40 targets per page', () => {
    for (const layout of BUILTIN_LAYOUTS.filter((l) => l.family === 'precise')) {
      for (const page of layout.pages) {
        const n = targetCount(layout, page.id);
        expect(n, `${layout.id}/${page.id}`).toBeGreaterThanOrEqual(25);
        expect(n, `${layout.id}/${page.id}`).toBeLessThanOrEqual(40);
      }
    }
  });
});

describe('catalogue', () => {
  it('lists by family and locale', () => {
    expect(listLayouts(BUILTIN_LAYOUTS, { family: 'coarse' }).map((l) => l.id)).toEqual([
      'forsee/en-coarse-groups',
    ]);
    expect(listLayouts(BUILTIN_LAYOUTS, { locale: 'de' }).map((l) => l.id)).toEqual([
      'forsee/de-qwertz',
    ]);
    expect(
      listLayouts(BUILTIN_LAYOUTS, { locale: 'de-AT', family: 'precise' }).map((l) => l.id),
    ).toEqual(['forsee/de-qwertz']);
    expect(listLayouts(BUILTIN_LAYOUTS, { locale: 'en-GB', family: 'precise' })).toHaveLength(2);
    expect(listLayouts(BUILTIN_LAYOUTS)).toHaveLength(BUILTIN_LAYOUTS.length);
  });

  it('picks defaults with fallbacks', () => {
    expect(builtinCatalogue.defaultFor('precise', 'en').id).toBe('forsee/en-qwerty');
    expect(builtinCatalogue.defaultFor('precise', 'en-GB').id).toBe('forsee/en-qwerty');
    expect(builtinCatalogue.defaultFor('precise', 'de-DE').id).toBe('forsee/de-qwertz');
    expect(builtinCatalogue.defaultFor('precise', 'DE_de').id).toBe('forsee/de-qwertz');
    expect(builtinCatalogue.defaultFor('precise', 'de').id).toBe('forsee/de-qwertz');
    // no French layout: fall back to English
    expect(builtinCatalogue.defaultFor('precise', 'fr-FR').id).toBe('forsee/en-qwerty');
    // no German coarse layout: fall back to English coarse
    expect(builtinCatalogue.defaultFor('coarse', 'de-DE').id).toBe('forsee/en-coarse-groups');
    expect(builtinCatalogue.defaultFor('coarse', 'en').id).toBe('forsee/en-coarse-groups');
  });

  it('falls back to any layout of the family, then any layout, and throws when empty', () => {
    const de = getBuiltinLayout('forsee/de-qwertz')!;
    expect(pickDefaultLayout([de], 'precise', 'fr').id).toBe(de.id);
    expect(pickDefaultLayout([de], 'coarse', 'fr').id).toBe(de.id);
    expect(() => pickDefaultLayout([], 'precise', 'en')).toThrow();
    expect(createLayoutCatalogue([de]).defaultFor('precise', 'en').id).toBe(de.id);
  });

  it('looks up built-ins by id', () => {
    expect(getBuiltinLayout('forsee/en-qwerty')?.name).toBe('English QWERTY');
    expect(getBuiltinLayout('forsee/nope')).toBeUndefined();
  });
});
