import type { DwellClass } from '@forsee/plugin-api';
import type { CSSProperties, ReactNode } from 'react';
import { GazeTarget } from './gaze-target';
import { Icon } from './icons';

/** One option of a `ChoiceGroup`. */
export interface Choice<V extends string> {
  readonly value: V;
  readonly label: string;
  /** A second, smaller line (for example a voice's language). */
  readonly detail?: string;
}

/** Props of `ChoiceGroup`. */
export interface ChoiceGroupProps<V extends string> {
  /** Accessible name of the group (shown as its heading unless `hideLabel`). */
  readonly label: string;
  readonly hideLabel?: boolean;
  /** Target id prefix; each option is `<idPrefix>/<value>`. */
  readonly idPrefix: string;
  readonly choices: readonly Choice<V>[];
  /** The selected value, if any. */
  readonly value: V | undefined;
  readonly onChoose: (value: V) => void;
  /** Options per row. Default: all in one row. */
  readonly columns?: number;
  readonly dwellClass?: DwellClass;
  /** Show a check mark on the selected option (default true; tabs may leave it out). */
  readonly checkMark?: boolean;
  /** All options shown but not selectable. */
  readonly disabled?: boolean;
  readonly className?: string;
}

const OPTION =
  'h-full min-h-[3.5rem] w-full px-3 text-[clamp(0.9rem,min(2.4vh,2.2vw),1.35rem)] data-[pressed=true]:ring-4 data-[pressed=true]:ring-inset data-[pressed=true]:ring-ink';

/**
 * A set of large, mutually exclusive options, each a gaze target (the
 * selected one is marked, `aria-pressed`). Spacing between options is a
 * rest area when the group sits in a rest zone (such as a `Sheet`).
 */
export function ChoiceGroup<V extends string>({
  label,
  hideLabel = false,
  idPrefix,
  choices,
  value,
  onChoose,
  columns,
  dwellClass = 'function',
  checkMark = true,
  disabled = false,
  className = '',
}: ChoiceGroupProps<V>): ReactNode {
  const grid: CSSProperties = {
    gridTemplateColumns: `repeat(${Math.max(1, columns ?? choices.length)}, minmax(0, 1fr))`,
  };
  return (
    <div role="group" aria-label={label} className={`flex min-h-0 flex-col gap-2 ${className}`}>
      {!hideLabel && (
        <h3 className="text-[clamp(0.95rem,2.2vh,1.2rem)] font-semibold text-ink-muted">{label}</h3>
      )}
      <div
        className="grid min-h-0 flex-1 auto-rows-fr gap-[clamp(0.75rem,2vh,1.25rem)]"
        style={grid}
      >
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <GazeTarget
              key={choice.value}
              id={`${idPrefix}/${choice.value}`}
              dwellClass={dwellClass}
              label={choice.detail ? `${choice.label}, ${choice.detail}` : choice.label}
              appearance={selected ? 'function' : 'neutral'}
              pressed={selected}
              disabled={disabled}
              onActivate={() => onChoose(choice.value)}
              className={OPTION}
            >
              <span className="flex max-w-full items-center gap-2">
                {selected && checkMark && <Icon name="check" size={24} className="shrink-0" />}
                <span className="line-clamp-2 min-w-0 text-center leading-tight">
                  {choice.label}
                </span>
              </span>
              {choice.detail !== undefined && (
                <span className="max-w-full truncate text-[0.8em] font-normal text-ink-muted">
                  {choice.detail}
                </span>
              )}
            </GazeTarget>
          );
        })}
      </div>
    </div>
  );
}

/** Props of `ToggleTarget`. */
export interface ToggleTargetProps {
  readonly id: string;
  /** What is switched ("Click sound"). */
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** An on/off switch as one large gaze target: "Click sound: On". */
export function ToggleTarget({
  id,
  label,
  value,
  onChange,
  disabled = false,
  className = '',
}: ToggleTargetProps): ReactNode {
  return (
    <GazeTarget
      id={id}
      dwellClass="function"
      label={label}
      appearance={value ? 'function' : 'neutral'}
      pressed={value}
      disabled={disabled}
      onActivate={() => onChange(!value)}
      className={`${OPTION} ${className}`}
    >
      <span>{label}</span>
      <span className="text-[0.85em] font-bold">{value ? 'On' : 'Off'}</span>
    </GazeTarget>
  );
}

/** Props of `StepperControl`. */
export interface StepperControlProps {
  /** Target id prefix (`<idPrefix>/down`, `<idPrefix>/up`). */
  readonly idPrefix: string;
  /** What is changed ("Speaking rate"). */
  readonly label: string;
  /** The current value, formatted. */
  readonly valueText: string;
  readonly downLabel: string;
  readonly upLabel: string;
  readonly onStep: (direction: -1 | 1) => void;
  readonly canDown?: boolean;
  readonly canUp?: boolean;
  readonly className?: string;
}

/** "Slower [1.0x] Faster": two large targets around the current value. */
export function StepperControl({
  idPrefix,
  label,
  valueText,
  downLabel,
  upLabel,
  onStep,
  canDown = true,
  canUp = true,
  className = '',
}: StepperControlProps): ReactNode {
  return (
    <div role="group" aria-label={label} className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <h3 className="text-[clamp(0.95rem,2.2vh,1.2rem)] font-semibold text-ink-muted">{label}</h3>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr] items-stretch gap-[clamp(0.75rem,2vh,1.25rem)]">
        <GazeTarget
          id={`${idPrefix}/down`}
          dwellClass="function"
          label={downLabel}
          appearance="neutral"
          disabled={!canDown}
          onActivate={() => onStep(-1)}
          className={OPTION}
        >
          <Icon name="slower" size={26} />
          <span>{downLabel}</span>
        </GazeTarget>
        <output
          aria-live="polite"
          className="flex min-w-[6rem] items-center justify-center rounded-xl bg-surface-overlay px-4 text-[clamp(1.25rem,3vh,1.75rem)] font-bold tabular-nums"
        >
          {valueText}
        </output>
        <GazeTarget
          id={`${idPrefix}/up`}
          dwellClass="function"
          label={upLabel}
          appearance="neutral"
          disabled={!canUp}
          onActivate={() => onStep(1)}
          className={OPTION}
        >
          <Icon name="faster" size={26} />
          <span>{upLabel}</span>
        </GazeTarget>
      </div>
    </div>
  );
}
