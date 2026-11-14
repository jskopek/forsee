import type { TargetDescriptor } from '@forsee/plugin-api';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { GazeTargetProps } from './contracts';
import { useMeasuredRect } from './use-measured-rect';
import { useTargetRegistrations } from './registration';
import { TargetFace, type TargetAppearance } from './target-face';

/** `GazeTarget` props: the contract's `GazeTargetProps` plus presentation. */
export interface GazeTargetComponentProps extends GazeTargetProps {
  /** Colour scheme from the theme. Default `plain` (style it with `className`). */
  readonly appearance?: TargetAppearance;
  readonly style?: CSSProperties;
  /** For toggles and choices: the button's `aria-pressed` state. */
  readonly pressed?: boolean;
}

/**
 * The only way anything on screen becomes selectable.
 *
 * Renders a real `<button>`, measures it in app viewport CSS pixels (on
 * mount, on resize and on any scroll, through the provider's
 * `UiDomEnvironment`) and keeps a `TargetDescriptor` registered with the
 * gaze target registry while mounted. It never handles hover itself.
 *
 * - **Feedback** comes from the pipeline's events, routed per target id:
 *   the fill grows left to right with `progress` (smoothed by a short CSS
 *   transition, reset instantly at 0), the engaged target gets a highlight
 *   ring, and an activation flashes briefly. None of it re-renders React.
 * - **Activation**: with `command`, the pipeline executes it (once, with
 *   the distribution attached) and `onActivate` is feedback only; without
 *   one, `onActivate(event)` owns execution. Without a pipeline, and for
 *   Enter, Space and assistive-technology clicks, the button activates
 *   directly with an equivalent single-entry distribution (method `direct`).
 * - **Accessible**: focusable, named by `label` (or its content),
 *   `aria-disabled` when disabled, no motion with `prefers-reduced-motion`.
 */
export function GazeTarget({
  id,
  dwellClass,
  command,
  onActivate,
  likelihood,
  text,
  label,
  afterActivate,
  disabled,
  role,
  children,
  className,
  appearance,
  style,
  pressed,
}: GazeTargetComponentProps): ReactNode {
  const [rect, measureRef] = useMeasuredRect();
  const commandKey = command === undefined ? '' : JSON.stringify(command);

  const descriptor = useMemo<TargetDescriptor | null>(() => {
    if (!rect) return null;
    const parsedCommand =
      commandKey === '' ? undefined : (JSON.parse(commandKey) as TargetDescriptor['command']);
    return {
      id,
      rect,
      dwellClass,
      ...(role === undefined ? {} : { role }),
      ...(likelihood === undefined ? {} : { likelihood }),
      ...(parsedCommand === undefined ? {} : { command: parsedCommand }),
      ...(text === undefined ? {} : { text }),
      ...(label === undefined ? {} : { label }),
      ...(afterActivate === undefined ? {} : { afterActivate }),
      ...(disabled === true ? { disabled: true } : {}),
    };
  }, [id, rect, dwellClass, role, likelihood, commandKey, text, label, afterActivate, disabled]);

  const descriptors = useMemo(() => (descriptor ? [descriptor] : null), [descriptor]);
  useTargetRegistrations(descriptors);

  return (
    <TargetFace
      id={id}
      descriptor={descriptor}
      onActivation={onActivate ? (event) => onActivate(event) : undefined}
      appearance={appearance}
      accessibleName={label}
      disabled={disabled}
      className={className}
      style={style}
      measureRef={measureRef}
      pressed={pressed}
    >
      {children ?? label ?? text}
    </TargetFace>
  );
}
