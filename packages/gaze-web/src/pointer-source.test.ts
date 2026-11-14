import { FakeClock } from '@forsee/core';
import type { GazeSample, SourceError } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createPointerSource } from './pointer-source';
import { FakePointerEnvironment, PointerScript } from './testing';

function setup(options: { keepAliveMs?: number; minMovePx?: number; touch?: boolean } = {}) {
  const clock = new FakeClock();
  const env = new FakePointerEnvironment();
  const source = createPointerSource({ clock, environment: env, ...options });
  const samples: GazeSample[] = [];
  const errors: SourceError[] = [];
  const start = (): void =>
    source.start(
      (s) => samples.push(s),
      (e) => errors.push(e),
    );
  return { clock, env, source, samples, errors, start };
}

describe('pointer source', () => {
  it('declares itself', () => {
    const { source } = setup();
    expect(source.id).toBe('pointer');
    expect(source.kind).toBe('pointer');
    expect(source.capabilities).toEqual({ calibrate: false, hover: true });
  });

  it('turns movement into samples stamped with the injected clock', () => {
    const { clock, env, samples, start } = setup();
    start();
    clock.advance(1234);
    // The event's own timeStamp is on another time base and must not leak into t.
    env.move(10, 20, { timeStamp: 99999 });
    clock.advance(10);
    env.move(30, 40);
    expect(samples).toEqual([
      { x: 10, y: 20, t: 1234, confidence: 1, valid: true },
      { x: 30, y: 40, t: 1244, confidence: 1, valid: true },
    ]);
  });

  it('expands coalesced events in order, ending at the delivered time', () => {
    const { clock, env, samples, start } = setup();
    start();
    clock.advance(100);
    env.move(40, 0, {
      timeStamp: 1016,
      coalesced: [
        { x: 10, y: 0, timeStamp: 1000 },
        { x: 20, y: 0, timeStamp: 1005 },
        { x: 30, y: 0, timeStamp: 1010 },
        { x: 40, y: 0, timeStamp: 1016 },
      ],
    });
    expect(samples.map((s) => [s.x, s.t])).toEqual([
      [10, 84],
      [20, 89],
      [30, 94],
      [40, 100],
    ]);
  });

  it('never lets a coalesced batch step back in time', () => {
    const { clock, env, samples, start } = setup({ keepAliveMs: 0 });
    start();
    clock.advance(100);
    env.move(1, 1);
    env.move(5, 0, {
      timeStamp: 50,
      coalesced: [
        { x: 2, y: 0, timeStamp: 0 },
        { x: 5, y: 0, timeStamp: 50 },
      ],
    });
    const times = samples.map((s) => s.t);
    expect(times).toEqual([100, 100, 100]);
  });

  it('repeats the last position while still, and stops when the pointer leaves', () => {
    const { clock, env, samples, start } = setup();
    start();
    env.move(100, 100);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(200);
    expect(samples).toHaveLength(5);
    expect(samples.slice(1).map((s) => [s.x, s.y, s.t, s.valid, s.press])).toEqual([
      [100, 100, 50, true, undefined],
      [100, 100, 100, true, undefined],
      [100, 100, 150, true, undefined],
      [100, 100, 200, true, undefined],
    ]);
    env.leave();
    expect(clock.pendingTimers).toBe(0);
    const before = samples.length;
    clock.advance(500);
    expect(samples).toHaveLength(before);
  });

  it('does not repeat right after real movement, and honours the keep-alive interval', () => {
    const { clock, env, samples, start } = setup({ keepAliveMs: 100 });
    start();
    env.move(1, 1);
    clock.advance(90);
    env.move(2, 2);
    clock.advance(10); // tick at 100: only 10 ms since the move
    expect(samples).toHaveLength(2);
    clock.advance(100); // tick at 200
    expect(samples).toHaveLength(3);
    expect(samples[2]).toMatchObject({ x: 2, y: 2, t: 200, valid: true });
  });

  it('can turn the keep-alive off', () => {
    const { clock, env, samples, start } = setup({ keepAliveMs: 0 });
    start();
    env.move(1, 1);
    expect(clock.pendingTimers).toBe(0);
    clock.advance(1000);
    expect(samples).toHaveLength(1);
  });

  it('rejects invalid options', () => {
    const clock = new FakeClock();
    const environment = new FakePointerEnvironment();
    expect(() => createPointerSource({ clock, environment, keepAliveMs: -1 })).toThrow(RangeError);
    expect(() => createPointerSource({ clock, environment, minMovePx: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it.each([
    ['leaves the document', (env: FakePointerEnvironment) => env.leave()],
    ['loses window focus', (env: FakePointerEnvironment) => env.blur()],
    ['hides the page', (env: FakePointerEnvironment) => env.setVisible(false)],
    ['cancels the pointer', (env: FakePointerEnvironment) => env.cancel()],
  ])('emits one invalid sample and stops repeating when the pointer %s', (_name, away) => {
    const { clock, env, samples, start } = setup();
    start();
    clock.advance(10);
    env.move(5, 6);
    clock.advance(20);
    away(env);
    expect(samples).toHaveLength(2);
    expect(samples[1]).toEqual({ x: 5, y: 6, t: 30, confidence: 0, valid: false });
    expect(clock.pendingTimers).toBe(0);
    // Repeated leave signals do not repeat the invalid sample.
    env.leave();
    env.blur();
    clock.advance(1000);
    expect(samples).toHaveLength(2);
  });

  it('resumes on the next movement after an invalid sample', () => {
    const { clock, env, samples, start } = setup();
    start();
    env.move(5, 6);
    env.leave();
    clock.advance(100);
    env.move(7, 8);
    expect(samples.map((s) => s.valid)).toEqual([true, false, true]);
    expect(samples[2]).toMatchObject({ x: 7, y: 8, t: 100 });
    expect(clock.pendingTimers).toBe(1);
    clock.advance(50);
    expect(samples).toHaveLength(4);
  });

  it('ignores movement while the page is hidden', () => {
    const { env, samples, start } = setup();
    start();
    env.setVisible(false);
    env.move(1, 1);
    expect(samples).toHaveLength(0);
    env.setVisible(true);
    env.move(2, 2);
    expect(samples).toHaveLength(1);
  });

  it('ignores pointerout caused by moving between elements', () => {
    const { env, samples, start } = setup();
    start();
    env.move(1, 1);
    env.document.dispatch({
      type: 'pointerout',
      pointerType: 'mouse',
      relatedTarget: {},
    });
    expect(samples).toHaveLength(1);
  });

  it('treats a position outside the viewport as leaving', () => {
    const { env, samples, start } = setup();
    start();
    env.move(5, 5);
    env.move(-1, 5);
    env.move(5000, 5);
    expect(samples.map((s) => s.valid)).toEqual([true, false]);
  });

  it('skips events without usable coordinates', () => {
    const { env, samples, start } = setup();
    start();
    env.move(Number.NaN, 5);
    expect(samples).toHaveLength(0);
  });

  it('sends press samples for the primary button only, without a duplicate movement sample', () => {
    const { clock, env, samples, start } = setup();
    start();
    clock.advance(10);
    env.move(50, 60);
    clock.advance(5);
    env.down(50, 60);
    env.up(50, 60);
    expect(samples).toHaveLength(2);
    expect(samples[1]).toEqual({ x: 50, y: 60, t: 15, confidence: 1, valid: true, press: true });
    env.down(50, 60, { button: 2 });
    env.down(50, 60, { button: 1 });
    expect(samples).toHaveLength(2);
  });

  it('a press without prior movement also counts as presence', () => {
    const { clock, env, samples, start } = setup();
    start();
    env.down(9, 9);
    expect(samples).toEqual([{ x: 9, y: 9, t: 0, confidence: 1, valid: true, press: true }]);
    clock.advance(50);
    expect(samples[1]).toMatchObject({ x: 9, y: 9, valid: true });
    expect(samples[1]?.press).toBeUndefined();
  });

  it('handles mouse and pen, and ignores touch by default', () => {
    const { env, samples, start } = setup();
    start();
    env.move(1, 1, { pointerType: 'pen' });
    env.move(2, 2, { pointerType: 'mouse' });
    env.move(3, 3, { pointerType: 'touch' });
    env.down(3, 3, { pointerType: 'touch' });
    env.leave({ pointerType: 'touch' });
    expect(samples.map((s) => s.x)).toEqual([1, 2]);
    expect(samples.every((s) => s.valid)).toBe(true);
  });

  it('can handle touch as a moving pointer: lifting the finger ends presence', () => {
    const { clock, env, samples, start } = setup({ touch: true });
    start();
    env.move(3, 3, { pointerType: 'touch' });
    env.up(3, 3, { pointerType: 'touch' });
    expect(samples.map((s) => s.valid)).toEqual([true, false]);
    expect(clock.pendingTimers).toBe(0);
  });

  it('ignores non-primary pointers', () => {
    const { env, samples, start } = setup({ touch: true });
    start();
    env.move(3, 3, { pointerType: 'touch', isPrimary: false });
    expect(samples).toHaveLength(0);
  });

  it('drops movement below the minimum threshold', () => {
    const { env, samples, start } = setup({ minMovePx: 5, keepAliveMs: 0 });
    start();
    env.move(0, 0);
    env.move(2, 2);
    env.move(3, 0);
    env.move(6, 0);
    expect(samples.map((s) => s.x)).toEqual([0, 6]);
  });

  it('reports unsupported environments through onError without throwing', () => {
    const { env, source, samples, errors, start } = setup();
    env.supported = false;
    expect(() => start()).not.toThrow();
    expect(errors).toEqual([
      {
        code: 'unavailable',
        message: 'This browser does not support Pointer Events.',
        recoverable: false,
      },
    ]);
    expect(env.listenerCount()).toBe(0);
    expect(samples).toHaveLength(0);
    expect(() => source.stop()).not.toThrow();
  });

  it('allows start again only after stop', () => {
    const { env, source, samples, start } = setup();
    start();
    expect(() => start()).toThrow(/already started/);
    source.stop();
    source.stop();
    env.move(1, 1);
    expect(samples).toHaveLength(0);
    start();
    env.move(2, 2);
    expect(samples).toHaveLength(1);
  });

  it('removes every listener and interval on stop and delivers nothing afterwards', () => {
    const { clock, env, source, samples, start } = setup();
    expect(env.listenerCount()).toBe(0);
    start();
    expect(env.listenerCount()).toBeGreaterThan(0);
    env.move(1, 1);
    expect(clock.pendingTimers).toBe(1);
    source.stop();
    expect(env.listenerCount()).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    const count = samples.length;
    env.move(2, 2);
    env.leave();
    env.blur();
    clock.advance(1000);
    expect(samples).toHaveLength(count);
  });

  it('plays a PointerScript', () => {
    const { clock, env, samples, start } = setup();
    start();
    new PointerScript().jumpTo({ x: 100, y: 100 }).rest(120).press().leave().play(env, clock);
    expect(samples.map((s) => [s.valid, s.press === true])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [true, true],
      [false, false],
    ]);
  });
});
