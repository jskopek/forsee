import { ForseeError, defaultErrorReporter, type ErrorReporter } from '@forsee/core';
import type {
  ActivateEvent,
  Disposable,
  GazeSample,
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

/** Progress this close to 1 counts as full (floating-point sums of interval fractions). */
const FULL_EPSILON = 1e-9;

interface DwellEntry {
  /** Confirmed progress, 0..1: only dwell observed on the target counts. */
  value: number;
  /** Effective dwell time the progress is measured against, ms. */
  dwellMs: number;
  /** Shown value at the last emitted progress event. */
  emitted: number;
}

/**
 * The last valid sample, when it hit a target that could gain progress and
 * no invalid sample has arrived since. The next valid sample confirms it if
 * it hits the same eligible target within `tuning.holdMs`.
 */
interface DwellAnchor {
  readonly targetId: string;
  readonly t: number;
}

/**
 * The dwell method.
 *
 * **Only observed dwell counts.** Dwell is credited per interval between two
 * consecutive valid samples: the interval `[a, b]` is credited to a target
 * only when the samples at `a` and `b` both hit that target (after hit
 * testing with hysteresis), the target could fire at both (enabled, not
 * locked by look-away, the right role for the pause state), `b - a <=
 * tuning.holdMs`, and no invalid sample arrived in between. Any other
 * interval is not dwell: when the sample at `b` lands on another target, a
 * rest zone, empty space or an ineligible target, the target engaged at `a`
 * gets nothing for the gap, and a newly engaged target starts accumulating
 * at `b`. Slow sources are therefore credited in full while gaze stays (a
 * 5 Hz source still fires at the configured time), and the sample that
 * shows the user has left can never fire, or add progress to, the target
 * they left.
 *
 * **Activations happen only on a confirming sample.** A target fires on the
 * valid sample whose confirmed interval brings its progress to 1, never on a
 * frame tick. Between samples, ticks show a provisional fill of at most
 * `tuning.extrapolateMs` after the last valid sample, for a smooth
 * indicator; it is display only, is dropped if the next sample does not
 * confirm the target, and never fires anything. The cost is latency: a
 * target fires on the first sample at or after its threshold, at most one
 * sample interval late (about 17 ms at 60 Hz, 200 ms at 5 Hz).
 *
 * The other rules:
 * - Each target has its own progress (0..1). Every target other than the
 *   engaged one (the one the latest valid sample hit) loses
 *   `decayPerSecond` per second. Coming back to a target within the decay
 *   window resumes from what is left.
 * - After the last valid sample, the engaged target's progress is held
 *   (neither grows nor decays) for `tuning.holdMs` (blinks) and then
 *   decays.
 * - After firing, `look-away` targets need a valid sample off the target
 *   before they can gain progress again; `repeat` targets fire again every
 *   `repeatIntervalMs` of confirmed dwell, with `repeatIndex` 1, 2, ...
 * - A rest zone clears all progress and any repeat chain.
 * - Disabled targets, wake targets while not paused, and non-wake targets
 *   while paused never gain progress (they still count as engaged, so the
 *   others decay). While paused, wake targets need `wakeMs`.
 * - At most one progress event per target per input, only when its shown
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
  private anchor: DwellAnchor | null = null;
  /** Unconfirmed, display-only extrapolation for the anchor target since `anchor.t`, ms. */
  private provisionalMs = 0;
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

  /**
   * Shown progress of a target (0 when none): confirmed progress plus any
   * provisional fill between samples. For tests and diagnostics.
   */
  progressOf(targetId: string): number {
    const entry = this.progress.get(targetId);
    return entry ? this.shown(targetId, entry) : 0;
  }

  protected handle(input: SelectionInput): void {
    if (input.type === 'switch') return;
    if (input.type === 'tick') {
      this.elapse(input.t);
      this.extrapolate(input.t);
      this.queueProgress(input.t);
      return;
    }
    const { sample } = input;
    if (sample.valid) {
      this.onValidSample(input.hit, sample);
    } else {
      // Gaze was lost: nothing since the last valid sample can be confirmed.
      this.elapse(sample.t);
      this.anchor = null;
      this.provisionalMs = 0;
    }
    this.queueProgress(sample.t);
  }

  protected clear(): void {
    for (const [id, entry] of this.progress) {
      if (entry.emitted > 0 || entry.value > 0) {
        this.queue(this.progressEvent(id, 0, entry.dwellMs, this.lastT ?? 0));
      }
    }
    this.progress.clear();
    this.anchor = null;
    this.provisionalMs = 0;
    this.repeat = null;
    this.engaged = null;
    this.engagedHit = null;
  }

  /** The engaged target if it can gain progress now. */
  private activeTarget(): TargetDescriptor | null {
    const t = this.engaged;
    if (!t || !this.eligible(t)) return null;
    return t;
  }

  private eligible(target: TargetDescriptor): boolean {
    return target.id !== this.locked && canFire(target, this.paused);
  }

  private dwellFor(target: TargetDescriptor): number {
    if (this.repeat?.targetId === target.id) return this.dwell.repeatIntervalMs;
    return effectiveDwellMs(target, this.dwell, this.tuning);
  }

  private onValidSample(hit: HitTestResult, sample: GazeSample): void {
    const t = sample.t;
    const target = hit.inRestZone ? null : hit.target;
    const anchor = this.anchor;
    // The interval since the last valid sample is dwell only if this sample
    // confirms the same eligible target, soon enough.
    const confirmed =
      anchor !== null &&
      target !== null &&
      target.id === anchor.targetId &&
      t >= anchor.t &&
      t - anchor.t <= this.tuning.holdMs &&
      this.eligible(target)
        ? anchor
        : null;
    // Time passes without credit: decay for others, hold or decay for the engaged target.
    this.elapse(t);
    this.provisionalMs = 0;
    this.engage(hit, t, sample);
    if (confirmed && target) {
      const entry = this.progress.get(target.id);
      if (entry) {
        entry.dwellMs = this.dwellFor(target);
        entry.value = Math.min(1, entry.value + (t - confirmed.t) / entry.dwellMs);
        // Rounding: n confirmed intervals summing to exactly dwellMs reach 1.
        if (entry.value >= 1 - FULL_EPSILON) this.fire(target, entry, t);
      }
    }
  }

  /** Moves time to `t` without crediting anything: decay, and hold for the engaged target. */
  private elapse(t: number): void {
    const from = this.lastT ?? t;
    if (this.lastT === null || t > this.lastT) this.lastT = t;
    if (t <= from) return;
    const decayPerMs = this.dwell.decayPerSecond / 1000;
    const heldId = this.activeTarget()?.id;
    const holdEnd = (this.lastValidT ?? from) + this.tuning.holdMs;
    for (const [id, entry] of this.progress) {
      const decayStart = id === heldId ? Math.max(from, Math.min(t, holdEnd)) : from;
      const decayMs = t - decayStart;
      if (decayMs > 0) entry.value = Math.max(0, entry.value - decayMs * decayPerMs);
      if (entry.value === 0 && entry.emitted === 0 && id !== heldId) this.progress.delete(id);
    }
  }

  /** Display-only fill between samples: at most `extrapolateMs` after the anchor, never past the hold. */
  private extrapolate(t: number): void {
    const anchor = this.anchor;
    const active = this.activeTarget();
    if (!anchor || active?.id !== anchor.targetId || t - anchor.t > this.tuning.holdMs) {
      this.provisionalMs = 0;
      return;
    }
    const entry = this.progress.get(active.id);
    if (entry) entry.dwellMs = this.dwellFor(active);
    this.provisionalMs = Math.max(0, Math.min(t, anchor.t + this.tuning.extrapolateMs) - anchor.t);
  }

  private shown(id: string, entry: DwellEntry): number {
    const extra =
      this.provisionalMs > 0 && this.anchor?.targetId === id
        ? this.provisionalMs / entry.dwellMs
        : 0;
    return Math.min(1, entry.value + extra);
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
      this.anchor = null;
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
    this.anchor = active ? { targetId: active.id, t } : null;
    if (active && !this.progress.has(active.id)) {
      this.progress.set(active.id, { value: 0, dwellMs: this.dwellFor(active), emitted: 0 });
    }
  }

  private queueProgress(t: number): void {
    const activeId = this.activeTarget()?.id;
    for (const [id, entry] of this.progress) {
      const shown = this.shown(id, entry);
      if (shown !== entry.emitted) {
        entry.emitted = shown;
        this.queue(this.progressEvent(id, shown, entry.dwellMs, t));
      }
      // Entries that reached 0 and were announced can go (unless engaged and active).
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
