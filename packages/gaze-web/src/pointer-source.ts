import type { Clock } from '@forsee/core';
import type { Disposable, GazeSample, GazeSource } from '@forsee/plugin-api';
import type { PointerEnvironment, PointerEventLike, PointerSourceOptions } from './contracts';
import { createBrowserPointerEnvironment, listen } from './environment';
import { ListeningSource, finite } from './listening-source';

/** Default keep-alive interval, ms. */
export const DEFAULT_KEEP_ALIVE_MS = 50;

/** Coalesced events older than this relative to the delivered event are clamped (guards odd time bases). */
const MAX_COALESCED_SPAN_MS = 100;

/** Resolved options of the pointer engine. */
export interface PointerEngineOptions {
  readonly keepAliveMs: number;
  readonly minMovePx: number;
  /** Whether events of this pointer type are handled. */
  readonly accepts: (pointerType: string) => boolean;
}

/**
 * The movement half of the pointer source, separate from listener wiring so
 * the automatic source can share it.
 *
 * Time base: every sample is stamped with the injected `Clock` (`clock.now()`
 * when the event is delivered), never the event's `timeStamp`. The gaze
 * pipeline, the dwell timers and the fixation detector all run on the host
 * clock, and `Event.timeStamp` is only guaranteed to share an origin with
 * `performance.now()` per document (Safari and some WebViews have differed),
 * not with the host clock. The one use of `timeStamp` is the difference
 * between a batch's coalesced events and the batch's last event, which spreads
 * the batch backwards from "now" in order and never before the previous sample.
 *
 * Keep-alive: a real pointer emits nothing while it rests, but dwell needs to
 * keep seeing the gaze on the target (and the fixation detector needs
 * samples to confirm a fixation). A tracker's mouse emulation or a head
 * pointer held still is exactly the case dwell exists for. So while the
 * pointer is inside the viewport the engine repeats the last valid position
 * every `keepAliveMs`, and stops the moment the pointer leaves, the window
 * blurs or the page hides, so dwell cannot continue on a stale position.
 */
export class PointerEngine {
  private last: { x: number; y: number } | null = null;
  private inside = false;
  private lastT = Number.NEGATIVE_INFINITY;
  private keepAlive: Disposable | null = null;

  constructor(
    private readonly environment: PointerEnvironment,
    private readonly clock: Clock,
    private readonly emit: (sample: GazeSample) => void,
    private readonly options: PointerEngineOptions,
  ) {}

  handle(event: PointerEventLike): void {
    if (!this.options.accepts(event.pointerType ?? 'mouse')) return;
    if (event.isPrimary === false) return;
    switch (event.type) {
      case 'pointermove':
        this.onMove(event);
        break;
      case 'pointerdown':
        this.onDown(event);
        break;
      case 'pointerup':
        // Touch has no hover: lifting the finger ends the presence. Mouse and pen keep hovering.
        if (event.pointerType === 'touch') this.leave();
        break;
      case 'pointerleave':
      case 'pointerout':
        // These fire for every element; only a move to nowhere leaves the document.
        if (event.relatedTarget == null) this.leave();
        break;
      case 'pointercancel':
        this.leave();
        break;
      default:
        break;
    }
  }

  /** Emits one invalid sample (if a valid position was current) and stops the keep-alive. */
  leave(): void {
    this.stopKeepAlive();
    if (!this.inside || !this.last) return;
    this.inside = false;
    const t = this.stamp(this.clock.now());
    this.lastT = t;
    this.emit({ x: this.last.x, y: this.last.y, t, confidence: 0, valid: false });
  }

  /** Stops timers without emitting. */
  stop(): void {
    this.stopKeepAlive();
    this.inside = false;
    this.last = null;
    this.lastT = Number.NEGATIVE_INFINITY;
  }

  private onMove(event: PointerEventLike): void {
    if (!this.environment.isVisible()) return;
    const batch = coalesced(event);
    const now = this.clock.now();
    const size = this.environment.viewport();
    for (const item of batch) {
      const { clientX: x, clientY: y } = item;
      if (!finite(x) || !finite(y)) continue;
      if (!within(x, y, size)) {
        this.leave();
        continue;
      }
      if (
        this.options.minMovePx > 0 &&
        this.inside &&
        this.last &&
        Math.hypot(x - this.last.x, y - this.last.y) < this.options.minMovePx
      ) {
        continue;
      }
      let t = now;
      if (item !== event && finite(event.timeStamp) && finite(item.timeStamp)) {
        t = now - Math.min(MAX_COALESCED_SPAN_MS, Math.max(0, event.timeStamp - item.timeStamp));
      }
      this.publish(x, y, this.stamp(t), false);
    }
  }

