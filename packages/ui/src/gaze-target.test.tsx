// @vitest-environment jsdom
import { DEFAULT_DWELL_CONFIG } from '@forsee/gaze';
import type { ActivateEvent, Rect } from '@forsee/plugin-api';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GazeTarget } from './gaze-target';
import { FIRED_FLASH_MS } from './target-face';
import { renderWithHost, type TestHost } from './testing';

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

function setup(
  ui: React.ReactElement,
  options: { gaze?: boolean; rect?: () => Rect; id?: string } = {},
) {
  const id = options.id ?? 'test/a';
  const rect = options.rect ?? (() => ({ x: 100, y: 100, width: 120, height: 80 }));
  const result = renderWithHost(ui, {
    dwell: PLAIN_DWELL,
    gaze: options.gaze ?? true,
    prediction: false,
    measure: (name) => (name === id ? rect() : undefined),
  });
  hosts.push(result.host);
  return result;
}

function insertCount(host: TestHost): () => number {
  let count = 0;
  host.kernel.bus.on('command.didExecute', (e) => {
    if (e.id === 'composition.insert') count += 1;
  });
  return () => count;
}

describe('GazeTarget registration', () => {
  it('registers its descriptor with the measured rectangle', () => {
    const { host } = setup(
      <GazeTarget
        id="test/a"
        dwellClass="letter"
        text="a"
        label="Letter A"
        likelihood={0.2}
        command={{ command: 'composition.insert', args: { text: 'a' } }}
      />,
    );
    expect(host.registry.get('test/a')).toEqual({
      id: 'test/a',
      rect: { x: 100, y: 100, width: 120, height: 80 },
      dwellClass: 'letter',
      likelihood: 0.2,
      command: { command: 'composition.insert', args: { text: 'a' } },
      text: 'a',
      label: 'Letter A',
    });
    expect(screen.getByRole('button', { name: 'Letter A' })).toBeTruthy();
  });

  it('updates on resize, follows prop changes and is removed on unmount', () => {
    let rect: Rect = { x: 0, y: 0, width: 50, height: 50 };
    const { host, rerender, unmount } = setup(
      <GazeTarget id="test/a" dwellClass="function" label="Go" />,
      { rect: () => rect },
    );
    expect(host.registry.get('test/a')?.rect).toEqual(rect);
    rect = { x: 10, y: 20, width: 200, height: 90 };
    act(() => host.dom.notify());
    expect(host.registry.get('test/a')?.rect).toEqual({ x: 10, y: 20, width: 200, height: 90 });

    rerender(<GazeTarget id="test/a" dwellClass="destructive" label="Go" disabled />);
    expect(host.registry.get('test/a')).toMatchObject({
      dwellClass: 'destructive',
      disabled: true,
    });
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('aria-disabled')).toBe('true');

    unmount();
    expect(host.registry.get('test/a')).toBeUndefined();
    expect(host.dom.observerCount).toBe(0);
  });

  it('registers wake and rest roles', () => {
    const { host } = setup(
      <GazeTarget id="test/a" dwellClass="function" role="wake" label="Wake" />,
    );
    expect(host.registry.get('test/a')?.role).toBe('wake');
  });
});

