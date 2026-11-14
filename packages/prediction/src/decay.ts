/**
 * Exponentially decaying sums. A value `v` stamped at wall time `at` is
 * worth `v · 2^(-(now - at) / halfLife)` at `now`. Because everything decays
 * at the same rate, sums of decayed values can be maintained incrementally,
 * and the order of two stamped values never changes over time (compare
 * `rank()` instead of decayed values).
 */
export class Decay {
  constructor(readonly halfLifeMs: number) {
    if (!(halfLifeMs > 0)) throw new RangeError('halfLifeMs must be > 0');
  }

  /** Factor for an age of `dtMs` (1 for non-positive ages, so clock skew never inflates values). */
  factor(dtMs: number): number {
    return dtMs <= 0 ? 1 : Math.pow(2, -dtMs / this.halfLifeMs);
  }

  /** `value` stamped `at`, seen at `now`. */
  valueAt(value: number, at: number, now: number): number {
    return value * this.factor(now - at);
  }

  /** Time-invariant ordering key: larger means heavier at any common `now`. */
  rank(value: number, at: number): number {
    return value > 0 ? Math.log2(value) + at / this.halfLifeMs : -Infinity;
  }
}

/** A stamped, decaying amount. */
export interface Stamped {
  value: number;
  at: number;
}

/** Adds `amount` at time `t` to `s` in place. */
export function addStamped(decay: Decay, s: Stamped, amount: number, t: number): void {
  if (t >= s.at) {
    s.value = s.value * decay.factor(t - s.at) + amount;
    s.at = t;
  } else {
    s.value += amount * decay.factor(s.at - t);
  }
}
