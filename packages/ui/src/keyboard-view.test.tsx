// @vitest-environment jsdom
import { DEFAULT_DWELL_CONFIG } from '@forsee/gaze';
import { getBuiltinLayout, isSpacer, targetId } from '@forsee/layouts';
import type { Rect, TargetDescriptor } from '@forsee/plugin-api';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyboardView, fitFontPx, keyAppearance } from './keyboard-view';
import { createTestHost, renderWithHost, rectsByName, type TestHost } from './testing';

const BOX: Rect = { x: 0, y: 200, width: 1000, height: 600 };
const PLAIN_DWELL = {
  ...DEFAULT_DWELL_CONFIG,
  adaptive: { ...DEFAULT_DWELL_CONFIG.adaptive, enabled: false },
};

let hosts: TestHost[] = [];
afterEach(() => {
  cleanup();
  for (const host of hosts) host.dispose();
  hosts = [];
});

function setup(layoutId: string, options: { gaze?: boolean; prediction?: boolean } = {}) {
  const layout = getBuiltinLayout(layoutId);
  if (!layout) throw new Error(layoutId);
  let renders = 0;
  const host = createTestHost({
    layout,
    dwell: PLAIN_DWELL,
    gaze: options.gaze ?? true,
    prediction: options.prediction ?? false,
    measure: rectsByName({ keyboard: BOX }),
  });
  hosts.push(host);
  const result = renderWithHost(
    <Profiler id="keyboard" onRender={() => (renders += 1)}>
      <KeyboardView runtime={host.runtime} />
    </Profiler>,
    { host },
  );
  return { ...result, host, renders: () => renders };
}

function keyTargets(host: TestHost): TargetDescriptor[] {
  const layoutId = host.runtime.view.layoutId;
  return host.registry.list().filter((t) => t.id.startsWith(`${layoutId}/`));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectTiling(targets: readonly TargetDescriptor[], box: Rect): void {
  for (const t of targets) {
    expect(t.rect.x).toBeGreaterThanOrEqual(box.x);
    expect(t.rect.y).toBeGreaterThanOrEqual(box.y);
    expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(box.x + box.width);
    expect(t.rect.y + t.rect.height).toBeLessThanOrEqual(box.y + box.height);
    expect(t.rect.width).toBeGreaterThan(40);
    expect(t.rect.height).toBeGreaterThan(40);
  }
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      expect(
        overlaps(targets[i]!.rect, targets[j]!.rect),
        `${targets[i]!.id} / ${targets[j]!.id}`,
      ).toBe(false);
    }
  }
  const left = Math.min(...targets.map((t) => t.rect.x));
  const right = Math.max(...targets.map((t) => t.rect.x + t.rect.width));
  const top = Math.min(...targets.map((t) => t.rect.y));
  const bottom = Math.max(...targets.map((t) => t.rect.y + t.rect.height));
  expect([left, right, top, bottom]).toEqual([box.x, box.x + box.width, box.y, box.y + box.height]);
}

