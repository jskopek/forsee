import type {
  GazeSample,
  GazeSource,
  GazeSourceCapabilities,
  SourceError,
} from '@forsee/plugin-api';
import type { PointerEnvironment } from './contracts';

/**
 * Lifecycle shared by the pointer, tap and automatic sources: `start` only
 * after `stop`; a missing Pointer Events implementation is reported through
 * `onError` (non-recoverable) instead of thrown; after `stop` returns nothing
 * is delivered and everything `attach` registered has been removed.
 */
export abstract class ListeningSource implements GazeSource {
  readonly kind = 'pointer' as const;
  private detach: (() => void) | null = null;

  protected constructor(
    readonly id: string,
    readonly capabilities: GazeSourceCapabilities,
    protected readonly environment: PointerEnvironment,
  ) {}

  /** Registers listeners and timers; returns a function that removes them all. */
  protected abstract attach(emit: (sample: GazeSample) => void): () => void;

  start(onSample: (sample: GazeSample) => void, onError: (error: SourceError) => void): void {
    if (this.detach) throw new Error(`The ${this.id} source is already started; call stop() first`);
    if (!this.environment.supportsPointerEvents()) {
      onError({
        code: 'unavailable',
        message: 'This browser does not support Pointer Events.',
        recoverable: false,
      });
      return;
    }
    let live = true;
    const detach = this.attach((sample) => {
      if (live) onSample(sample);
    });
    this.detach = () => {
      live = false;
      detach();
    };
  }

  stop(): void {
    const detach = this.detach;
    this.detach = null;
    detach?.();
  }
}

/** True for a finite number. */
export function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}