describe('GazeTarget feedback', () => {
  it('shows progress, the engaged highlight and the fired flash from pipeline events', async () => {
    const onActivate = vi.fn();
    const { host } = setup(
      <GazeTarget id="test/a" dwellClass="function" label="Go" onActivate={onActivate} />,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    const progress = (): number => Number(button.style.getPropertyValue('--forsee-dwell') || '0');

    await host.dwellAt({ x: 160, y: 140 }, 400);
    expect(button.dataset.engaged).toBe('true');
    expect(progress()).toBeGreaterThan(0.3);
    expect(progress()).toBeLessThan(0.5);
    expect(button.style.getPropertyValue('--forsee-dwell-transition')).not.toBe('0ms');

    await host.dwellAt({ x: 900, y: 700 }, 1000);
    expect(button.dataset.engaged).toBe('false');
    expect(progress()).toBe(0);
    expect(button.style.getPropertyValue('--forsee-dwell-transition')).toBe('0ms');
    expect(onActivate).not.toHaveBeenCalled();

    await host.dwellAt({ x: 160, y: 140 }, PLAIN_DWELL.classMs.function + 100);
    expect(onActivate).toHaveBeenCalledTimes(1);
    const event = onActivate.mock.calls[0]?.[0] as ActivateEvent;
    expect(event).toMatchObject({ type: 'activate', targetId: 'test/a', method: 'dwell' });
    expect(button.dataset.fired).toBe('true');
    await host.advance(FIRED_FLASH_MS + 10);
    expect(button.dataset.fired).toBe('false');
  });

  it('does not execute a command target a second time', async () => {
    const onActivate = vi.fn();
    const { host } = setup(
      <GazeTarget
        id="test/a"
        dwellClass="letter"
        text="a"
        label="A"
        command={{ command: 'composition.insert', args: { text: 'a' } }}
        onActivate={onActivate}
      />,
    );
    const inserts = insertCount(host);
    await host.dwellAt({ x: 160, y: 140 }, PLAIN_DWELL.classMs.letter + 200);
    expect(host.kernel.composition.text).toBe('a');
    expect(inserts()).toBe(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
    // The pipeline attached the selection's distribution.
    expect(host.kernel.composition.state.partialWordSteps[0]?.distribution).not.toBeNull();
  });
});

describe('GazeTarget direct activation', () => {
  it('activates on click without a pipeline, with a single-entry distribution', () => {
    const onActivate = vi.fn();
    setup(<GazeTarget id="test/a" dwellClass="function" label="Go" onActivate={onActivate} />, {
      gaze: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    const event = onActivate.mock.calls[0]?.[0] as ActivateEvent;
    expect(event).toMatchObject({
      targetId: 'test/a',
      method: 'direct',
      repeatIndex: 0,
      point: { x: 160, y: 140 },
    });
    expect(event.distribution.entries).toEqual([{ targetId: 'test/a', probability: 1 }]);
  });

  it('executes a command target once on click, with the distribution attached', async () => {
    const { host } = setup(
      <GazeTarget
        id="test/a"
        dwellClass="letter"
        text="a"
        label="A"
        command={{ command: 'composition.insert', args: { text: 'a' } }}
      />,
      { gaze: false },
    );
    const inserts = insertCount(host);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    await host.advance(0);
    expect(host.kernel.composition.text).toBe('a');
    expect(inserts()).toBe(1);
    expect(host.kernel.composition.state.partialWordSteps[0]?.distribution?.entries).toEqual([
      { targetId: 'test/a', text: 'a', probability: 1 },
    ]);
  });

  it('activates on Enter and Space through the same path, not on key repeat', () => {
    const onActivate = vi.fn();
    setup(<GazeTarget id="test/a" dwellClass="function" label="Go" onActivate={onActivate} />);
    const button = screen.getByRole('button', { name: 'Go' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.keyDown(button, { key: ' ', repeat: true });
    fireEvent.keyDown(button, { key: 'a' });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate.mock.calls.map((c) => (c[0] as ActivateEvent).method)).toEqual([
      'direct',
      'direct',
    ]);
  });

  it('ignores clicks while disabled, and non-wake targets while paused', async () => {
    const onActivate = vi.fn();
    const { host, rerender } = setup(
      <GazeTarget id="test/a" dwellClass="function" label="Go" onActivate={onActivate} disabled />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onActivate).not.toHaveBeenCalled();

    rerender(<GazeTarget id="test/a" dwellClass="function" label="Go" onActivate={onActivate} />);
    await act(() => host.kernel.commands.execute('gaze.pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onActivate).not.toHaveBeenCalled();
    await act(() => host.kernel.commands.execute('gaze.resume'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
