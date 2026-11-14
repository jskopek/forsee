import type { ActivationOutcome } from '@forsee/gaze';
import { singleEntryDistribution, withActivationDistribution } from '@forsee/gaze';
import type {
  ActivateEvent,
  Disposable,
  ProgressEvent,
  TargetDescriptor,
} from '@forsee/plugin-api';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useHostUi } from './provider';

/** Visual styles of a target (colours from the Tailwind preset). */
export type TargetAppearance =
  'key' | 'space' | 'function' | 'danger' | 'neutral' | 'speak' | 'prediction' | 'plain';

const APPEARANCE: Readonly<Record<TargetAppearance, string>> = {
  key: 'rounded-xl border-2 border-key-border bg-key text-ink shadow-[inset_0_-5px_0_0_theme(colors.key-edge)]',
  space:
    'rounded-xl border-2 border-space-border bg-space text-ink shadow-[inset_0_-5px_0_0_theme(colors.space-edge)]',
  function:
    'rounded-xl border-2 border-fn-border bg-fn text-ink shadow-[inset_0_-5px_0_0_theme(colors.fn-edge)]',
  danger:
    'rounded-xl border-2 border-danger-border bg-danger text-ink shadow-[inset_0_-5px_0_0_theme(colors.danger-edge)]',
  neutral:
    'rounded-xl border-2 border-neutral-border bg-neutral text-ink shadow-[inset_0_-5px_0_0_theme(colors.neutral-edge)]',
  speak:
    'rounded-xl border-2 border-speak-border bg-speak text-ink shadow-[inset_0_-5px_0_0_theme(colors.speak-edge)]',
  prediction:
    'rounded-xl border-2 border-prediction-border bg-prediction text-ink shadow-[inset_0_-4px_0_0_theme(colors.prediction-edge)]',
  plain: '',
};

const BASE =
  'group isolate overflow-hidden font-ui font-semibold leading-none select-none touch-manipulation outline-none ' +
  'focus-visible:ring-4 focus-visible:ring-focus ' +
  'data-[engaged=true]:ring-4 data-[engaged=true]:ring-inset data-[engaged=true]:ring-focus ' +
  'data-[fired=true]:animate-forsee-fired motion-reduce:data-[fired=true]:animate-none ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const FILL =
  'pointer-events-none absolute inset-0 z-0 origin-left bg-black/35 ' +
  '[transform:scaleX(var(--forsee-dwell,0))] ' +
  '[transition:transform_var(--forsee-dwell-transition,0ms)_linear] motion-reduce:[transition:none]';

const BAR =
  'pointer-events-none absolute inset-x-0 bottom-0 z-0 h-1.5 origin-left bg-dwell ' +
  '[transform:scaleX(var(--forsee-dwell,0))] ' +
  '[transition:transform_var(--forsee-dwell-transition,0ms)_linear] motion-reduce:[transition:none]';

/** How long the "fired" flash stays on, ms. */
export const FIRED_FLASH_MS = 320;

/** Longest smoothing transition between two progress events, ms. */
const MAX_PROGRESS_TRANSITION_MS = 120;

/**
 * Writes a progress event to the target's element: the fill and the bar
 * scale to `progress` (CSS variable `--forsee-dwell`). Between two events
 * the fill glides linearly for up to `MAX_PROGRESS_TRANSITION_MS` (a
 * quarter of the target's dwell time at most), so it moves smoothly even at
 * low source rates; `progress` 0 resets instantly.
 */
export function applyProgress(
  element: HTMLElement,
  event: Pick<ProgressEvent, 'progress' | 'dwellMs'>,
): void {
  const progress = Math.min(1, Math.max(0, Number.isFinite(event.progress) ? event.progress : 0));
  const transition =
    progress === 0
      ? 0
      : Math.round(Math.min(MAX_PROGRESS_TRANSITION_MS, Math.max(0, event.dwellMs / 4)));
  element.style.setProperty('--forsee-dwell-transition', `${transition}ms`);
  element.style.setProperty('--forsee-dwell', progress === 0 ? '0' : progress.toFixed(4));
  element.dataset.dwelling = progress > 0 ? 'true' : 'false';
}

/** Props of the internal `TargetFace`. */
export interface TargetFaceProps {
  readonly id: string;
  /**
   * What is (or would be) registered for this target. Used for direct
   * activation (role, disabled, command, rect, text). Null before the
   * first measurement.
   */
  readonly descriptor: TargetDescriptor | null;
  /** Called for every activation of this target with who executes it. */
  readonly onActivation?: ((event: ActivateEvent, outcome: ActivationOutcome) => void) | undefined;
  readonly appearance?: TargetAppearance | undefined;
  /** Accessible name, when the visible content is not text. */
  readonly accessibleName?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** A React 19 ref callback for measuring (may return a cleanup). */
  readonly measureRef?:
    ((element: HTMLButtonElement | null) => (() => void) | undefined) | undefined;
  /** `absolute` when the parent positions the target (keyboard keys, prediction slots). Default `relative`. */
  readonly position?: 'relative' | 'absolute' | undefined;
  readonly children?: ReactNode;
}

