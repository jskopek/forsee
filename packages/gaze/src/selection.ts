import { ForseeError, defaultErrorReporter, type ErrorReporter } from '@forsee/core';
import type {
  ActivateEvent,
  Disposable,
  Point,
  ProgressEvent,
  SelectionMethodId,
  TargetDescriptor,
} from '@forsee/plugin-api';
import {
  DEFAULT_DWELL_CONFIG,
  DEFAULT_SELECTION_TUNING,
  likelihoodFactor,
  type SelectionTuning,
} from './config';
import type {
  DwellConfig,
  HitTestResult,
  SelectionEvent,
  SelectionInput,
  SelectionMethod,
} from './contracts';
import { roleOf, singleEntryDistribution } from './targets';

/**
 * Selection methods: dwell, direct and switch. Each is a pure state machine
 * over `SelectionInput`s; time comes only from sample and tick timestamps.
 *
 * Events produced while processing one input are delivered after the input
 * has been fully processed, so a listener that reacts synchronously (for
 * example by pausing or resetting the method) never sees half-updated state.
 */

/** True when `target` may fire now: enabled, and `wake` while paused or `select` otherwise. */
export function canFire(target: TargetDescriptor, paused: boolean): boolean {
  if (target.disabled === true) return false;
  const role = roleOf(target);
  return paused ? role === 'wake' : role === 'select';
}

/**
 * Effective dwell time of `target`, ms: `wakeMs` for wake targets, otherwise
 * its class time times the bounded adaptive factor from its likelihood.
 */
export function effectiveDwellMs(
  target: TargetDescriptor,
  dwell: DwellConfig,
  tuning: SelectionTuning = DEFAULT_SELECTION_TUNING,
): number {
  if (roleOf(target) === 'wake') return dwell.wakeMs;
  return (
    dwell.classMs[target.dwellClass] * likelihoodFactor(target.likelihood, dwell.adaptive, tuning)
  );
}

/** Listener bookkeeping and deferred delivery shared by the methods. */
abstract class BaseSelection implements SelectionMethod {
  abstract readonly id: SelectionMethodId;
  protected paused = false;
  protected disposed = false;
  private readonly listeners = new Set<{ fn: (event: SelectionEvent) => void }>();
  private pending: SelectionEvent[] = [];
  private depth = 0;

  constructor(private readonly reportError: ErrorReporter = defaultErrorReporter) {}

  process(input: SelectionInput): void {
    if (this.disposed) return;
    this.depth += 1;
    try {
      this.handle(input);
    } finally {
      this.depth -= 1;
    }
    if (this.depth === 0) this.flush();
  }

