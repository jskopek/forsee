// @vitest-environment jsdom
import { effectiveDwellMs } from '@forsee/gaze';
import { targetId } from '@forsee/layouts';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PauseButton, SpeakButton } from './action-bar';
import { AppFrame } from './app-frame';
import { CompositionBar } from './composition-bar';
import { KeyboardView } from './keyboard-view';
import { PauseOverlay } from './pause-overlay';
import { PredictionStrip } from './prediction-strip';
import { createTestHost, rectsByName, renderWithHost, type TestHost } from './testing';

/** Where everything is, in a 1000 x 800 viewport (jsdom has no layout). */
export const FRAME_LAYOUT = rectsByName({
  frame: { x: 0, y: 0, width: 1000, height: 800 },
  'frame-inner': { x: 12, y: 12, width: 976, height: 776 },
  composition: { x: 12, y: 12, width: 840, height: 110 },
  predictions: { x: 12, y: 130, width: 840, height: 90 },
  keyboard: { x: 12, y: 228, width: 840, height: 560 },
  'actions/speak': { x: 864, y: 12, width: 124, height: 200 },
  'actions/pause': { x: 864, y: 220, width: 124, height: 120 },
  'pause/wake': { x: 200, y: 250, width: 600, height: 300 },
});

let hosts: TestHost[] = [];
afterEach(() => {
  cleanup();
  for (const host of hosts) host.dispose();
  hosts = [];
});

function renderApp(): TestHost {
  const host = createTestHost({ measure: FRAME_LAYOUT });
  hosts.push(host);
  renderWithHost(
    <AppFrame
      composition={<CompositionBar />}
      predictions={<PredictionStrip />}
      keyboard={<KeyboardView runtime={host.runtime} />}
      actions={
        <>
          <SpeakButton command={{ command: 'composition.speak' }} />
          <PauseButton />
        </>
      }
      overlay={<PauseOverlay />}
    />,
    { host },
  );
  return host;
}

const key = (keyId: string): string => targetId('forsee/en-qwerty', 'letters', keyId);

/** The effective dwell of a registered target right now (class, likelihood, adaptive dwell). */
function dwellOf(host: TestHost, id: string): number {
  const target = host.registry.get(id);
  if (!target || !host.pipeline) throw new Error(`no target ${id}`);
  return effectiveDwellMs(target, host.pipeline.dwellConfig, host.pipeline.engineConfig.selection);
}

describe('the whole path: pointer, gaze pipeline, keyboard, composition, prediction', () => {
  it('types "he" by dwell, carries the uncertainty to the buffer, and accepts a completion', async () => {
    const host = renderApp();

    // "h", then "e", each held for its own effective (adaptive) letter dwell.
    await host.dwellAt(host.centreOf(key('k-h')), dwellOf(host, key('k-h')) + 100);
    expect(host.kernel.composition.text).toBe('h');
    await host.dwellAt(host.centreOf(key('k-e')), dwellOf(host, key('k-e')) + 100);
    expect(host.kernel.composition.text).toBe('he');

    // The selection uncertainty reached the composition buffer.
    const steps = host.kernel.composition.state.partialWordSteps;
    expect(steps.map((s) => s.text)).toEqual(['h', 'e']);
    for (const step of steps) {
      expect(step.distribution).not.toBeNull();
      expect(step.distribution?.entries[0]?.text).toBe(step.text);
    }

    // The strip shows completions of "he" from the seed model, as targets.
    const strip = screen.getByRole('group', { name: 'Word predictions' });
    const words = within(strip)
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(word.toLowerCase().startsWith('he')).toBe(true);
    const candidates = host.registry
      .list()
      .filter((t) => t.id.startsWith('predictions/') && t.role !== 'rest');
    expect(candidates.map((t) => t.label)).toEqual(words);
    expect(candidates.every((t) => t.dwellClass === 'prediction')).toBe(true);

    // Dwell on the first completion: the composition ends with it plus a space.
    const first = candidates[0]!;
    const word = first.label!;
    await host.dwellAt(host.centreOf(first.id), dwellOf(host, first.id) + 100);
    expect(host.kernel.composition.text).toBe(`${word} `);

    // Leaving a key just before its dwell completes inserts nothing.
    const before = host.kernel.composition.text;
    await host.dwellAt(host.centreOf(key('k-k')), dwellOf(host, key('k-k')) - 120);
    await host.dwellAt({ x: 400, y: 60 }, 2000); // the composition bar: a rest zone
    expect(host.kernel.composition.text).toBe(before);
    expect(host.errors).toEqual([]);
  });

  it('pausing blocks the keyboard until the wake target is dwelt on', async () => {
    const host = renderApp();
    await host.dwellAt(host.centreOf('actions/pause'), dwellOf(host, 'actions/pause') + 100);
    expect(host.pipeline?.paused).toBe(true);
    const dialog = screen.getByRole('dialog', { name: 'Gaze is paused' });
    expect(dialog).toBeTruthy();
    // Only the wake target is registered while paused.
    expect(host.registry.list().map((t) => t.id)).toEqual(['pause/wake']);

    // Keys cannot fire (they are not even there for the pipeline).
    await host.dwellAt({ x: 100, y: 500 }, 3000);
    expect(host.kernel.composition.text).toBe('');

    // A long dwell on the wake target resumes.
    const wakeMs = host.pipeline!.dwellConfig.wakeMs;
    await host.dwellAt(host.centreOf('pause/wake'), wakeMs + 100);
    expect(host.pipeline?.paused).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(host.registry.get(key('k-h'))).toBeDefined();
    expect(host.registry.get('actions/speak')).toBeDefined();
    expect(host.errors).toEqual([]);
  });
});
