import { FakeClock } from '@forsee/core';
import type { GazeSample, SourceError } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createAutoPointerSource, selectionMethodForMode, type InputMode } from './auto-source';
import { createTapSource } from './tap-source';
import { FakePointerEnvironment } from './testing';

describe('tap source', () => {
  function setup() {
    const clock = new FakeClock();
    const env = new FakePointerEnvironment();
    const source = createTapSource({ clock, environment: env });
    const samples: GazeSample[] = [];
    const errors: SourceError[] = [];
    const start = (): void =>
      source.start(
        (s) => samples.push(s),
        (e) => errors.push(e),
      );
    return { clock, env, source, samples, errors, start };
  }

  it('declares itself', () => {
    const { source } = setup();
    expect(source.id).toBe('tap');
    expect(source.kind).toBe('pointer');
    expect(source.capabilities).toEqual({ calibrate: false, hover: false });
  });

  it('emits only press samples at the tap position, never movement', () => {
    const { clock, env, samples, start } = setup();
    start();
    clock.advance(500);
    env.move(1, 1, { pointerType: 'touch' });
    env.move(2, 2);
    env.leave();
    env.blur();
    clock.advance(1000);
    expect(samples).toHaveLength(0);
    env.down(300, 400, { pointerType: 'touch' });
    expect(samples).toEqual([{ x: 300, y: 400, t: 1500, confidence: 1, valid: true, press: true }]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('does not double fire for pointerdown followed by click', () => {
    const { env, samples, start } = setup();
    start();
    env.tap(10, 20);
    env.tap(30, 40);
    expect(samples.map((s) => [s.x, s.y])).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('does not double fire when the click arrives long after a held tap', () => {
    const { clock, env, samples, start } = setup();
    start();
    env.down(10, 20, { pointerType: 'touch' });
    clock.advance(5000);
    env.up(10, 20, { pointerType: 'touch' });
    env.click(10, 20, { pointerType: 'touch' });
    expect(samples).toHaveLength(1);
  });

  it('does not swallow a later click-only activation after a cancelled gesture', () => {
    const { env, samples, start } = setup();
    start();
    env.down(10, 20, { pointerType: 'touch' });
    env.cancel({ pointerType: 'touch' });
    env.click(70, 80);
    expect(samples.map((s) => s.x)).toEqual([10, 70]);
  });

  it('accepts a click on its own as fallback, but not a position-less keyboard click', () => {
    const { env, samples, start } = setup();
    start();
    env.click(70, 80);
    env.click(0, 0, { detail: 0 });
    expect(samples.map((s) => [s.x, s.y])).toEqual([[70, 80]]);
  });

  it('ignores non-primary buttons, extra fingers and taps outside the viewport', () => {
    const { env, samples, start } = setup();
    start();
    env.down(10, 10, { button: 2 });
    env.down(10, 10, { isPrimary: false, pointerType: 'touch' });
    env.down(5000, 10);
    expect(samples).toHaveLength(0);
  });

  it('removes listeners on stop; reports unsupported environments', () => {
    const { env, source, samples, errors, start } = setup();
    start();
    expect(() => start()).toThrow(/already started/);
    expect(env.listenerCount()).toBeGreaterThan(0);
    source.stop();
    expect(env.listenerCount()).toBe(0);
    env.down(1, 1);
    expect(samples).toHaveLength(0);
    env.supported = false;
    start();
    expect(errors[0]).toMatchObject({ code: 'unavailable', recoverable: false });
  });
});

describe('auto source', () => {
  function setup() {
    const clock = new FakeClock();
    const env = new FakePointerEnvironment();
    const auto = createAutoPointerSource({ clock, environment: env });
    const samples: GazeSample[] = [];
    const errors: SourceError[] = [];
    const modes: InputMode[] = [];
    auto.onModeChange((m) => modes.push(m));
    const start = (): void =>
      auto.source.start(
        (s) => samples.push(s),
        (e) => errors.push(e),
      );
    return { clock, env, auto, samples, errors, modes, start };
  }

  it('declares itself', () => {
    const { auto } = setup();
    expect(auto.source.id).toBe('auto');
    expect(auto.source.kind).toBe('pointer');
    expect(auto.source.capabilities).toEqual({ calibrate: false, hover: true });
    expect(auto.mode).toBeNull();
  });

  it('behaves as the pointer source for mouse and pen', () => {
    const { clock, env, auto, samples, modes, start } = setup();
    start();
    env.move(10, 10);
    clock.advance(50);
    env.down(10, 10);
    env.click(10, 10);
    env.move(20, 20, { pointerType: 'pen' });
    expect(samples.map((s) => [s.x, s.valid, s.press === true])).toEqual([
      [10, true, false],
      [10, true, false],
      [10, true, true],
      [20, true, false],
    ]);
    expect(auto.mode).toBe('hover');
    expect(modes).toEqual(['hover']);
  });

  it('behaves as the tap source for touch', () => {
    const { clock, env, auto, samples, modes, start } = setup();
    start();
    env.move(5, 5, { pointerType: 'touch' });
    env.tap(30, 40);
    clock.advance(1000);
    expect(samples).toEqual([{ x: 30, y: 40, t: 0, confidence: 1, valid: true, press: true }]);
    expect(auto.mode).toBe('tap');
    expect(modes).toEqual(['tap']);
    expect(clock.pendingTimers).toBe(0);
  });

  it('switches per event and reports each change once', () => {
    const { clock, env, auto, samples, modes, start } = setup();
    start();
    env.move(10, 10);
    env.move(11, 11);
    env.tap(300, 300);
    // Switching to touch ends the mouse presence so dwell cannot run on its stale position.
    expect(samples.map((s) => [s.x, s.valid, s.press === true])).toEqual([
      [10, true, false],
      [11, true, false],
      [11, false, false],
      [300, true, true],
    ]);
    clock.advance(500);
    expect(samples).toHaveLength(4);
    env.move(50, 50);
    expect(auto.mode).toBe('hover');
    expect(modes).toEqual(['hover', 'tap', 'hover']);
    expect(samples.at(-1)).toMatchObject({ x: 50, valid: true });
  });

  it('can unsubscribe from mode changes', () => {
    const { env, auto, start } = setup();
    const seen: InputMode[] = [];
    const sub = auto.onModeChange((m) => seen.push(m));
    start();
    env.move(1, 1);
    sub.dispose();
    env.tap(1, 1);
    expect(seen).toEqual(['hover']);
  });

  it('maps modes to selection methods', () => {
    expect(selectionMethodForMode('hover')).toBe('dwell');
    expect(selectionMethodForMode('tap')).toBe('direct');
  });

  it('stop removes every listener and interval; the mode survives restart', () => {
    const { clock, env, auto, samples, start } = setup();
    start();
    env.move(1, 1);
    env.tap(2, 2);
    env.move(3, 3);
    auto.source.stop();
    expect(env.listenerCount()).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    const count = samples.length;
    env.move(4, 4);
    env.blur();
    expect(samples).toHaveLength(count);
    expect(auto.mode).toBe('hover');
  });

  it('reports unsupported environments and restart rules', () => {
    const { env, auto, errors, start } = setup();
    env.supported = false;
    start();
    expect(errors[0]).toMatchObject({ code: 'unavailable', recoverable: false });
    env.supported = true;
    start();
    expect(() => start()).toThrow(/already started/);
    auto.source.stop();
  });

  it('validates options at creation', () => {
    expect(() => createAutoPointerSource({ clock: new FakeClock(), keepAliveMs: -5 })).toThrow(
      RangeError,
    );
  });

  it('uses a click only in tap mode', () => {
    const { env, samples, start } = setup();
    start();
    env.move(1, 1);
    env.click(1, 1);
    expect(samples).toHaveLength(1);
    env.move(1, 1, { pointerType: 'touch' });
    env.click(60, 70, { pointerType: 'touch' });
    expect(samples.at(-1)).toMatchObject({ x: 60, y: 70, press: true });
  });
});
