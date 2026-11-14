import { describe, expect, it } from 'vitest';
import { compareHlc, decodeHlc, encodeHlc, HLC_MAX_COUNTER, HybridLogicalClock } from './hlc';
import { FakeClock } from './testing';

const T0 = Date.UTC(2026, 10, 13);

describe('HLC encoding', () => {
  it('round-trips and sorts lexicographically', () => {
    const a = encodeHlc({ wallMs: T0, counter: 0, deviceId: 'dev-a' });
    const b = encodeHlc({ wallMs: T0, counter: 1, deviceId: 'dev-a' });
    const c = encodeHlc({ wallMs: T0 + 1, counter: 0, deviceId: 'a' });
    expect(decodeHlc(a)).toEqual({ wallMs: T0, counter: 0, deviceId: 'dev-a' });
    expect([c, b, a].sort()).toEqual([a, b, c]);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, b)).toBe(0);
  });

  it('rejects malformed input', () => {
    expect(() => decodeHlc('nope')).toThrow(RangeError);
    expect(() => encodeHlc({ wallMs: -1, counter: 0, deviceId: 'd' })).toThrow(RangeError);
    expect(() => encodeHlc({ wallMs: 1, counter: HLC_MAX_COUNTER + 1, deviceId: 'd' })).toThrow();
    expect(() => encodeHlc({ wallMs: 1, counter: 0, deviceId: '' })).toThrow();
  });
});

describe('HybridLogicalClock', () => {
  it('follows wall time when it moves forward', () => {
    const clock = new FakeClock({ wall: T0 });
    const hlc = new HybridLogicalClock(clock, 'd');
    expect(decodeHlc(hlc.now())).toMatchObject({ wallMs: T0, counter: 0 });
    clock.advance(5);
    expect(decodeHlc(hlc.now())).toMatchObject({ wallMs: T0 + 5, counter: 0 });
  });

  it('stays strictly monotonic when the wall clock stalls or jumps backwards', () => {
    const clock = new FakeClock({ wall: T0 });
    const hlc = new HybridLogicalClock(clock, 'd');
    const stamps = [hlc.now(), hlc.now()];
    clock.setWallTime(T0 - 60_000); // skew: wall clock set back a minute
    stamps.push(hlc.now(), hlc.now());
    clock.setWallTime(T0 + 10);
    stamps.push(hlc.now());
    for (let i = 1; i < stamps.length; i += 1) {
      expect(compareHlc(stamps[i - 1]!, stamps[i]!)).toBeLessThan(0);
    }
    expect(decodeHlc(stamps[3]!)).toMatchObject({ wallMs: T0, counter: 3 });
    expect(decodeHlc(stamps[4]!)).toMatchObject({ wallMs: T0 + 10, counter: 0 });
  });

  it('borrows the next millisecond when the counter is exhausted', () => {
    const clock = new FakeClock({ wall: T0 });
    const hlc = new HybridLogicalClock(clock, 'd');
    hlc.observe(encodeHlc({ wallMs: T0, counter: HLC_MAX_COUNTER, deviceId: 'd' }));
    expect(decodeHlc(hlc.now())).toMatchObject({ wallMs: T0 + 1, counter: 0 });
  });

  it('receive moves past a remote timestamp from the future', () => {
    const clock = new FakeClock({ wall: T0 });
    const hlc = new HybridLogicalClock(clock, 'local');
    const remote = encodeHlc({ wallMs: T0 + 5000, counter: 7, deviceId: 'remote' });
    const merged = hlc.receive(remote);
    expect(decodeHlc(merged)).toMatchObject({ wallMs: T0 + 5000, counter: 8 });
    expect(compareHlc(remote, merged)).toBeLessThan(0);
    expect(compareHlc(merged, hlc.now())).toBeLessThan(0);
  });

  it('receive handles equal and older remote times', () => {
    const clock = new FakeClock({ wall: T0 });
    const hlc = new HybridLogicalClock(clock, 'local');
    hlc.now(); // T0:0
    const equal = hlc.receive(encodeHlc({ wallMs: T0, counter: 4, deviceId: 'r' }));
    expect(decodeHlc(equal)).toMatchObject({ wallMs: T0, counter: 5 });
    const older = hlc.receive(encodeHlc({ wallMs: T0 - 100, counter: 9, deviceId: 'r' }));
    expect(decodeHlc(older)).toMatchObject({ wallMs: T0, counter: 6 });
    clock.advance(1);
    const fresh = hlc.receive(encodeHlc({ wallMs: T0 - 100, counter: 9, deviceId: 'r' }));
    expect(decodeHlc(fresh)).toMatchObject({ wallMs: T0 + 1, counter: 0 });
  });

  it('observe restores state so restarts stay monotonic', () => {
    const clock = new FakeClock({ wall: T0 });
    const persisted = encodeHlc({ wallMs: T0 + 1000, counter: 2, deviceId: 'd' });
    const hlc = new HybridLogicalClock(clock, 'd');
    hlc.observe(persisted);
    hlc.observe(encodeHlc({ wallMs: T0, counter: 50, deviceId: 'd' })); // older: ignored
    expect(compareHlc(persisted, hlc.now())).toBeLessThan(0);
  });

  it('requires a device id', () => {
    expect(() => new HybridLogicalClock(new FakeClock(), '')).toThrow();
  });
});