describe('KeyboardView with QWERTY', () => {
  it('registers one target per key, tiling the measured box, drawn where registered', () => {
    const { host, container } = setup('forsee/en-qwerty');
    const page = host.runtime.definition.pages.find((p) => p.id === 'letters')!;
    const keyCount = page.rows.flatMap((r) => r.keys).filter((k) => !isSpacer(k)).length;
    const targets = keyTargets(host);
    expect(targets).toHaveLength(keyCount);
    expectTiling(targets, BOX);

    const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-target-id]');
    expect(buttons).toHaveLength(keyCount);
    for (const button of buttons) {
      const target = host.registry.get(button.dataset.targetId ?? '')!;
      expect(button.style.left).toBe(`${target.rect.x - BOX.x}px`);
      expect(button.style.top).toBe(`${target.rect.y - BOX.y}px`);
      expect(button.style.width).toBe(`${target.rect.width}px`);
      expect(button.style.height).toBe(`${target.rect.height}px`);
    }
    // Letter keys type text (for key distributions); no key carries a command.
    expect(host.registry.get(targetId('forsee/en-qwerty', 'letters', 'k-h'))).toMatchObject({
      text: 'h',
      dwellClass: 'letter',
    });
    expect(targets.every((t) => t.command === undefined)).toBe(true);
    // Icons for icon keys, text labels for the rest.
    const backspace = screen.getByRole('button', { name: 'Delete' });
    expect(backspace.querySelector('svg[data-icon="backspace"]')).not.toBeNull();
  });

  it('re-registers all keys in one batch on a page change and on resize', async () => {
    const { host } = setup('forsee/en-qwerty');
    let notifications = 0;
    host.registry.onDidChange(() => (notifications += 1));
    fireEvent.click(screen.getByRole('button', { name: 'Shift' }));
    await host.advance(0);
    expect(host.runtime.view.pageId).toBe('upper');
    expect(notifications).toBe(1);
    expect(keyTargets(host).every((t) => t.id.startsWith('forsee/en-qwerty/upper/'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'H' }));
    await host.advance(0);
    expect(host.kernel.composition.text).toBe('H');
    expect(host.runtime.view.pageId).toBe('letters'); // returnToPage

    notifications = 0;
    const bigger: Rect = { x: 0, y: 100, width: 1200, height: 700 };
    host.dom.measureByName = rectsByName({ keyboard: bigger });
    act(() => host.dom.notify());
    expect(notifications).toBe(1);
    expectTiling(keyTargets(host), bigger);
  });

  it('dwell types a letter through the activation adapter, with a distribution', async () => {
    const { host } = setup('forsee/en-qwerty');
    const h = host.centreOf(targetId('forsee/en-qwerty', 'letters', 'k-h'));
    await host.dwellAt(h, PLAIN_DWELL.classMs.letter + 100);
    expect(host.kernel.composition.text).toBe('h');
    const step = host.kernel.composition.state.partialWordSteps[0];
    expect(step?.distribution?.entries[0]).toMatchObject({ text: 'h' });
  });

  it('escalating backspace shows and arms the next step while gaze stays', async () => {
    const { host } = setup('forsee/en-qwerty');
    await act(() =>
      host.kernel.commands.execute('composition.insert', { text: 'hello big world' }),
    );
    const id = targetId('forsee/en-qwerty', 'letters', 'k-backspace');
    const centre = host.centreOf(id);
    const { function: functionMs } = PLAIN_DWELL.classMs;
    await host.dwellAt(centre, functionMs + 50);
    expect(host.kernel.composition.text).toBe('hello big worl');
    expect(host.registry.get(id)?.dwellClass).toBe('destructive');
    expect(screen.getByRole('button', { name: 'Delete word' })).toBeTruthy();

    await host.advance(PLAIN_DWELL.repeatIntervalMs);
    expect(host.kernel.composition.text).toBe('hello big ');
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy();

    await host.dwellAt({ x: 500, y: 50 }, 100);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(host.registry.get(id)?.dwellClass).toBe('function');
  });

  it('a gaze sample does not re-render the keyboard', async () => {
    const { host, renders } = setup('forsee/en-qwerty');
    const before = renders();
    const a = host.centreOf(targetId('forsee/en-qwerty', 'letters', 'k-a'));
    const l = host.centreOf(targetId('forsee/en-qwerty', 'letters', 'k-l'));
    await host.dwellAt(a, 300);
    await host.dwellAt(l, 300);
    await host.dwellAt({ x: a.x + 10, y: a.y }, 300);
    expect(renders()).toBe(before);
    expect(host.kernel.composition.text).toBe('');
  });

  it('registers the layout commands for its runtime', async () => {
    const { host } = setup('forsee/en-qwerty');
    await act(() => host.kernel.commands.execute('layout.showPage', { page: 'numbers' }));
    expect(host.runtime.view.pageId).toBe('numbers');
    expect(keyTargets(host).every((t) => t.id.startsWith('forsee/en-qwerty/numbers/'))).toBe(true);
    await act(() => host.kernel.commands.execute('layout.back'));
    expect(host.runtime.view.pageId).toBe('letters');
  });
});

