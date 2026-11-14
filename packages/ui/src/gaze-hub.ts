import type { ErrorReporter } from '@forsee/core';
import type { ActivationOutcome, EngageEvent, GazePipeline } from '@forsee/gaze';
import type { ActivateEvent, Disposable, ProgressEvent } from '@forsee/plugin-api';

/**
 * Fans the gaze pipeline's events out per target id, so that a gaze sample
 * touches only the targets it concerns.
 *
 * The pipeline has one listener list per event type; subscribing every
 * on-screen target to it would call every target's listener for every
 * progress event. The hub subscribes once and keeps a map from target id to
 * that target's listeners, so a progress event for `keyboard/key-a` runs
 * only key A's listener (which writes a CSS variable on its element; no
 * React render happens on a sample).
 *
 * Direct activations (a click or Enter on a target when no pipeline fires
 * it) are delivered through the same hub (`emitActivation`), so feedback
 * and click sounds behave the same for every input path.
 */
export class GazeEventHub {
  private readonly progressListeners = new Map<string, Set<(event: ProgressEvent) => void>>();
  private readonly engageListeners = new Map<string, Set<(engaged: boolean) => void>>();
  private readonly activateListeners = new Map<
    string,
    Set<(event: ActivateEvent, outcome: ActivationOutcome) => void>
  >();
  private readonly anyActivate = new Set<
    (event: ActivateEvent, outcome: ActivationOutcome) => void
  >();
  private readonly anyEngage = new Set<(event: EngageEvent) => void>();
  private readonly lastProgress = new Map<string, ProgressEvent>();
  private engaged: string | null = null;

  constructor(private readonly reportError: ErrorReporter) {}

  /** Subscribes to `pipeline`; dispose to detach (for example when the pipeline changes). */
  attach(pipeline: GazePipeline): Disposable {
    const subscriptions = [
      pipeline.onSelection((event) => {
        if (event.type === 'progress') this.dispatchProgress(event);
      }),
      pipeline.onEngage((event) => this.dispatchEngage(event)),
      pipeline.onActivate((event, outcome) => this.emitActivation(event, outcome)),
    ];
    return {
      dispose: () => {
        for (const s of subscriptions) s.dispose();
        this.dispatchEngage({ targetId: null, inRestZone: false, t: 0 });
        for (const id of [...this.lastProgress.keys()]) {
          const last = this.lastProgress.get(id);
          if (last) this.dispatchProgress({ ...last, progress: 0 });
        }
      },
    };
  }

  /** The id of the engaged (highlighted) target, or null. */
  get engagedId(): string | null {
    return this.engaged;
  }

  /** The last progress event of a target, or undefined when it has none (or it reset). */
  progressOf(targetId: string): ProgressEvent | undefined {
    return this.lastProgress.get(targetId);
  }

  onProgress(targetId: string, listener: (event: ProgressEvent) => void): Disposable {
    return add(this.progressListeners, targetId, listener);
  }

  onEngagedChange(targetId: string, listener: (engaged: boolean) => void): Disposable {
    return add(this.engageListeners, targetId, listener);
  }

  onActivate(
    targetId: string,
    listener: (event: ActivateEvent, outcome: ActivationOutcome) => void,
  ): Disposable {
    return add(this.activateListeners, targetId, listener);
  }

  /** Every activation of any target (click sounds, logging). */
  onAnyActivate(listener: (event: ActivateEvent, outcome: ActivationOutcome) => void): Disposable {
    this.anyActivate.add(listener);
    return { dispose: () => void this.anyActivate.delete(listener) };
  }

  /** Every engage change (the prediction strip pins the candidate being dwelt on). */
  onAnyEngage(listener: (event: EngageEvent) => void): Disposable {
    this.anyEngage.add(listener);
    return { dispose: () => void this.anyEngage.delete(listener) };
  }

  /** Delivers an activation to the target's listeners, then to every `onAnyActivate` listener. */
  emitActivation(event: ActivateEvent, outcome: ActivationOutcome): void {
    this.call(this.activateListeners.get(event.targetId), (fn) => fn(event, outcome));
    this.call(this.anyActivate, (fn) => fn(event, outcome));
  }

  private dispatchProgress(event: ProgressEvent): void {
    if (event.progress <= 0) this.lastProgress.delete(event.targetId);
    else this.lastProgress.set(event.targetId, event);
    this.call(this.progressListeners.get(event.targetId), (fn) => fn(event));
  }

  private dispatchEngage(event: EngageEvent): void {
    const previous = this.engaged;
    const next = event.targetId;
    if (previous !== next) {
      this.engaged = next;
      if (previous !== null) this.call(this.engageListeners.get(previous), (fn) => fn(false));
      if (next !== null) this.call(this.engageListeners.get(next), (fn) => fn(true));
    }
    this.call(this.anyEngage, (fn) => fn(event));
  }

  private call<F>(set: Set<F> | undefined, invoke: (fn: F) => void): void {
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      if (!set.has(fn)) continue;
      try {
        invoke(fn);
      } catch (error) {
        this.reportError(error, 'ui.gazeHub');
      }
    }
  }
}

function add<F>(map: Map<string, Set<F>>, key: string, listener: F): Disposable {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      const current = map.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) map.delete(key);
    },
  };
}