  private onDown(event: PointerEventLike): void {
    if ((event.button ?? 0) !== 0) return;
    if (!this.environment.isVisible()) return;
    const { clientX: x, clientY: y } = event;
    if (!finite(x) || !finite(y) || !within(x, y, this.environment.viewport())) return;
    // The press sample carries the position, so no separate movement sample is sent for it.
    this.publish(x, y, this.stamp(this.clock.now()), true);
  }

  private publish(x: number, y: number, t: number, press: boolean): void {
    this.last = { x, y };
    this.inside = true;
    this.lastT = t;
    this.emit(
      press
        ? { x, y, t, confidence: 1, valid: true, press: true }
        : { x, y, t, confidence: 1, valid: true },
    );
    this.startKeepAlive();
  }

  /** Times never go backwards. */
  private stamp(t: number): number {
    return Math.max(t, this.lastT);
  }

  private startKeepAlive(): void {
    if (this.keepAlive || this.options.keepAliveMs <= 0) return;
    this.keepAlive = this.clock.setInterval(() => {
      if (!this.inside || !this.last) return;
      const now = this.clock.now();
      // Skip when real movement was delivered recently: the repeat is only for stillness.
      if (now - this.lastT < this.options.keepAliveMs / 2) return;
      this.lastT = this.stamp(now);
      this.emit({ x: this.last.x, y: this.last.y, t: this.lastT, confidence: 1, valid: true });
    }, this.options.keepAliveMs);
  }

  private stopKeepAlive(): void {
    this.keepAlive?.dispose();
    this.keepAlive = null;
  }
}

function coalesced(event: PointerEventLike): readonly PointerEventLike[] {
  try {
    const list = event.getCoalescedEvents?.();
    if (list && list.length > 0) return list;
  } catch {
    // Some engines throw for events they did not create; fall back to the event itself.
  }
  return [event];
}

function within(x: number, y: number, size: { width: number; height: number }): boolean {
  return x >= 0 && y >= 0 && x <= size.width && y <= size.height;
}

/** Event types the movement half listens to on the document. */
export const POINTER_DOCUMENT_EVENTS = [
  'pointermove',
  'pointerdown',
  'pointerup',
  'pointerleave',
  'pointerout',
  'pointercancel',
] as const;

/**
 * Wires pointer events, `visibilitychange` and window `blur` to handlers;
 * returns the function removing every listener.
 */
export function attachPointerListeners(
  environment: PointerEnvironment,
  onEvent: (event: PointerEventLike) => void,
  onAway: () => void,
): () => void {
  const removers = POINTER_DOCUMENT_EVENTS.map((type) =>
    listen(environment.document, type, onEvent),
  );
  removers.push(
    listen(environment.document, 'visibilitychange', () => {
      if (!environment.isVisible()) onAway();
    }),
    listen(environment.window, 'blur', onAway),
  );
  return () => {
    for (const remove of removers) remove();
  };
}

/** Validates and defaults pointer options. */
export function resolvePointerOptions(
  options: Pick<PointerSourceOptions, 'keepAliveMs' | 'minMovePx' | 'touch'>,
): PointerEngineOptions {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const minMovePx = options.minMovePx ?? 0;
  if (!(keepAliveMs >= 0) || !Number.isFinite(keepAliveMs)) {
    throw new RangeError('keepAliveMs must be a finite number >= 0');
  }
  if (!(minMovePx >= 0) || !Number.isFinite(minMovePx)) {
    throw new RangeError('minMovePx must be a finite number >= 0');
  }
  const touch = options.touch ?? false;
  return { keepAliveMs, minMovePx, accepts: (type) => touch || type !== 'touch' };
}

class PointerSource extends ListeningSource {
  constructor(
    private readonly clock: Clock,
    environment: PointerEnvironment,
    private readonly engineOptions: PointerEngineOptions,
  ) {
    super('pointer', { calibrate: false, hover: true }, environment);
  }

  protected attach(emit: (sample: GazeSample) => void): () => void {
    const engine = new PointerEngine(this.environment, this.clock, emit, this.engineOptions);
    const detach = attachPointerListeners(
      this.environment,
      (event) => engine.handle(event),
      () => engine.leave(),
    );
    return () => {
      detach();
      engine.stop();
    };
  }
}

/**
 * The pointer source: any pointing device that drives the system pointer
 * (mouse, pen, OS eye control, a tracker's mouse emulation, a head pointer).
 * `kind: 'pointer'`, so the gaze engine does not smooth it again.
 *
 * Emits a sample per movement (using coalesced events), a `press` sample on
 * a primary-button `pointerdown`, repeats while resting, and one invalid
 * sample when the pointer leaves the viewport, the window blurs or the page
 * is hidden. Touch is ignored unless `touch: true`.
 */
export function createPointerSource(options: PointerSourceOptions): GazeSource {
  return new PointerSource(
    options.clock,
    options.environment ?? createBrowserPointerEnvironment(),
    resolvePointerOptions(options),
  );
}