/**
 * The rendered part of a gaze target: a real `<button>` with the dwell fill,
 * engaged highlight and fired flash, all driven straight from the event hub
 * (no React state, so a gaze sample re-renders nothing), and the direct
 * activation path for clicks and the keyboard.
 */
export function TargetFace({
  id,
  descriptor,
  onActivation,
  appearance = 'plain',
  accessibleName,
  disabled = false,
  className = '',
  style,
  measureRef,
  position = 'relative',
  children,
}: TargetFaceProps): ReactNode {
  const { services, hub, reportError } = useHostUi();
  const { kernel } = services;
  const elementRef = useRef<HTMLButtonElement | null>(null);

  const setRef = useCallback(
    (element: HTMLButtonElement | null) => {
      elementRef.current = element;
      const cleanup = measureRef?.(element);
      return () => {
        elementRef.current = null;
        cleanup?.();
      };
    },
    [measureRef],
  );

  const deliver = useEffectEvent((event: ActivateEvent, outcome: ActivationOutcome) => {
    onActivation?.(event, outcome);
  });

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    let flash: Disposable | null = null;
    const last = hub.progressOf(id);
    applyProgress(element, last ?? { progress: 0, dwellMs: 0 });
    element.dataset.engaged = hub.engagedId === id ? 'true' : 'false';
    const subscriptions = [
      hub.onProgress(id, (event) => applyProgress(element, event)),
      hub.onEngagedChange(id, (engaged) => {
        element.dataset.engaged = engaged ? 'true' : 'false';
      }),
      hub.onActivate(id, (event, outcome) => {
        flash?.dispose();
        element.dataset.fired = 'true';
        flash = kernel.clock.setTimeout(() => {
          element.dataset.fired = 'false';
          flash = null;
        }, FIRED_FLASH_MS);
        deliver(event, outcome);
      }),
    ];
    return () => {
      for (const s of subscriptions) s.dispose();
      flash?.dispose();
    };
  }, [hub, id, kernel]);

  /** A click, tap or key press on the element itself: the same path as a direct press. */
  const activateDirectly = (): void => {
    const gaze = services.gaze;
    const target: TargetDescriptor = descriptor ?? {
      id,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      dwellClass: 'function',
    };
    if (disabled || target.disabled === true) return;
    const role = target.role ?? 'select';
    if (role === 'rest') return;
    const paused = gaze?.paused ?? false;
    if (paused ? role !== 'wake' : role === 'wake') return;

    const event: ActivateEvent = {
      type: 'activate',
      targetId: id,
      method: 'direct',
      repeatIndex: 0,
      point: {
        x: target.rect.x + target.rect.width / 2,
        y: target.rect.y + target.rect.height / 2,
      },
      distribution: singleEntryDistribution(target),
      t: kernel.clock.now(),
    };
    const command = target.command ?? (role === 'wake' ? { command: 'gaze.resume' } : undefined);
    if (!command) {
      hub.emitActivation(event, { executedBy: 'owner' });
      return;
    }
    const invocation = withActivationDistribution(command, event);
    kernel.commands.execute(invocation.command, invocation.args, 'ui').then(
      () => hub.emitActivation(event, { executedBy: 'pipeline', invocation, failed: false }),
      (error: unknown) => {
        reportError(error, `ui.target.command:${invocation.command}`);
        hub.emitActivation(event, { executedBy: 'pipeline', invocation, failed: true });
      },
    );
  };

  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    // `detail` 0: a keyboard or assistive-technology click; always direct.
    // A pointer click is direct only when no pipeline will see it as a
    // press: without a pipeline, or with the dwell method (which ignores
    // presses). The direct and switch methods fire presses themselves.
    const gaze = services.gaze;
    if (e.detail !== 0 && gaze && gaze.selectionMethod !== 'dwell') return;
    activateDirectly();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (!e.repeat) activateDirectly();
  };

  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>): void => {
    // Stops the browser's own click on Space release (handled on keydown).
    if (e.key === ' ') e.preventDefault();
  };

  return (
    <button
      ref={setRef}
      type="button"
      data-target-id={id}
      data-forsee-measure={id}
      aria-label={accessibleName}
      aria-disabled={disabled ? true : undefined}
      className={`${position === 'absolute' ? 'absolute' : 'relative'} ${BASE} ${APPEARANCE[appearance]} ${className}`}
      style={style}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <span aria-hidden="true" data-part="fill" className={FILL} />
      <span aria-hidden="true" data-part="bar" className={BAR} />
      <span className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-1 px-1">
        {children}
      </span>
    </button>
  );
}
