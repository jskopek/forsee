import {
  AppFrame,
  CompositionBar,
  DwellSpeedControls,
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
  StopSpeakingButton,
  useClickSound,
  useComposition,
  useMediaQuery,
  useSetting,
} from '@forsee/ui';
import { useCallback, useState, type ReactNode } from 'react';
import {
  layoutHasSpeakKey,
  useActiveLayout,
  useProblems,
  useQuickfireTiles,
  useSpeaking,
  useSpeechLocked,
} from './hooks';
import { usePhysicalKeyboard, useUnlockSpeechOnGesture } from './input';
import { useNotices, type Notice } from './notices';
import { DWELL_FASTER_COMMAND, DWELL_SLOWER_COMMAND, type ForseeRuntime } from './runtime';
import { SettingsSheet } from './SettingsSheet';

/** The app once the runtime is up: the provider of the host UI around the screen. */
export function MainScreen({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  return (
    <HostUiProvider services={runtime.hostUi} reportError={runtime.reportError}>
      <Screen runtime={runtime} />
    </HostUiProvider>
  );
}

const SIDE_ITEM = 'flex min-h-0';

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
  const ownSpeakKey = layoutHasSpeakKey(layout.definition);

  const banner = locked ? (
    <UnlockPrompt onUnlock={() => runtime.speech.unlock()} />
  ) : tiles.length > 0 ? (
    <PhraseBar label="Quick replies" idPrefix="quickfire" tiles={tiles} />
  ) : null;

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

  const actions = (
    <>
      <div className={`${SIDE_ITEM} ${portrait ? 'flex-1' : 'flex-[1.1]'}`}>
        {ownSpeakKey ? (
          <StopSpeakingButton speaking={speaking} />
        ) : (
          <SpeakButton
            command={{ command: 'composition.speak' }}
            speaking={speaking}
            stopCommand={{ command: 'speech.stop' }}
          />
        )}
      </div>
      <div className={`${SIDE_ITEM} ${portrait ? 'flex-[3]' : 'flex-[2.6]'}`}>
        <DwellSpeedControls
          horizontal={portrait}
          commands={{
            faster: { command: DWELL_FASTER_COMMAND },
            slower: { command: DWELL_SLOWER_COMMAND },
          }}
        />
      </div>
      <div className={`${SIDE_ITEM} flex-1`}>
        <PauseButton />
      </div>
      <div className={`${SIDE_ITEM} flex-1`}>
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
      </div>
    </>
  );

  return (
    <AppFrame
      banner={banner}
      composition={composition}
      predictions={<PredictionStrip />}
      keyboard={
        <KeyboardView
          key={layout.definition.id}
          runtime={layout.runtime}
          targets={runtime.gaze.targets}
          // Only sides that touch the screen's edge get the larger edge keys.
          edges={
            portrait
              ? { top: false, right: true, bottom: false, left: true }
              : { top: false, right: false, bottom: true, left: true }
          }
        />
      }
      actions={actions}
      actionsPosition={portrait ? 'bottom' : 'side'}
      inert={settingsOpen}
      overlay={
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
      }
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
