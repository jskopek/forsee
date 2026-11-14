import type { Clock } from '@forsee/core';
import type { GazeSample, GazeSource } from '@forsee/plugin-api';
import type { PointerEnvironment, PointerEventLike, TapSourceOptions } from './contracts';
import { createBrowserPointerEnvironment, listen } from './environment';
import { ListeningSource, finite } from './listening-source';

/**
 * The tap half of the tap source, shared with the automatic source.
 *
 * `pointerdown` is the trigger, not `click`. On iOS Safari and WKWebView a
 * `click` is synthesised after the touch ends and can lag (and is not
 * delivered at all to non-interactive targets unless they have a click
 * handler or `cursor: pointer`); `pointerdown` arrives immediately at the
 * touch position, and the keyboard never scrolls, so a touch that begins is a
 * tap. System Dwell Control (iPadOS, visionOS) performs the tap itself and
 * the page sees ordinary pointer events. A `click` is accepted only as a
 * fallback when no `pointerdown` preceded it (assistive technology that
 * activates through `click` alone); the `click` that follows a handled
 * `pointerdown` is swallowed, so a tap never fires twice.
 */
export class TapEngine {
  /** A pointerdown was emitted and its click has not arrived (or was cancelled). */
  private clickPending = false;

  constructor(
    private readonly environment: PointerEnvironment,
    private readonly clock: Clock,
    private readonly emit: (sample: GazeSample) => void,
  ) {}

  handle(event: PointerEventLike): void {
    if (event.isPrimary === false) return;
    switch (event.type) {
      case 'pointerdown':
        if ((event.button ?? 0) === 0 && this.press(event)) this.clickPending = true;
        break;
      case 'pointercancel':
        // No click follows a cancelled gesture.
        this.clickPending = false;
        break;
      case 'click':
        if (this.clickPending) {
          this.clickPending = false;
        } else if (!(event.detail === 0 && event.clientX === 0 && event.clientY === 0)) {
          // Keyboard-style clicks carry no position; skip those.
          this.press(event);
        }
        break;
      default:
        break;
    }
  }

  /** Forgets pending state. */
  stop(): void {
    this.clickPending = false;
  }

  private press(event: PointerEventLike): boolean {
    const { clientX: x, clientY: y } = event;
    if (!this.environment.isVisible() || !finite(x) || !finite(y)) return false;
    const size = this.environment.viewport();
    if (x < 0 || y < 0 || x > size.width || y > size.height) return false;
    this.emit({ x, y, t: this.clock.now(), confidence: 1, valid: true, press: true });
    return true;
  }
}

class TapSource extends ListeningSource {
  constructor(
    private readonly clock: Clock,
    environment: PointerEnvironment,
  ) {
    super('tap', { calibrate: false, hover: false }, environment);
  }

  protected attach(emit: (sample: GazeSample) => void): () => void {
    const engine = new TapEngine(this.environment, this.clock, emit);
    const handle = (event: PointerEventLike): void => engine.handle(event);
    const removers = ['pointerdown', 'pointercancel', 'click'].map((type) =>
      listen(this.environment.document, type, handle),
    );
    return () => {
      for (const remove of removers) remove();
      engine.stop();
    };
  }
}

/**
 * Tap-only source for touch screens and system dwell (iPad, Vision Pro): the
 * system does the dwelling, the app receives only taps. Emits `press: true`
 * samples at the tap position and never movement. Accepts any pointer type.
 */
export function createTapSource(options: TapSourceOptions): GazeSource {
  return new TapSource(options.clock, options.environment ?? createBrowserPointerEnvironment());
}
