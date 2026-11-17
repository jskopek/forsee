import type { Point } from '@forsee/plugin-api';
import type { InputEventTarget, PointerEnvironment, PointerEventLike } from './contracts';

/**
 * Test doubles for the pointer and tap sources, so other packages (the UI)
 * can drive them in Node tests without a DOM. Imported from
 * `@forsee/gaze-web/testing`.
 */

type Listener = (event: PointerEventLike) => void;

/** An event target that records listeners and dispatches plain event objects. */
export class FakeInputTarget implements InputEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Calls the listeners registered for `event.type` (a snapshot, like the DOM). */
  dispatch(event: PointerEventLike): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }

  /** Listeners registered for `type`, or for all types. For leak checks. */
  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/** Fields of `pointerEvent`; everything is optional. */
export interface PointerEventInit {
  readonly pointerType?: string;
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
  readonly isPrimary?: boolean;
  readonly timeStamp?: number;
  readonly relatedTarget?: unknown;
  readonly detail?: number;
  /** Becomes `getCoalescedEvents()`: positions oldest first, each with an optional `timeStamp`. */
  readonly coalesced?: readonly {
    readonly x: number;
    readonly y: number;
    readonly timeStamp?: number;
  }[];
}

/** Builds a plain pointer event: a mouse, primary button, at (0, 0) unless given. */
export function pointerEvent(type: string, init: PointerEventInit = {}): PointerEventLike {
  const base = {
    type,
    pointerType: init.pointerType ?? 'mouse',
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: init.button ?? 0,
    isPrimary: init.isPrimary ?? true,
    timeStamp: init.timeStamp ?? 0,
    relatedTarget: init.relatedTarget ?? null,
    detail: init.detail ?? 1,
  };
  const { coalesced } = init;
  if (!coalesced) return base;
  return {
    ...base,
    getCoalescedEvents: () =>
      coalesced.map((c) => ({
        ...base,
        clientX: c.x,
        clientY: c.y,
        timeStamp: c.timeStamp ?? base.timeStamp,
      })),
  };
}

/** A scriptable `PointerEnvironment`: 1000 x 800 viewport, visible, supported. */
export class FakePointerEnvironment implements PointerEnvironment {
  readonly document = new FakeInputTarget();
  readonly window = new FakeInputTarget();
  supported = true;
  width = 1000;
  height = 800;
  visible = true;

  supportsPointerEvents(): boolean {
    return this.supported;
  }

  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Listeners on the document and the window together. */
  listenerCount(): number {
    return this.document.listenerCount() + this.window.listenerCount();
  }

  move(x: number, y: number, init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('pointermove', { ...init, x, y }));
  }

  down(x: number, y: number, init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('pointerdown', { ...init, x, y }));
  }

  up(x: number, y: number, init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('pointerup', { ...init, x, y }));
  }

  click(x: number, y: number, init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('click', { ...init, x, y }));
  }

  cancel(init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('pointercancel', init));
  }

  /** The pointer leaves the document (`pointerout` and `pointerleave` with no related target). */
  leave(init: PointerEventInit = {}): void {
    this.document.dispatch(pointerEvent('pointerout', { ...init, relatedTarget: null }));
    this.document.dispatch(pointerEvent('pointerleave', { ...init, relatedTarget: null }));
  }

  /** Changes visibility and fires `visibilitychange`. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.document.dispatch(pointerEvent('visibilitychange'));
  }

  /** Window loses focus. */
  blur(): void {
    this.window.dispatch(pointerEvent('blur'));
  }

  /** A full touch tap: down, up, then the synthesised click. */
  tap(x: number, y: number, options: { click?: boolean } = {}): void {
    const init = { pointerType: 'touch' };
    this.down(x, y, init);
    this.up(x, y, init);
    if (options.click ?? true) this.click(x, y, init);
  }
}

/** The clock the script advances; `FakeClock` from `@forsee/core` fits. */
export interface AdvanceableClock {
  advance(ms: number): void;
}

interface ScriptStep {
  readonly action: (env: FakePointerEnvironment) => void;
  readonly afterMs: number;
}

/** Options of `PointerScript`. */
export interface PointerScriptOptions {
  /** Event rate while moving, Hz. Default 60. */
  readonly rateHz?: number;
  /** Pointer type of the generated events. Default `mouse`. */
  readonly pointerType?: string;
}

/**
 * A `GazeScript`-style builder of fake pointer input: moves, rests, presses
 * and leaves, played against a `FakePointerEnvironment` while advancing a
 * fake clock. A real pointer emits nothing while it rests, so `rest` only
 * advances time (the source's keep-alive supplies the samples).
 *
 * ```ts
 * new PointerScript()
 *   .moveTo({ x: 100, y: 100 }, 200)
 *   .rest(800)
 *   .press()
 *   .leave(100)
 *   .play(env, clock);
 * ```
 */
export class PointerScript {
  private readonly steps: ScriptStep[] = [];
  private readonly intervalMs: number;
  private readonly pointerType: string;
  private position: Point = { x: 0, y: 0 };

  constructor(options: PointerScriptOptions = {}) {
    this.intervalMs = 1000 / (options.rateHz ?? 60);
    this.pointerType = options.pointerType ?? 'mouse';
  }

  /** Jumps to `point` (one move event), then waits `afterMs`. */
  jumpTo(point: Point, afterMs = 0): this {
    this.position = point;
    const init = { pointerType: this.pointerType };
    this.steps.push({ action: (env) => env.move(point.x, point.y, init), afterMs });
    return this;
  }

  /** Moves linearly to `point` over `durationMs`, one event per tick. */
  moveTo(point: Point, durationMs: number): this {
    const from = this.position;
    const count = Math.max(1, Math.round(durationMs / this.intervalMs));
    const init = { pointerType: this.pointerType };
    for (let i = 1; i <= count; i += 1) {
      const x = from.x + ((point.x - from.x) * i) / count;
      const y = from.y + ((point.y - from.y) * i) / count;
      this.steps.push({ action: (env) => env.move(x, y, init), afterMs: durationMs / count });
    }
    this.position = point;
    return this;
  }

  /** Waits without any event. */
  rest(durationMs: number): this {
    this.steps.push({ action: () => undefined, afterMs: durationMs });
    return this;
  }

  /** Primary-button press and release at the current position. */
  press(afterMs = 0): this {
    const { x, y } = this.position;
    const init = { pointerType: this.pointerType };
    this.steps.push({
      action: (env) => {
        env.down(x, y, init);
        env.up(x, y, init);
      },
      afterMs,
    });
    return this;
  }

  /** The pointer leaves the document, then `afterMs` passes. */
  leave(afterMs = 0): this {
    this.steps.push({ action: (env) => env.leave({ pointerType: this.pointerType }), afterMs });
    return this;
  }

  /** Plays the steps in order, advancing `clock` after each. */
  play(env: FakePointerEnvironment, clock: AdvanceableClock): void {
    for (const step of this.steps) {
      step.action(env);
      if (step.afterMs > 0) clock.advance(step.afterMs);
    }
  }
}

export { FakePhoneGazeServer, FakePhoneGazeSocket } from './phone-gaze-testing';
