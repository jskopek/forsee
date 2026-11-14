import type { Clock } from '@forsee/core';
import type { Disposable, GazeSample, GazeSource, SelectionMethodId } from '@forsee/plugin-api';
import type { PointerEnvironment, PointerEventLike } from './contracts';
import { createBrowserPointerEnvironment, listen } from './environment';
import { ListeningSource } from './listening-source';
import { PointerEngine, attachPointerListeners, resolvePointerOptions } from './pointer-source';
import { TapEngine } from './tap-source';

/** What kind of input was seen last: `hover` (mouse, pen) or `tap` (touch). */
export type InputMode = 'hover' | 'tap';

/** Options of `createAutoPointerSource`. */
export interface AutoPointerSourceOptions {
  readonly clock: Clock;
  /** Defaults to the real browser. */
  readonly environment?: PointerEnvironment;
  readonly keepAliveMs?: number;
  readonly minMovePx?: number;
}

/** The automatic source plus the input mode it last saw. */
export interface AutoPointerSource {
  /** `id: 'auto'`, `hover: true`. */
  readonly source: GazeSource;
  /** Mode of the last pointer event, or null before any. Survives stop/start. */
  readonly mode: InputMode | null;
  /** Called when the mode is first seen and whenever it changes. */
  onModeChange(listener: (mode: InputMode) => void): Disposable;
}

/** The selection method suited to an input mode: dwell for hover-capable input, direct for touch. */
export function selectionMethodForMode(mode: InputMode): SelectionMethodId {
  return mode === 'hover' ? 'dwell' : 'direct';
}

class AutoSource extends ListeningSource {
  mode: InputMode | null = null;
  private readonly listeners = new Set<{ fn: (mode: InputMode) => void }>();

  constructor(
    private readonly clock: Clock,
    environment: PointerEnvironment,
    private readonly keepAliveMs: number | undefined,
    private readonly minMovePx: number | undefined,
  ) {
    super('auto', { calibrate: false, hover: true }, environment);
    // Validate options at creation, not at the first start.
    this.resolveOptions();
  }

  onModeChange(listener: (mode: InputMode) => void): Disposable {
    const entry = { fn: listener };
    this.listeners.add(entry);
    return { dispose: () => void this.listeners.delete(entry) };
  }

  protected attach(emit: (sample: GazeSample) => void): () => void {
    const pointer = new PointerEngine(this.environment, this.clock, emit, this.resolveOptions());
    const tap = new TapEngine(this.environment, this.clock, emit);

    const route = (event: PointerEventLike): void => {
      if (event.type === 'click') {
        // In hover mode the pointer engine already pressed on pointerdown.
        if (this.mode === 'tap') tap.handle(event);
        return;
      }
      const touch = event.pointerType === 'touch';
      if (
        (event.type === 'pointermove' || event.type === 'pointerdown') &&
        event.isPrimary !== false
      ) {
        this.setMode(touch ? 'tap' : 'hover', pointer);
      }
      if (touch) tap.handle(event);
      else pointer.handle(event);
    };

    const detach = attachPointerListeners(this.environment, route, () => pointer.leave());
    const removeClick = listen(this.environment.document, 'click', route);
    return () => {
      detach();
      removeClick();
      pointer.stop();
      tap.stop();
    };
  }

  private resolveOptions() {
    return resolvePointerOptions({
      ...(this.keepAliveMs === undefined ? {} : { keepAliveMs: this.keepAliveMs }),
      ...(this.minMovePx === undefined ? {} : { minMovePx: this.minMovePx }),
      touch: false,
    });
  }

  private setMode(mode: InputMode, pointer: PointerEngine): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // The mouse stays "inside" while a finger taps; do not let dwell run on its stale position.
    if (mode === 'tap') pointer.leave();
    for (const entry of [...this.listeners]) entry.fn(mode);
  }
}

/**
 * One source for mixed input: mouse and pen behave as the pointer source
 * (hover, keep-alive, presses on click), touch as the tap source (presses
 * only), switching per event by `pointerType`. `mode` and `onModeChange` let
 * the UI choose the selection method (`selectionMethodForMode`).
 */
export function createAutoPointerSource(options: AutoPointerSourceOptions): AutoPointerSource {
  const source = new AutoSource(
    options.clock,
    options.environment ?? createBrowserPointerEnvironment(),
    options.keepAliveMs,
    options.minMovePx,
  );
  return {
    source,
    get mode() {
      return source.mode;
    },
    onModeChange: (listener) => source.onModeChange(listener),
  };
}
