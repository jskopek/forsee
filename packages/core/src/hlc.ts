import type { HlcString } from '@forsee/plugin-api';
import type { Clock } from './platform';

/**
 * Hybrid logical clock (Kulkarni et al., 2014). Gives every history record a
 * timestamp that is close to wall time, strictly increasing on one device
 * even when the wall clock jumps backwards, and consistent with causality
 * across devices (after `receive`).
 */

/** Decoded HLC timestamp. */
export interface HlcTimestamp {
  /** Wall-clock component, epoch ms (the largest wall time seen). */
  readonly wallMs: number;
  /** Logical counter that breaks ties within one `wallMs`. */
  readonly counter: number;
  /** Device that produced the timestamp; final tie-breaker. */
  readonly deviceId: string;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 6;
/** Largest counter that fits the encoding. */
export const HLC_MAX_COUNTER = 10 ** COUNTER_DIGITS - 1;

/** Encodes as a lexicographically sortable string (see `HlcString`). */
export function encodeHlc(ts: HlcTimestamp): HlcString {
  if (!Number.isInteger(ts.wallMs) || ts.wallMs < 0 || ts.wallMs >= 10 ** WALL_DIGITS) {
    throw new RangeError(`HLC wall time out of range: ${ts.wallMs}`);
  }
  if (!Number.isInteger(ts.counter) || ts.counter < 0 || ts.counter > HLC_MAX_COUNTER) {
    throw new RangeError(`HLC counter out of range: ${ts.counter}`);
  }
  // Device ids may contain '-': decoding splits only on the first two.
  if (ts.deviceId === '') throw new RangeError('HLC device id must not be empty');
  return `${String(ts.wallMs).padStart(WALL_DIGITS, '0')}-${String(ts.counter).padStart(COUNTER_DIGITS, '0')}-${ts.deviceId}`;
}

/** Decodes an `HlcString`. Throws `RangeError` if malformed. */
export function decodeHlc(value: HlcString): HlcTimestamp {
  const match = /^(\d{15})-(\d{6})-(.+)$/.exec(value);
  if (!match) throw new RangeError(`Malformed HLC: ${value}`);
  return {
    wallMs: Number(match[1]),
    counter: Number(match[2]),
    deviceId: match[3]!,
  };
}

/** Orders two encoded timestamps: negative if `a` is earlier. */
export function compareHlc(a: HlcString, b: HlcString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Generates HLC timestamps for one device. */
export class HybridLogicalClock {
  private wallMs = 0;
  private counter = 0;

  /**
   * @param clock source of wall time (`clock.wallNow()`, rounded down to whole ms)
   * @param deviceId this device's id, embedded in every timestamp
   */
  constructor(
    private readonly clock: Clock,
    readonly deviceId: string,
  ) {
    if (deviceId === '') throw new RangeError('deviceId must not be empty');
  }

  /** Timestamp for a local event. Strictly greater than every earlier result of this instance. */
  now(): HlcString {
    const physical = Math.floor(this.clock.wallNow());
    if (physical > this.wallMs) {
      this.wallMs = physical;
      this.counter = 0;
    } else {
      this.bumpCounter();
    }
    return this.current();
  }

  /**
   * Merges a timestamp received from another device (for example when
   * importing synced history). Returns a timestamp greater than both the
   * remote one and every earlier local one.
   */
  receive(remote: HlcString): HlcString {
    const r = decodeHlc(remote);
    const physical = Math.floor(this.clock.wallNow());
    const maxWall = Math.max(this.wallMs, r.wallMs, physical);
    if (maxWall === this.wallMs && maxWall === r.wallMs) {
      this.counter = Math.max(this.counter, r.counter);
      this.bumpCounter();
    } else if (maxWall === this.wallMs) {
      this.bumpCounter();
    } else if (maxWall === r.wallMs) {
      this.wallMs = maxWall;
      this.counter = r.counter;
      this.bumpCounter();
    } else {
      this.wallMs = maxWall;
      this.counter = 0;
    }
    return this.current();
  }

  /** Restores state from the latest persisted timestamp so restarts stay monotonic. */
  observe(latest: HlcString): void {
    const t = decodeHlc(latest);
    if (t.wallMs > this.wallMs || (t.wallMs === this.wallMs && t.counter > this.counter)) {
      this.wallMs = t.wallMs;
      this.counter = t.counter;
    }
  }

  private bumpCounter(): void {
    if (this.counter >= HLC_MAX_COUNTER) {
      // Counter exhausted: borrow the next millisecond rather than overflow.
      this.wallMs += 1;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
  }

  private current(): HlcString {
    return encodeHlc({ wallMs: this.wallMs, counter: this.counter, deviceId: this.deviceId });
  }
}
