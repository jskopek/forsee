import type { CommandInvocation } from '@forsee/plugin-api';
import { useLayoutEffect, type ReactNode } from 'react';
import { GazeTarget } from './gaze-target';
import { Icon } from './icons';
import { OverlayScopeContext, useGazePaused, useHostUi } from './provider';

/** Props of `PauseOverlay`. */
export interface PauseOverlayProps {
  /** What the wake target runs. Default `{ command: 'gaze.resume' }`. */
  readonly resumeCommand?: CommandInvocation;
  /** Wake target id. Default `pause/wake`. */
  readonly id?: string;
  /** Show it regardless of the kernel's pause state (tests, previews). */
  readonly forceVisible?: boolean;
}

function ActiveOverlay({
  resumeCommand,
  id,
}: {
  readonly resumeCommand: CommandInvocation;
  readonly id: string;
}): ReactNode {
  const { occlusion, services } = useHostUi();
  const wakeMs = services.gaze?.dwellConfig.wakeMs;
  useLayoutEffect(() => occlusion.acquire(), [occlusion]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="forsee-pause-title"
      data-forsee-measure="pause-overlay"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[4vh] bg-pause/95 p-[6vh] font-ui text-ink"
    >
      <h2 id="forsee-pause-title" className="text-[clamp(1.75rem,5vh,3rem)] font-bold">
        Gaze is paused
      </h2>
      <p className="max-w-[40ch] text-center text-[clamp(1rem,2.6vh,1.5rem)] text-ink-muted">
        Nothing on the screen will be selected. To carry on, keep looking at the button below
        {wakeMs === undefined ? '' : ` for ${(wakeMs / 1000).toFixed(1)} seconds`}.
      </p>
      <OverlayScopeContext.Provider value={true}>
        <GazeTarget
          id={id}
          role="wake"
          dwellClass="function"
          command={resumeCommand}
          label="Resume gaze"
          appearance="function"
          className="h-[40vh] w-[min(70vw,48rem)]"
        >
          <Icon name="play" size={64} />
          <span className="text-[clamp(1.5rem,4vh,2.5rem)]">Resume</span>
        </GazeTarget>
      </OverlayScopeContext.Provider>
    </div>
  );
}

/**
 * Full-screen cover while gaze is paused. Everything else is unregistered
 * from the target registry while it shows, so its single `wake` target
 * (which resumes through the `gaze.resume` command, after the long wake
 * dwell) is the only thing gaze can reach. Renders nothing while not paused.
 */
export function PauseOverlay({
  resumeCommand = { command: 'gaze.resume' },
  id = 'pause/wake',
  forceVisible = false,
}: PauseOverlayProps): ReactNode {
  const paused = useGazePaused();
  if (!paused && !forceVisible) return null;
  return <ActiveOverlay resumeCommand={resumeCommand} id={id} />;
}