describe('KeyboardView with the coarse layout', () => {
  it('opens a group, types a letter and returns, by click without a pipeline', async () => {
    const { host } = setup('forsee/en-coarse-groups', { gaze: false });
    expect(screen.getAllByRole('button')).toHaveLength(11);
    fireEvent.click(screen.getByRole('button', { name: 'ABCDE' }));
    expect(host.runtime.view.openGroup?.id).toBe('grp-abcde');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'Back',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'C' }));
    await host.advance(0);
    expect(host.kernel.composition.text).toBe('c');
    expect(host.runtime.view.openGroup).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(11);
  });

  it('registers the group view as targets that tile the box', async () => {
    const { host } = setup('forsee/en-coarse-groups');
    expect(keyTargets(host)).toHaveLength(11);
    expectTiling(keyTargets(host), BOX);
    await host.dwellAt(
      host.centreOf(targetId('forsee/en-coarse-groups', 'main', 'grp-klmn')),
      PLAIN_DWELL.classMs.letter + 100,
    );
    expect(host.runtime.view.openGroup?.id).toBe('grp-klmn');
    const open = keyTargets(host);
    expect(open.map((t) => t.label)).toEqual(['K', 'L', 'M', 'N', 'Back']);
    await host.dwellAt(
      host.centreOf(targetId('forsee/en-coarse-groups', 'main', '$back')),
      PLAIN_DWELL.classMs.function + 100,
    );
    expect(host.runtime.view.openGroup).toBeNull();
    expect(keyTargets(host)).toHaveLength(11);
    expect(host.kernel.composition.text).toBe('');
  });
});

describe('KeyboardView adaptive dwell', () => {
  it('sets letter likelihoods from the prediction session, one batch per keystroke', async () => {
    const { host } = setup('forsee/en-qwerty', { prediction: true });
    const e = targetId('forsee/en-qwerty', 'letters', 'k-e');
    const q = targetId('forsee/en-qwerty', 'letters', 'k-q');
    const space = targetId('forsee/en-qwerty', 'letters', 'k-space');
    let notifications = 0;
    host.registry.onDidChange(() => (notifications += 1));
    await act(() => host.kernel.commands.execute('composition.insert', { text: 'th' }));
    expect(notifications).toBe(1);
    const likelyE = host.registry.get(e)?.likelihood ?? 0;
    const likelyQ = host.registry.get(q)?.likelihood ?? 0;
    expect(likelyE).toBeGreaterThan(likelyQ);
    expect(host.registry.get(space)?.likelihood).toBeUndefined();
  });
});

describe('fitFontPx', () => {
  it('leaves a margin for wide bold capitals in a narrow, tall key (portrait coarse layout)', () => {
    // A 190 x 230 group key with "WXYZ": capitals are about 0.72 em wide.
    const px = fitFontPx('WXYZ', 190, 230, 0.3);
    expect(px * 4 * 0.72).toBeLessThanOrEqual(190 * 0.85);
    // Height still limits single letters in wide keys.
    expect(fitFontPx('a', 300, 100)).toBe(46);
  });
});

describe('keyAppearance', () => {
  it('colours a Speak key (composition.speak) as the primary speak action', () => {
    expect(
      keyAppearance({ id: 's', label: 'Speak', action: { command: 'composition.speak' } }),
    ).toBe('speak');
    expect(keyAppearance({ id: 's', label: 'Say', action: { command: 'speech.speak' } })).toBe(
      'speak',
    );
    expect(keyAppearance({ id: 'u', label: 'Undo', action: { command: 'composition.undo' } })).toBe(
      'function',
    );
  });
});
