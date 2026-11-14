import { FakeClock } from '@forsee/core';
import {
  DEFAULT_DWELL_CONFIG,
  createGazePipeline,
  createTargetRegistry,
  type GazePipeline,
} from '@forsee/gaze';
import { describe, expect, it, vi } from 'vitest';
import { createPointerSource } from './pointer-source';
import { FakePointerEnvironment, PointerScript } from './testing';

const PLAIN = {
  ...DEFAULT_DWELL_CONFIG,
  adaptive: { ...DEFAULT_DWELL_CONFIG.adaptive, enabled: false },
};
const KEY = { x: 100, y: 100, width: 60, height: 60 };
const ON_KEY = { x: 130, y: 130 };

function setup() {
  const clock = new FakeClock();
  const env = new FakePointerEnvironment();
  const targets = createTargetRegistry();
  targets.register({
    id: 'keyboard/key-a',
    rect: KEY,
    dwellClass: 'letter',
    text: 'a',
    command: { command: 'composition.insert', args: { text: 'a' } },
  });
  const execute = vi.fn(() => Promise.resolve(true));
  const pipeline: GazePipeline = createGazePipeline({
    clock,
    targets,
    dwell: PLAIN,
    executeCommand: execute,
  });
  pipeline.setSource(createPointerSource({ clock, environment: env }));
  return { clock, env, pipeline, execute };
}

describe('pointer source feeding the real gaze pipeline', () => {
  it('fires the target after the letter dwell when the pointer rests on it', () => {
    const { clock, env, pipeline, execute } = setup();
    new PointerScript()
      .jumpTo({ x: 600, y: 600 }, 100)
      .moveTo(ON_KEY, 100)
      .rest(PLAIN.classMs.letter - 200)
      .play(env, clock);
    expect(execute).not.toHaveBeenCalled();
    clock.advance(400);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'composition.insert',
      expect.objectContaining({ text: 'a' }),
      'gaze',
    );
    pipeline.dispose();
  });

  it('does not fire if the pointer leaves the viewport first', () => {
    const { clock, env, pipeline, execute } = setup();
    new PointerScript()
      .jumpTo(ON_KEY)
      .rest(PLAIN.classMs.letter - 200)
      .leave()
      .rest(3000)
      .play(env, clock);
    expect(execute).not.toHaveBeenCalled();
    pipeline.dispose();
  });

  it('does not fire if the window loses focus first', () => {
    const { clock, env, pipeline, execute } = setup();
    env.move(ON_KEY.x, ON_KEY.y);
    clock.advance(PLAIN.classMs.letter - 200);
    env.blur();
    clock.advance(3000);
    expect(execute).not.toHaveBeenCalled();
    pipeline.dispose();
  });

  it('fires from a click through the direct method path', () => {
    const { clock, env, pipeline, execute } = setup();
    pipeline.setSelectionMethod('direct');
    env.move(ON_KEY.x, ON_KEY.y);
    clock.advance(20);
    env.down(ON_KEY.x, ON_KEY.y);
    expect(execute).toHaveBeenCalledTimes(1);
    pipeline.dispose();
  });
});
