// @vitest-environment jsdom
import { DEFAULT_DWELL_CONFIG, GAZE_SETTINGS_NAMESPACE } from '@forsee/gaze';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DwellSpeedControls, PauseButton, SpeakButton } from './action-bar';
import { AppFrame, marginRestZones } from './app-frame';
import { createClickSound, useClickSound, type AudioContextLike } from './click-sound';
import { CompositionBar } from './composition-bar';
import { PauseOverlay } from './pause-overlay';
import { useSetting } from './provider';
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

describe('DwellSpeedControls', () => {
  it('changes the pipeline dwell config, persists it in app.gaze and shows the letter time', async () => {
    const h = host();
    renderWithHost(<DwellSpeedControls />, { host: h });
    expect(screen.getByText('0.8 s')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    await h.advance(0);
    expect(h.pipeline?.dwellConfig.classMs).toEqual({
      letter: 700,
      prediction: 800,
      function: 900,
      destructive: 1400,
    });
    expect(h.kernel.settings.get(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs')).toBe(700);
    expect(h.kernel.settings.get(GAZE_SETTINGS_NAMESPACE, 'dwell.destructiveMs')).toBe(1400);
    expect(screen.getByText('0.7 s')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    await h.advance(0);
    expect(h.pipeline?.dwellConfig.classMs.letter).toBe(900);
    expect(h.kernel.settings.get(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs')).toBe(900);
    expect(screen.getByText('0.9 s')).toBeTruthy();
  });

  it('works by dwell, and only changes the classes it is given', async () => {
    const h = host({
      measure: rectsByName({ 'letters/faster': { x: 0, y: 0, width: 100, height: 100 } }),
    });
    renderWithHost(<DwellSpeedControls idPrefix="letters" classes={['letter']} stepMs={200} />, {
      host: h,
    });
    await h.dwellAt({ x: 50, y: 50 }, DEFAULT_DWELL_CONFIG.classMs.function + 100);
    expect(h.pipeline?.dwellConfig.classMs).toEqual({
      ...DEFAULT_DWELL_CONFIG.classMs,
      letter: 600,
    });
    expect(h.kernel.settings.get(GAZE_SETTINGS_NAMESPACE, 'dwell.functionMs')).toBe(1000);
  });

  it('is disabled without a pipeline', () => {
    const h = host({ gaze: false });
    renderWithHost(<DwellSpeedControls />, { host: h });
    expect(screen.getByRole('button', { name: 'Faster' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});

describe('PauseButton and PauseOverlay', () => {
  it('pauses, blocks every other target, and the wake target resumes', async () => {
    const h = host({
      measure: rectsByName({
        'actions/pause': { x: 0, y: 0, width: 100, height: 100 },
        'pause/wake': { x: 300, y: 300, width: 400, height: 200 },
        composition: { x: 0, y: 600, width: 1000, height: 100 },
      }),
    });
    renderWithHost(
      <>
        <CompositionBar />
        <PauseButton />
        <PauseOverlay />
      </>,
      { host: h },
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      h.registry
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['actions/pause', 'composition/bar']);

    fireEvent.click(screen.getByRole('button', { name: 'Pause gaze' }));
    await h.advance(0);
    expect(h.pipeline?.paused).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Gaze is paused' })).toBeTruthy();
    expect(h.registry.list().map((t) => t.id)).toEqual(['pause/wake']);
    expect(h.registry.get('pause/wake')).toMatchObject({
      role: 'wake',
      command: { command: 'gaze.resume' },
    });

    // A click on a covered button does nothing while paused.
    fireEvent.click(screen.getByRole('button', { name: 'Pause gaze', hidden: true }));
    await h.advance(0);
    expect(h.pipeline?.paused).toBe(true);

    // A short look at the wake target is not enough; the long wake dwell is.
    await h.dwellAt({ x: 500, y: 400 }, 1000);
    expect(h.pipeline?.paused).toBe(true);
    await h.dwellAt({ x: 900, y: 50 }, 200);
    await h.dwellAt({ x: 500, y: 400 }, DEFAULT_DWELL_CONFIG.wakeMs + 100);
    expect(h.pipeline?.paused).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      h.registry
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual(['actions/pause', 'composition/bar']);
  });

  it('resumes with Enter on the wake button', async () => {
    const h = host();
    renderWithHost(<PauseOverlay />, { host: h });
    await act(() => h.kernel.commands.execute('gaze.pause'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Resume gaze' }), { key: 'Enter' });
    await h.advance(0);
    expect(h.pipeline?.paused).toBe(false);
  });
});

describe('SpeakButton', () => {
  it('runs its command, and turns into Stop while speaking', async () => {
    const h = host();
    const spoken = vi.fn();
    h.kernel.bus.on('speech.requested', spoken);
    const { rerender } = renderWithHost(
      <SpeakButton
        command={{ command: 'speech.speak' }}
        stopCommand={{ command: 'speech.stop' }}
      />,
      { host: h },
    );
    await act(() => h.kernel.commands.execute('composition.insert', { text: 'hi' }));
    fireEvent.click(screen.getByRole('button', { name: 'Speak' }));
    await h.advance(0);
    expect(spoken).toHaveBeenCalledWith({ text: 'hi', recordId: expect.any(String) as string });

    rerender(
      <SpeakButton
        command={{ command: 'speech.speak' }}
        stopCommand={{ command: 'speech.stop' }}
        speaking
      />,
    );
    expect(screen.queryByRole('button', { name: 'Speak' })).toBeNull();
    expect(h.registry.get('actions/speak')).toBeUndefined();
    expect(h.registry.get('actions/speak-stop')?.command).toEqual({ command: 'speech.stop' });
    const stops = vi.fn();
    h.kernel.bus.on('command.didExecute', (e) => {
      if (e.id === 'speech.stop') stops();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop speaking' }));
    await h.advance(0);
    expect(stops).toHaveBeenCalledTimes(1);
  });
});

describe('CompositionBar', () => {
  it('shows a placeholder, then the text with the partial word emphasised, as a rest zone', async () => {
    const h = host({
      measure: rectsByName({ composition: { x: 0, y: 0, width: 900, height: 120 } }),
    });
    const { container } = renderWithHost(<CompositionBar placeholder="Start here" />, { host: h });
    expect(screen.getByText('Start here')).toBeTruthy();
    expect(h.registry.get('composition/bar')).toMatchObject({
      role: 'rest',
      rect: { x: 0, y: 0, width: 900, height: 120 },
    });
    await act(() => h.kernel.commands.execute('composition.insert', { text: 'Hello wor' }));
    expect(container.querySelector('[data-part="partial-word"]')?.textContent).toBe('wor');
    expect(container.querySelector('output')?.textContent).toBe('Hello wor');
    expect(container.querySelector('[data-part="caret"]')).not.toBeNull();
  });
});

describe('AppFrame', () => {
  it('registers its margins as rest zones', () => {
    const h = host({
      measure: rectsByName({
        frame: { x: 0, y: 0, width: 1000, height: 800 },
        'frame-inner': { x: 12, y: 12, width: 976, height: 776 },
      }),
    });
    renderWithHost(<AppFrame keyboard={<div />} />, { host: h });
    const zones = h.registry.list().filter((t) => t.id.startsWith('frame/'));
    expect(zones.map((z) => z.role)).toEqual(['rest', 'rest', 'rest', 'rest']);
    expect(zones.find((z) => z.id === 'frame/margin-left')?.rect).toEqual({
      x: 0,
      y: 12,
      width: 12,
      height: 776,
    });
  });

  it('computes margin strips', () => {
    const zones = marginRestZones(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 5, width: 80, height: 90 },
    );
    const area = zones.reduce((sum, z) => sum + z.rect.width * z.rect.height, 0);
    expect(area).toBe(100 * 100 - 80 * 90);
  });
});

describe('useSetting', () => {
  function Show() {
    const value = useSetting(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs');
    const missing = useSetting('nope', 'x');
    return (
      <span>
        {String(value)}/{String(missing)}
      </span>
    );
  }
  it('reads a setting and follows changes; undefined without a schema', () => {
    const h = host();
    renderWithHost(<Show />, { host: h });
    expect(screen.getByText('800/undefined')).toBeTruthy();
    act(() => h.kernel.settings.set(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs', 600));
    expect(screen.getByText('600/undefined')).toBeTruthy();
  });
});

function fakeAudio(state: string) {
  const started: number[] = [];
  const ctx: AudioContextLike & { state: string; resumes: number } = {
    state,
    resumes: 0,
    currentTime: 1,
    destination: {},
    createOscillator: () => ({
      type: 'sine',
      frequency: {
        value: 0,
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
      start: (t?: number) => started.push(t ?? 0),
      stop: () => undefined,
    }),
    createGain: () => ({
      gain: {
        value: 0,
        setValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    }),
    resume() {
      this.resumes += 1;
      this.state = 'running';
      return Promise.resolve();
    },
  };
  return { ctx, started };
}

describe('click sound', () => {
  it('plays a blip only once audio runs, and is a no-op without audio', () => {
    const { ctx, started } = fakeAudio('suspended');
    const factory = vi.fn(() => ctx);
    const sound = createClickSound(factory);
    expect(factory).not.toHaveBeenCalled();
    sound.play();
    expect(started).toEqual([]);
    expect(ctx.resumes).toBe(1);
    sound.play();
    expect(started).toEqual([1]);
    expect(factory).toHaveBeenCalledTimes(1);

    expect(() => createClickSound(() => null).play()).not.toThrow();
    expect(() =>
      createClickSound(() => {
        throw new Error('no audio');
      }).play(),
    ).not.toThrow();
  });

  function Clicker({ enabled, factory }: { enabled: boolean; factory: () => AudioContextLike }) {
    useClickSound({ enabled, factory });
    return <PauseButton />;
  }

  it('plays on activation when enabled, and is off by default', async () => {
    const { ctx, started } = fakeAudio('running');
    const h = host();
    const { rerender } = renderWithHost(<Clicker enabled={false} factory={() => ctx} />, {
      host: h,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause gaze' }));
    await h.advance(0);
    expect(started).toEqual([]);
    await act(() => h.kernel.commands.execute('gaze.resume'));
    rerender(<Clicker enabled factory={() => ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause gaze' }));
    await h.advance(0);
    expect(started).toHaveLength(1);
  });
});
