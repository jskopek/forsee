// @vitest-environment jsdom
import { DEFAULT_DWELL_CONFIG, GAZE_SETTINGS_NAMESPACE } from '@forsee/gaze';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DwellSpeedControls, StopSpeakingButton } from './action-bar';
import { AppFrame, appFrameGrid } from './app-frame';
import { ChoiceGroup, StepperControl, ToggleTarget } from './choices';
import { CompositionBar } from './composition-bar';
import { useMediaQuery, type MatchMediaLike } from './media-query';
import { NoticeCard } from './notice';
import { PhraseBar } from './phrase-bar';
import { Sheet } from './sheet';
import { createTestHost, rectsByName, renderWithHost, type TestHost } from './testing';

let hosts: TestHost[] = [];
afterEach(() => {
  cleanup();
  for (const host of hosts) host.dispose();
  hosts = [];
});

function host(options: Parameters<typeof createTestHost>[0] = {}): TestHost {
  const h = createTestHost({ prediction: false, ...options });
  hosts.push(h);
  return h;
}

function ids(h: TestHost): string[] {
  return h.registry
    .list()
    .map((t) => t.id)
    .sort();
}

describe('appFrameGrid', () => {
  it('adds a banner row and keeps the keyboard row at its minimum share', () => {
    const grid = appFrameGrid({ actions: 'right', banner: true, keyboardMinPercent: 55 });
    expect(grid.gridTemplateAreas).toBe(
      '"banner actions" "composition actions" "predictions actions" "keyboard actions"',
    );
    expect(String(grid.gridTemplateRows).split(' minmax')[1]).toBe('(55%, 1fr)');
  });

  it('stacks the action bar under the keyboard for portrait screens', () => {
    const grid = appFrameGrid({ actions: 'bottom', banner: true, keyboardMinPercent: 50 });
    expect(grid.gridTemplateAreas).toBe(
      '"banner" "composition" "predictions" "keyboard" "actions"',
    );
    expect(grid.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });

  it('puts a left control bar before every row', () => {
    const grid = appFrameGrid({ actions: 'left', banner: false, keyboardMinPercent: 55 });
    expect(grid.gridTemplateAreas).toBe(
      '"actions composition" "actions predictions" "actions keyboard"',
    );
    expect(String(grid.gridTemplateColumns).endsWith('minmax(0, 1fr)')).toBe(true);
  });

  it('puts a top control bar at the end of the composition row only', () => {
    const grid = appFrameGrid({ actions: 'top', banner: true, keyboardMinPercent: 55 });
    expect(grid.gridTemplateAreas).toBe(
      '"banner banner" "composition actions" "predictions predictions" "keyboard keyboard"',
    );
  });

  it('splits a top control bar around the composition when asked', () => {
    const grid = appFrameGrid({
      actions: 'top',
      actionsStart: true,
      banner: false,
      keyboardMinPercent: 55,
    });
    expect(grid.gridTemplateAreas).toBe(
      '"actions-start composition actions" "predictions predictions predictions" "keyboard keyboard keyboard"',
    );
  });

  it('has no banner or action areas when they are absent', () => {
    const grid = appFrameGrid({ actions: 'none', banner: false, keyboardMinPercent: 60 });
    expect(grid.gridTemplateAreas).toBe('"composition" "predictions" "keyboard"');
  });

  it('renders the banner region, and makes the regions inert on request', () => {
    const h = host();
    const { container, rerender } = renderWithHost(
      <AppFrame banner={<p>quick</p>} keyboard={<div />} />,
      { host: h },
    );
    expect(container.querySelector('[data-region="banner"]')?.textContent).toBe('quick');
    expect(
      container.querySelector('[data-forsee-measure="frame-inner"]')?.hasAttribute('inert'),
    ).toBe(false);
    rerender(<AppFrame banner={null} keyboard={<div />} inert />);
    expect(container.querySelector('[data-region="banner"]')).toBeNull();
    expect(
      container.querySelector('[data-forsee-measure="frame-inner"]')?.hasAttribute('inert'),
    ).toBe(true);
  });
});

describe('DwellSpeedControls with commands', () => {
  it('runs the given commands once each and shows the stored letter dwell', async () => {
    const h = host();
    const faster = vi.fn(() => {
      h.kernel.settings.set(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs', 300);
    });
    const slower = vi.fn();
    h.kernel.commands.register('test.faster', faster, { title: 'test.faster' });
    h.kernel.commands.register('test.slower', slower, { title: 'test.slower' });
    renderWithHost(
      <DwellSpeedControls
        commands={{ faster: { command: 'test.faster' }, slower: { command: 'test.slower' } }}
      />,
      { host: h },
    );
    expect(screen.getByText('0.8 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    await h.advance(0);
    expect(faster).toHaveBeenCalledTimes(1);
    expect(slower).not.toHaveBeenCalled();
    // The built-in step did not run as well.
    expect(h.pipeline?.dwellConfig.classMs.function).toBe(DEFAULT_DWELL_CONFIG.classMs.function);
    expect(screen.getByText('0.3 s')).toBeTruthy();
    expect(h.registry.get('actions/dwell/faster')?.command).toEqual({ command: 'test.faster' });
  });
});

describe('StopSpeakingButton', () => {
  it('keeps its place as a rest area while silent and stops speech while speaking', async () => {
    const h = host({
      measure: rectsByName({
        'actions/stop': { x: 0, y: 0, width: 100, height: 100 },
        'actions/stop-idle': { x: 0, y: 0, width: 100, height: 100 },
      }),
    });
    const stop = vi.fn();
    h.kernel.commands.register('test.stop', stop, { title: 'test.stop' });
    const { rerender } = renderWithHost(
      <StopSpeakingButton speaking={false} command={{ command: 'test.stop' }} />,
      { host: h },
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(h.registry.get('actions/stop-idle')?.role).toBe('rest');

    rerender(<StopSpeakingButton speaking command={{ command: 'test.stop' }} />);
    expect(ids(h)).toEqual(['actions/stop']);
    await h.dwellAt({ x: 50, y: 50 }, DEFAULT_DWELL_CONFIG.classMs.function + 100);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet', () => {
  function WithSheet({ onClose }: { readonly onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <CompositionBar />
        {open && (
          <Sheet
            title="Settings"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <ToggleTarget
              id="sheet/toggle"
              label="Click sound"
              value={false}
              onChange={() => undefined}
            />
          </Sheet>
        )}
      </>
    );
  }

  it('hides everything underneath from gaze, and closes by dwell, restoring it', async () => {
    const h = host({
      measure: rectsByName({
        composition: { x: 0, y: 0, width: 1000, height: 100 },
        'sheet/panel': { x: 0, y: 0, width: 1000, height: 800 },
        'sheet/close': { x: 800, y: 20, width: 180, height: 80 },
        'sheet/toggle': { x: 20, y: 200, width: 300, height: 100 },
      }),
    });
    const onClose = vi.fn();
    renderWithHost(<WithSheet onClose={onClose} />, { host: h });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(ids(h)).toEqual(['sheet/close', 'sheet/panel', 'sheet/toggle']);
    expect(h.registry.get('sheet/panel')?.role).toBe('rest');
    expect(document.activeElement?.getAttribute('data-target-id')).toBe('sheet/close');

    await h.dwellAt({ x: 890, y: 60 }, DEFAULT_DWELL_CONFIG.classMs.function + 100);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ids(h)).toEqual(['composition/bar']);
  });

  it('closes with Escape and with a click on Close', () => {
    const h = host();
    const onClose = vi.fn();
    renderWithHost(
      <Sheet title="Problems" onClose={onClose}>
        <p>none</p>
      </Sheet>,
      { host: h },
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ChoiceGroup, ToggleTarget and StepperControl', () => {
  it('marks the chosen option and reports a new choice by click or dwell', async () => {
    const h = host({
      measure: rectsByName({ 'mode/each-word': { x: 0, y: 0, width: 200, height: 100 } }),
    });
    const onChoose = vi.fn();
    renderWithHost(
      <ChoiceGroup
        label="When to speak"
        idPrefix="mode"
        choices={[
          { value: 'on-demand', label: 'When I select Speak' },
          { value: 'each-word', label: 'After each word', detail: 'automatic' },
        ]}
        value="on-demand"
        onChoose={onChoose}
      />,
      { host: h },
    );
    const selected = screen.getByRole('button', { name: 'When I select Speak' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen
        .getByRole('button', { name: 'After each word, automatic' })
        .getAttribute('aria-pressed'),
    ).toBe('false');
    fireEvent.click(selected);
    await h.dwellAt({ x: 100, y: 50 }, DEFAULT_DWELL_CONFIG.classMs.function + 100);
    expect(onChoose.mock.calls).toEqual([['on-demand'], ['each-word']]);
  });

  it('toggles and steps', () => {
    const h = host();
    const onChange = vi.fn();
    const onStep = vi.fn();
    renderWithHost(
      <>
        <ToggleTarget id="t" label="Click sound" value onChange={onChange} />
        <StepperControl
          idPrefix="rate"
          label="Speaking rate"
          valueText="1.0×"
          downLabel="Slower"
          upLabel="Faster"
          canUp={false}
          onStep={onStep}
        />
      </>,
      { host: h },
    );
    const toggle = screen.getByRole('button', { name: 'Click sound' });
    expect(toggle.textContent).toContain('On');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(onStep.mock.calls).toEqual([[-1]]);
    expect(screen.getByText('1.0×')).toBeTruthy();
  });
});

describe('PhraseBar', () => {
  it('registers one target per tile with its command, run once per dwell', async () => {
    const h = host({
      measure: rectsByName({ 'quick/yes': { x: 0, y: 0, width: 120, height: 60 } }),
    });
    const speak = vi.fn();
    h.kernel.commands.register('test.say', speak, { title: 'test.say' });
    renderWithHost(
      <PhraseBar
        label="Quick replies"
        idPrefix="quick"
        tiles={[
          { id: 'yes', label: 'Yes', command: { command: 'test.say', args: { phraseId: 'yes' } } },
          {
            id: 'help',
            label: 'Help',
            command: { command: 'test.say', args: { phraseId: 'help' } },
            emphasis: true,
          },
        ]}
      />,
      { host: h },
    );
    expect(screen.getByRole('navigation', { name: 'Quick replies' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Help' }).className).toContain('bg-danger');
    await h.dwellAt({ x: 60, y: 30 }, DEFAULT_DWELL_CONFIG.classMs.function + 100);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ phraseId: 'yes' });
  });

  it('renders nothing without tiles', () => {
    const h = host();
    const { container } = renderWithHost(<PhraseBar label="Quick replies" tiles={[]} />, {
      host: h,
    });
    expect(container.innerHTML).toBe('');
  });
});

describe('NoticeCard', () => {
  it('shows the message and offers its actions and Dismiss as targets', () => {
    const h = host();
    const onDismiss = vi.fn();
    const restore = vi.fn();
    renderWithHost(
      <NoticeCard
        id="notice/x"
        title="Could not speak"
        message="I would like a cup of tea"
        actions={[{ id: 'restore', label: 'Put text back', onActivate: restore }]}
        onDismiss={onDismiss}
        position={{ index: 0, count: 2 }}
      />,
      { host: h },
    );
    expect(screen.getByText('I would like a cup of tea')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Put text back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Could not speak' }));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('useMediaQuery', () => {
  it('follows the media query list', () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const matchMedia: MatchMediaLike = () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    });
    function Show() {
      return <span>{useMediaQuery('(orientation: portrait)', matchMedia) ? 'tall' : 'wide'}</span>;
    }
    render(<Show />);
    expect(screen.getByText('wide')).toBeTruthy();
    act(() => {
      matches = true;
      for (const listener of listeners) listener();
    });
    expect(screen.getByText('tall')).toBeTruthy();
  });
});
