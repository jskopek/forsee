import { GAZE_SETTINGS_NAMESPACE, adjustDwell, type DwellAdjustment } from '@forsee/gaze';
import { DWELL_CLASSES, type CommandInvocation, type DwellClass } from '@forsee/plugin-api';
import { useState, type ReactNode } from 'react';
import { GazeTarget } from './gaze-target';
import { Icon } from './icons';
import { useHostUi, useSetting } from './provider';

const BUTTON = 'h-full w-full min-h-[3.5rem] px-2';
const LABEL = 'text-[clamp(0.95rem,2.2vh,1.35rem)]';

/** Props of `SpeakButton`. */
export interface SpeakButtonProps {
  /** What "Speak" runs (the assembler decides the command id). */
  readonly command: CommandInvocation;
  /** True while speech is playing: the button turns into Stop (when `stopCommand` is given). */
  readonly speaking?: boolean;
  /** What "Stop" runs while speaking. */
  readonly stopCommand?: CommandInvocation;
  /** Target id. Default `actions/speak` (Stop uses `<id>-stop`). */
  readonly id?: string;
  readonly label?: string;
  readonly className?: string;
}

/** Speaks the composition; while speaking, it becomes a Stop button. */
export function SpeakButton({
  command,
  speaking = false,
  stopCommand,
  id = 'actions/speak',
  label = 'Speak',
  className = '',
}: SpeakButtonProps): ReactNode {
  if (speaking && stopCommand) {
    return (
      <GazeTarget
        id={`${id}-stop`}
        dwellClass="function"
        command={stopCommand}
        label="Stop speaking"
        appearance="danger"
        className={`${BUTTON} ${className}`}
      >
        <Icon name="stop" size={32} />
        <span className={LABEL}>Stop</span>
        <span className="sr-only">Speaking now</span>
      </GazeTarget>
    );
  }
  return (
    <GazeTarget
      id={id}
      dwellClass="function"
      command={command}
      label={label}
      appearance="speak"
      className={`${BUTTON} ${speaking ? 'animate-pulse motion-reduce:animate-none' : ''} ${className}`}
    >
      <Icon name="speak" size={32} />
      <span className={LABEL}>{speaking ? 'Speaking' : label}</span>
    </GazeTarget>
  );
}

/** Props of `PauseButton`. */
export interface PauseButtonProps {
  /** Default `{ command: 'gaze.pause' }`. */
  readonly command?: CommandInvocation;
  readonly id?: string;
  readonly className?: string;
}

/** Pauses gaze selection (the pause overlay's wake target resumes it). */
export function PauseButton({
  command = { command: 'gaze.pause' },
  id = 'actions/pause',
  className = '',
}: PauseButtonProps): ReactNode {
  return (
    <GazeTarget
      id={id}
      dwellClass="function"
      command={command}
      label="Pause gaze"
      appearance="neutral"
      className={`${BUTTON} ${className}`}
    >
      <Icon name="pause" size={28} />
      <span className={LABEL}>Pause</span>
    </GazeTarget>
  );
}

/** Props of `DwellSpeedControls`. */
export interface DwellSpeedControlsProps {
  /** Classes each step changes. Default all four. */
  readonly classes?: readonly DwellClass[];
  /** Step, ms. Default 100. */
  readonly stepMs?: number;
  /** Target id prefix. Default `actions/dwell`. */
  readonly idPrefix?: string;
  /** Lay the two buttons out side by side instead of stacked. */
  readonly horizontal?: boolean;
  readonly className?: string;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * "Faster" and "slower" in place (no settings screen): each step runs
 * `adjustDwell` on the pipeline's current dwell configuration, applies it
 * with `pipeline.setDwellConfig`, stores the changed classes in the
 * `app.gaze` settings namespace (when its schema is registered) and shows
 * the new letter dwell time.
 */
export function DwellSpeedControls({
  classes = DWELL_CLASSES,
  stepMs,
  idPrefix = 'actions/dwell',
  horizontal = false,
  className = '',
}: DwellSpeedControlsProps): ReactNode {
  const { services, reportError } = useHostUi();
  const { kernel, gaze } = services;
  const stored = useSetting(GAZE_SETTINGS_NAMESPACE, 'dwell.letterMs');
  const [local, setLocal] = useState<{ letterMs: number; atLimit: boolean } | null>(null);
  const letterMs =
    typeof stored === 'number' ? stored : (local?.letterMs ?? gaze?.dwellConfig.classMs.letter);

  const step = (direction: DwellAdjustment['direction']): void => {
    if (!gaze) return;
    try {
      const result = adjustDwell(gaze.dwellConfig, {
        direction,
        classes,
        ...(stepMs === undefined ? {} : { stepMs }),
      });
      gaze.setDwellConfig(result.config);
      if (kernel.settings.hasSchema(GAZE_SETTINGS_NAMESPACE)) {
        for (const cls of classes) {
          const value = result.changed[cls];
          if (value !== undefined)
            kernel.settings.set(GAZE_SETTINGS_NAMESPACE, `dwell.${cls}Ms`, value);
        }
      }
      setLocal({ letterMs: result.config.classMs.letter, atLimit: result.atLimit });
    } catch (error) {
      reportError(error, 'ui.dwellSpeed');
    }
  };

  return (
    <div
      role="group"
      aria-label="Dwell speed"
      className={`flex h-full w-full gap-2 ${horizontal ? 'flex-row' : 'flex-col'} ${className}`}
    >
      <GazeTarget
        id={`${idPrefix}/faster`}
        dwellClass="function"
        label="Faster"
        appearance="neutral"
        disabled={!gaze}
        onActivate={() => step('faster')}
        className={`${BUTTON} flex-1`}
      >
        <Icon name="faster" size={26} />
        <span className={LABEL}>Faster</span>
      </GazeTarget>
      <output
        aria-live="polite"
        className="flex flex-col items-center justify-center rounded-lg bg-surface-raised px-2 py-1 text-center font-ui text-ink"
      >
        <span className="text-xs text-ink-muted">Letter dwell</span>
        <span className="text-xl font-bold tabular-nums">
          {letterMs === undefined ? '–' : formatSeconds(letterMs)}
        </span>
        {local?.atLimit === true && <span className="text-xs text-ink-muted">limit reached</span>}
      </output>
      <GazeTarget
        id={`${idPrefix}/slower`}
        dwellClass="function"
        label="Slower"
        appearance="neutral"
        disabled={!gaze}
        onActivate={() => step('slower')}
        className={`${BUTTON} flex-1`}
      >
        <Icon name="slower" size={26} />
        <span className={LABEL}>Slower</span>
      </GazeTarget>
    </div>
  );
}
