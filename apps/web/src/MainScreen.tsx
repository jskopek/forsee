import {
  AppFrame,
  CompositionBar,
  GazeTarget,
  HostUiProvider,
  Icon,
  KeyboardView,
  NoticeCard,
  PauseButton,
  PauseOverlay,
  PhraseBar,
  PredictionStrip,
  SpeakButton,
  useClickSound,
  useComposition,
  useMediaQuery,
  useSetting,
  type ControlBarPosition,
} from '@forsee/ui';
import { useCallback, useState, type ReactNode } from 'react';
import {
  useActiveLayout,
  useProblems,
  useQuickfireTiles,
  useSpeaking,
  useSpeechLocked,
} from './hooks';
import { usePhysicalKeyboard, useUnlockSpeechOnGesture } from './input';
import { useNotices, type Notice } from './notices';
import type { ForseeRuntime } from './runtime';
import { controlBarSettingOf, type ControlBarSetting } from './runtime/settings';
import { SettingsPositionProvider } from './settings-position';
import { SettingsSheet } from './SettingsSheet';

/** The app once the runtime is up: the provider of the host UI around the screen. */
export function MainScreen({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  return (
    <HostUiProvider services={runtime.hostUi} reportError={runtime.reportError}>
      <SettingsPositionProvider>
        <Screen runtime={runtime} />
      </SettingsPositionProvider>
    </HostUiProvider>
  );
}

const SIDE_ITEM = 'flex min-h-0 min-w-0';

/** Where the control bar goes for a setting and orientation. */
export function controlBarPosition(
  setting: ControlBarSetting,
  portrait: boolean,
): ControlBarPosition {
  if (setting !== 'auto') return setting;
  return portrait ? 'top' : 'right';
}

/** Keyboard sides that touch the screen's edge (they get the larger edge keys). */
function keyboardEdges(position: ControlBarPosition): {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
} {
  return {
    top: false,
    right: position !== 'right',
    bottom: position !== 'bottom',
    left: position !== 'left',
  };
}

function Screen({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const portrait = useMediaQuery('(orientation: portrait)');
  const layout = useActiveLayout(runtime);
  const speaking = useSpeaking(runtime);
  const locked = useSpeechLocked(runtime);
  const tiles = useQuickfireTiles(runtime);
  const problems = useProblems(runtime);
  const { notices, dismiss } = useNotices(runtime);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const clickSound = useSetting(runtime.settings.namespaces.ui, 'clickSound') === true;
  const physicalKeyboard = useSetting(runtime.settings.namespaces.ui, 'physicalKeyboard') === true;
  useClickSound({ enabled: clickSound });
  useUnlockSpeechOnGesture(runtime);
  usePhysicalKeyboard(runtime, physicalKeyboard && !settingsOpen);

  const problemCount = problems.issues.length + problems.errors.length;
  const position = controlBarPosition(
    controlBarSettingOf(useSetting(runtime.settings.namespaces.ui, 'controlBar')),
    portrait,
  );
  const vertical = position === 'left' || position === 'right';

  const banner = locked ? (
    <UnlockPrompt onUnlock={() => runtime.speech.unlock()} />
  ) : tiles.length > 0 ? (
    <PhraseBar label="Quick replies" idPrefix="quickfire" tiles={tiles} />
  ) : null;

  const speak = (
    <SpeakButton
      command={{ command: 'composition.speak' }}
      speaking={speaking}
      stopCommand={{ command: 'speech.stop' }}
    />
  );
  const settingsButton = (
    <GazeTarget
      id="actions/settings"
      dwellClass="function"
      label={problemCount > 0 ? `Settings, ${problemCount} problems` : 'Settings'}
      appearance="neutral"
      onActivate={() => setSettingsOpen(true)}
      className="h-full min-h-[3.5rem] w-full px-2"
    >
      <Icon name="settings" size={28} />
      <span className="text-[clamp(0.95rem,2.2vh,1.35rem)]">Settings</span>
      {problemCount > 0 && (
        <span
          data-part="problem-badge"
          className="absolute right-1.5 top-1.5 rounded-full bg-accent px-2 py-0.5 text-sm font-bold text-surface"
        >
          {problemCount}
        </span>
      )}
    </GazeTarget>
  );

  const notice = notices[0];
  const composition = (
    <div className="flex h-full min-h-0 gap-[clamp(0.375rem,1vw,0.75rem)]">
      <CompositionBar className="min-w-0 flex-1" />
      {notice && (
        <NoticeSlot
          runtime={runtime}
          notice={notice}
          count={notices.length}
          onDismiss={dismiss}
          portrait={portrait}
        />
      )}
    </div>
  );

  // The control bar holds only Speak, Pause and Settings; plugins cannot add
  // to it. Speak is always nearest the end of the message and takes the space
  // Pause and Settings leave; Settings is the furthest from it. On top, the
  // bar wraps the message: Settings, Pause, message, Speak.
  const fixed = vertical
    ? 'flex-none h-[clamp(5rem,15vh,8.5rem)]'
    : 'flex-none w-[clamp(6.5rem,11vw,10.5rem)]';
  const pause = <PauseButton />;
  const actions =
    position === 'top' ? (
      <div className={`${SIDE_ITEM} flex-1`}>{speak}</div>
    ) : (
      <>
        <div className={`${SIDE_ITEM} flex-1`}>{speak}</div>
        <div className={`${SIDE_ITEM} ${fixed}`}>{pause}</div>
        <div className={`${SIDE_ITEM} ${fixed}`}>{settingsButton}</div>
      </>
    );
  const actionsStart =
    position === 'top' ? (
      <>
        <div className={`${SIDE_ITEM} flex-1`}>{settingsButton}</div>
        <div className={`${SIDE_ITEM} flex-1`}>{pause}</div>
      </>
    ) : undefined;

  const keyboard = (
    <KeyboardView
      key={layout.definition.id}
      runtime={layout.runtime}
      targets={runtime.gaze.targets}
      // Only sides that touch the screen's edge get the larger edge keys.
      edges={keyboardEdges(position)}
    />
  );
  const overlay = (
    <>
      <PauseOverlay />
      {settingsOpen && (
        <SettingsSheet
          runtime={runtime}
          problems={problems}
          portrait={portrait}
          onClose={closeSettings}
        />
      )}
    </>
  );

  return (
    <AppFrame
      banner={banner}
      composition={composition}
      predictions={<PredictionStrip />}
      keyboard={keyboard}
      actions={actions}
      actionsPosition={position}
      actionsStart={actionsStart}
      inert={settingsOpen}
      overlay={overlay}
    />
  );
}

/** The full-width "turn on speech" prompt, selectable by dwell, click or tap. */
function UnlockPrompt({ onUnlock }: { readonly onUnlock: () => void }): ReactNode {
  return (
    <GazeTarget
      id="speech/unlock"
      dwellClass="function"
      label="Turn on speech"
      appearance="speak"
      onActivate={() => onUnlock()}
      className="h-full w-full px-4"
    >
      <span className="flex items-center gap-3 text-[clamp(1rem,2.6vh,1.5rem)]">
        <Icon name="speak" size={28} />
        <span>
          Speech is off until this page gets a click or tap. Select here (a carer may need to click
          once).
        </span>
      </span>
    </GazeTarget>
  );
}

function NoticeSlot({
  runtime,
  notice,
  count,
  onDismiss,
  portrait,
}: {
  readonly runtime: ForseeRuntime;
  readonly notice: Notice;
  readonly count: number;
  readonly onDismiss: (id: string) => void;
  readonly portrait: boolean;
}): ReactNode {
  const composition = useComposition();
  const unspoken = notice.unspoken;
  const canRestore = unspoken !== undefined && composition.text === '';
  const restore = (): void => {
    if (unspoken === undefined) return;
    const { kernel } = runtime;
    // Undoing the commit restores the text exactly; otherwise type it again.
    const run =
      kernel.composition.text === '' && kernel.composition.nextUndoReason === 'commit'
        ? kernel.commands.execute('composition.undo', undefined, 'app')
        : kernel.commands.execute('composition.insert', { text: unspoken }, 'app');
    run.then(
      () => onDismiss(notice.id),
      (error: unknown) => runtime.reportError(error, 'app.notice.restore'),
    );
  };
  return (
    <NoticeCard
      id={`notice/${notice.id}`}
      tone={notice.tone}
      title={notice.title}
      message={notice.message}
      position={{ index: 0, count }}
      actions={canRestore ? [{ id: 'restore', label: 'Put text back', onActivate: restore }] : []}
      onDismiss={() => onDismiss(notice.id)}
      className={portrait ? 'w-[55%]' : 'w-[min(48%,34rem)]'}
    />
  );
}