  onEvent(listener: (event: SelectionEvent) => void): Disposable {
    const entry = { fn: listener };
    if (!this.disposed) this.listeners.add(entry);
    let done = false;
    return {
      dispose: () => {
        if (done) return;
        done = true;
        this.listeners.delete(entry);
      },
    };
  }

  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    this.onPausedChanged();
    this.flush();
  }

  reset(): void {
    if (this.disposed) return;
    this.clear();
    this.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.pending = [];
  }

  protected abstract handle(input: SelectionInput): void;
  protected abstract clear(): void;

  protected onPausedChanged(): void {
    this.clear();
  }

  /** Queues an event; it is delivered when the current input has been processed. */
  protected queue(event: SelectionEvent): void {
    this.pending.push(event);
  }

  private flush(): void {
    while (this.pending.length > 0 && !this.disposed) {
      const events = this.pending;
      this.pending = [];
      for (const event of events) {
        for (const entry of [...this.listeners]) {
          if (!this.listeners.has(entry)) continue;
          try {
            entry.fn(event);
          } catch (error) {
            this.reportError(error, `gaze.selection.${this.id}`);
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ dwell

/** Options of the dwell method. */
export interface DwellSelectionOptions {
  readonly dwell?: DwellConfig;
  readonly tuning?: SelectionTuning;
  readonly reportError?: ErrorReporter;
}

interface DwellEntry {
  /** Progress, 0..1. */
  value: number;
  /** Effective dwell time the progress is measured against, ms. */
  dwellMs: number;
  /** Value at the last emitted progress event. */
  emitted: number;
}

/**
 * The dwell method.
 *
 * - Each target has its own progress (0..1). The engaged target (the one the
 *   latest valid sample hit) gains `elapsed / effectiveDwellMs`; every other
 *   target with progress loses `decayPerSecond` per second. Coming back to
 *   a target within the decay window resumes from what is left.
 * - Frame ticks credit the engaged target for at most
 *   `tuning.extrapolateMs` after the last valid sample (a smooth fill
 *   between samples of slow sources; a stalled source does not keep
 *   dwelling). When the next valid sample arrives within `tuning.holdMs` of
 *   the previous one, the whole interval is credited, so slow sources dwell
 *   at the right speed. An invalid sample stops the credit at the last
 *   valid sample.
 *   After the last valid sample, progress is held for `tuning.holdMs`
 *   (blinks) and then decays.
 * - A target fires when its progress reaches 1. `look-away` targets then
 *   need a valid sample off the target before they can gain progress
 *   again; `repeat` targets fire again every `repeatIntervalMs` while gaze
 *   stays, with `repeatIndex` 1, 2, ...
 * - A rest zone clears all progress and any repeat chain.
 * - Disabled targets, wake targets while not paused, and non-wake targets
 *   while paused never gain progress (they still count as engaged, so the
 *   others decay). While paused, wake targets need `wakeMs`.
 * - At most one progress event per target per input, only when its
 *   progress changed; 0 means reset or fully decayed.
 */
export class DwellSelection extends BaseSelection {
  readonly id = 'dwell' as const;
  private dwell: DwellConfig;
  private tuning: SelectionTuning;
  private readonly progress = new Map<string, DwellEntry>();
  private engaged: TargetDescriptor | null = null;
  private engagedHit: HitTestResult | null = null;
  private point: Point = { x: 0, y: 0 };
  private lastT: number | null = null;
  private lastValidT: number | null = null;
  /** Time held back from the active target by the extrapolation limit, ms; credited if a sample confirms it. */
  private heldMs = 0;
  private locked: string | null = null;
  private repeat: { targetId: string; nextIndex: number } | null = null;

  constructor(options: DwellSelectionOptions = {}) {
    super(options.reportError);
    this.dwell = options.dwell ?? DEFAULT_DWELL_CONFIG;
    this.tuning = options.tuning ?? DEFAULT_SELECTION_TUNING;
  }

  /** Replaces the dwell configuration; progress fractions are kept. */
  setConfig(dwell: DwellConfig, tuning: SelectionTuning = this.tuning): void {
    this.dwell = dwell;
    this.tuning = tuning;
  }

  /** Progress of a target (0 when none), for tests and diagnostics. */
  progressOf(targetId: string): number {
    return this.progress.get(targetId)?.value ?? 0;
  }

  protected handle(input: SelectionInput): void {
    if (input.type === 'switch') return;
    if (input.type === 'tick') {
      this.advance(input.t, this.extrapolationLimit());
    } else if (input.sample.valid) {
      // Valid samples up to holdMs apart count as continuous gaze, so a slow
      // source is credited in full when its next sample confirms the target,
      // including time that ticks held back.
      const continuous =
        this.lastValidT !== null && input.sample.t - this.lastValidT <= this.tuning.holdMs;
      if (continuous) this.creditHeld();
      this.heldMs = 0;
      this.advance(input.sample.t, continuous ? input.sample.t : this.extrapolationLimit());
      this.engage(input.hit, input.sample.t, input.sample);
    } else {
      // Gaze was lost: time held back since the last valid sample is not dwell.
      this.advance(input.sample.t, this.lastValidT ?? -Infinity);
      this.heldMs = 0;
    }
    this.queueProgress(input.type === 'tick' ? input.t : input.sample.t);
  }

  protected clear(): void {
    for (const [id, entry] of this.progress) {
      if (entry.emitted > 0 || entry.value > 0) {
        this.queue(this.progressEvent(id, 0, entry.dwellMs, this.lastT ?? 0));
      }
    }
    this.progress.clear();
    this.heldMs = 0;
    this.repeat = null;
    this.engaged = null;
    this.engagedHit = null;
  }

  private extrapolationLimit(): number {
    return this.lastValidT === null ? -Infinity : this.lastValidT + this.tuning.extrapolateMs;
  }

  /** The engaged target if it can gain progress now. */
  private activeTarget(): TargetDescriptor | null {
    const t = this.engaged;
    if (!t || t.id === this.locked || !canFire(t, this.paused)) return null;
    return t;
  }

  private dwellFor(target: TargetDescriptor): number {
    if (this.repeat?.targetId === target.id) return this.dwell.repeatIntervalMs;
    return effectiveDwellMs(target, this.dwell, this.tuning);
  }

  /** Credits the time ticks held back (between the extrapolation limit and now) to the active target. */
  private creditHeld(): void {
    const active = this.activeTarget();
    const entry = active ? this.progress.get(active.id) : undefined;
    if (active && entry && this.heldMs > 0) {
      entry.dwellMs = this.dwellFor(active);
      entry.value = Math.min(1, entry.value + this.heldMs / entry.dwellMs);
    }
    this.heldMs = 0;
  }

  /** Credits and decays progress over `[lastT, t]`, then fires the engaged target if it is full. */
  private advance(t: number, creditUntil: number): void {
    const from = this.lastT ?? t;
    const active = this.activeTarget();
    this.lastT ??= t;
    if (t > from) {
      this.lastT = t;
      this.decayAndCredit(from, t, creditUntil, active);
    }
    if (active) {
      const entry = this.progress.get(active.id);
      if (entry && entry.value >= 1) this.fire(active, entry, t);
    }
  }

  private decayAndCredit(
    from: number,
    t: number,
    creditUntil: number,
    active: TargetDescriptor | null,
  ): void {
    const decayPerMs = this.dwell.decayPerSecond / 1000;
    for (const [id, entry] of this.progress) {
      if (id === active?.id) {
        entry.dwellMs = this.dwellFor(active);
        const creditEnd = Math.max(from, Math.min(t, creditUntil));
        const creditMs = creditEnd - from;
        const holdEnd = (this.lastValidT ?? from) + this.tuning.holdMs;
        const decayStart = Math.max(creditEnd, Math.min(t, holdEnd));
        this.heldMs += decayStart - creditEnd;
        const decayMs = t - decayStart;
        entry.value = Math.min(
          1,
          Math.max(0, entry.value + creditMs / entry.dwellMs - decayMs * decayPerMs),
        );
      } else {
        entry.value = Math.max(0, entry.value - (t - from) * decayPerMs);
        if (entry.value === 0 && entry.emitted === 0) this.progress.delete(id);
      }
    }
  }

  private fire(target: TargetDescriptor, entry: DwellEntry, t: number): void {
    const repeatIndex = this.repeat?.targetId === target.id ? this.repeat.nextIndex : 0;
    const event: ActivateEvent = {
      type: 'activate',
      targetId: target.id,
      method: 'dwell',
      repeatIndex,
      point: this.point,
      distribution: this.engagedHit?.distribution ?? singleEntryDistribution(target),
      t,
    };
    this.queue(event);
    entry.value = 0;
    if (target.afterActivate === 'repeat' && roleOf(target) !== 'wake') {
      this.repeat = { targetId: target.id, nextIndex: repeatIndex + 1 };
      entry.dwellMs = this.dwell.repeatIntervalMs;
    } else {
      this.locked = target.id;
    }
  }

  private engage(hit: HitTestResult, t: number, point: Point): void {
    this.lastValidT = t;
    this.point = { x: point.x, y: point.y };
    if (hit.inRestZone) {
      this.clear();
      this.locked = null;
      return;
    }
    const target = hit.target;
    const id = target?.id ?? null;
    if (this.locked !== null && this.locked !== id) this.locked = null;
    if (this.repeat && this.repeat.targetId !== id) this.repeat = null;
    this.engaged = target;
    this.engagedHit = hit;
    const active = this.activeTarget();
    if (active && !this.progress.has(active.id)) {
      this.progress.set(active.id, { value: 0, dwellMs: this.dwellFor(active), emitted: 0 });
    }
  }

  private queueProgress(t: number): void {
    for (const [id, entry] of this.progress) {
      if (entry.value === entry.emitted) continue;
      entry.emitted = entry.value;
      this.queue(this.progressEvent(id, entry.value, entry.dwellMs, t));
    }
    // Entries that reached 0 and were announced can go (unless engaged and active).
    const activeId = this.activeTarget()?.id;
    for (const [id, entry] of this.progress) {
      if (entry.value === 0 && entry.emitted === 0 && id !== activeId) this.progress.delete(id);
    }
  }

  private progressEvent(
    targetId: string,
    progress: number,
    dwellMs: number,
    t: number,
  ): ProgressEvent {
    return { type: 'progress', targetId, progress, dwellMs, t };
  }
}

// ------------------------------------------------------------------ direct

/**
 * The direct method: a `press` sample fires the target under it at once,
 * with a single-entry distribution (a click or tap carries no uncertainty).
 * No dwell, no progress events.
 */
export class DirectSelection extends BaseSelection {
  readonly id = 'direct' as const;

  constructor(options: { reportError?: ErrorReporter } = {}) {
    super(options.reportError);
  }

  protected handle(input: SelectionInput): void {
    if (input.type !== 'sample') return;
    const { sample, hit } = input;
    if (!sample.valid || sample.press !== true) return;
    const target = hit.target;
    if (!target || !canFire(target, this.paused)) return;
    this.queue({
      type: 'activate',
      targetId: target.id,
      method: 'direct',
      repeatIndex: 0,
      point: { x: sample.x, y: sample.y },
      distribution: singleEntryDistribution(target),
      t: sample.t,
    });
  }

  protected clear(): void {
    // stateless
  }
}

// ------------------------------------------------------------------ switch

/**
 * The switch method: gaze highlights a target (the hit target of the latest
 * valid sample; it survives blinks and is cleared by empty space or a rest
 * zone), and a switch press confirms it. A `switch` input fires on the
 * transition to pressed (held switches and key auto-repeat do not fire
 * again); a `press` sample also confirms. The distribution is the
 * highlight's, so gaze uncertainty still reaches the predictor.
 */
export class SwitchSelection extends BaseSelection {
  readonly id = 'switch' as const;
  private highlighted: { hit: HitTestResult; point: Point } | null = null;
  private down = false;

  constructor(options: { reportError?: ErrorReporter } = {}) {
    super(options.reportError);
  }

  /** The highlighted target id, if any. */
  get highlightedId(): string | null {
    return this.highlighted?.hit.target?.id ?? null;
  }

  protected handle(input: SelectionInput): void {
    if (input.type === 'tick') return;
    if (input.type === 'switch') {
      const wasDown = this.down;
      this.down = input.pressed;
      if (input.pressed && !wasDown) this.confirm(input.t);
      return;
    }
    const { sample, hit } = input;
    if (!sample.valid) return;
    this.highlighted = hit.target ? { hit, point: { x: sample.x, y: sample.y } } : null;
    if (sample.press === true) this.confirm(sample.t);
  }

  protected clear(): void {
    this.highlighted = null;
  }

  protected override onPausedChanged(): void {
    // The highlight stays valid across pause and resume; only firing rules change.
  }

  private confirm(t: number): void {
    const h = this.highlighted;
    const target = h?.hit.target;
    if (!h || !target || !canFire(target, this.paused)) return;
    this.queue({
      type: 'activate',
      targetId: target.id,
      method: 'switch',
      repeatIndex: 0,
      point: h.point,
      distribution: h.hit.distribution,
      t,
    });
  }
}

// ------------------------------------------------------------------ factory

/** Options for `createSelectionMethod`. */
export interface SelectionMethodOptions {
  readonly dwell?: DwellConfig;
  readonly tuning?: SelectionTuning;
  readonly reportError?: ErrorReporter;
}

/**
 * Creates a selection method. `swipe` is reserved for package C10 and
 * throws `ForseeError('unavailable')`.
 */
export function createSelectionMethod(
  id: SelectionMethodId,
  options: SelectionMethodOptions = {},
): DwellSelection | DirectSelection | SwitchSelection {
  const errorOption = options.reportError ? { reportError: options.reportError } : {};
  switch (id) {
    case 'dwell':
      return new DwellSelection(options);
    case 'direct':
      return new DirectSelection(errorOption);
    case 'switch':
      return new SwitchSelection(errorOption);
    case 'swipe':
      throw new ForseeError('unavailable', 'The swipe selection method is not implemented yet');
  }
}
