/**
 * PROTOTYPE — screen layout option A ("top bar", after OptiKey).
 *
 * Every fixed control sits in the message row: Clear at its left end, then
 * the message, then Speak, Pause and Settings at its right end, so the
 * destructive key and Speak are at opposite ends. The keyboard gets the full
 * width. There is no side rail, so the in-place Faster/Slower dwell controls
 * are not on this screen.
 *
 * To remove option A: delete this file, the `screen === 'top'` branch in
 * `MainScreen.tsx`, and the `top` value of `screenLayout` in
 * `runtime/settings.ts` and `runtime/chrome-keys.ts`.
 */
import { AppFrame, GazeTarget, Icon, PauseButton, PredictionStrip } from '@forsee/ui';
import type { ReactNode } from 'react';

const GAP = 'gap-[clamp(0.375rem,1vw,0.75rem)]';
const CONTROL = 'flex w-[clamp(6rem,11vw,10rem)] shrink-0';

export interface TopBarScreenProps {
  readonly banner: ReactNode;
  /** The composition bar (and any notice beside it). */
  readonly message: ReactNode;
  readonly speak: ReactNode;
  readonly settings: ReactNode;
  readonly keyboard: ReactNode;
  readonly inert: boolean;
  readonly overlay: ReactNode;
}

export function TopBarScreen({
  banner,
  message,
  speak,
  settings,
  keyboard,
  inert,
  overlay,
}: TopBarScreenProps): ReactNode {
  const messageRow = (
    <div className={`flex h-full min-h-0 ${GAP}`}>
      <div className={CONTROL}>
        <GazeTarget
          id="actions/clear"
          dwellClass="destructive"
          command={{ command: 'composition.clear' }}
          label="Clear"
          appearance="danger"
          className="h-full min-h-[3.5rem] w-full px-2"
        >
          <Icon name="clear" size={28} />
          <span className="text-[clamp(0.95rem,2.2vh,1.35rem)]">Clear</span>
        </GazeTarget>
      </div>
      <div className="min-w-0 flex-1">{message}</div>
      <div className={CONTROL}>{speak}</div>
      <div className={CONTROL}>
        <PauseButton />
      </div>
      <div className={CONTROL}>{settings}</div>
    </div>
  );
  return (
    <AppFrame
      banner={banner}
      composition={messageRow}
      keyboard={keyboard}
      inert={inert}
      overlay={overlay}
      predictions={<PredictionStrip />}
    />
  );
}
