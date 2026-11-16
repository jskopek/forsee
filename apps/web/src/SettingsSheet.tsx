import { safeRange, stepSettingValue } from '@forsee/core';
import { GAZE_SETTING_FIELDS, GAZE_SETTINGS_NAMESPACE } from '@forsee/gaze';
import { formatVoiceId, type SpeakMode, type Voice } from '@forsee/plugin-api';
import {
  ChoiceGroup,
  DwellSpeedControls,
  GazeTarget,
  Icon,
  Sheet,
  StepperControl,
  ToggleTarget,
  useSetting,
  type Choice,
} from '@forsee/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AllSettingsSection } from './AllSettingsSection';
import { useActiveLayout, useKeyboardCatalogue, type Problems } from './hooks';
import { PluginsSection } from './PluginsSection';
import { useSettingsPosition } from './settings-position';
import {
  DWELL_FASTER_COMMAND,
  DWELL_SLOWER_COMMAND,
  SPEECH_SETTING_FIELDS,
  type ForseeRuntime,
} from './runtime';
import { controlBarSettingOf, type ControlBarSetting } from './runtime/settings';
import { resetSettings, SettingsTrialBanner, useSettingsTrial } from './SettingControls';

type Tab = 'keyboard' | 'voice' | 'speech' | 'input' | 'all' | 'plugins' | 'problems';

/** The speaking rate's schema (its safe range is what the stepper offers; the engine accepts more). */
const RATE_FIELD = SPEECH_SETTING_FIELDS.find((f) => f.key === 'rate');
/** Voices per page (including "Automatic" on the first). */
const VOICES_PER_PAGE = 6;
/** The dwell times "Reset dwell times" restores. */
const DWELL_TIME_KEYS = new Set([
  'dwell.letterMs',
  'dwell.predictionMs',
  'dwell.functionMs',
  'dwell.destructiveMs',
]);

const TAB_BUTTON = 'h-full min-h-[3.5rem] w-full px-3 text-[clamp(1rem,2.4vh,1.35rem)]';

/**
 * The settings sheet: the keyboard in use, voice, speech rate and
 * mode, click sound, physical keyboard and dwell reset, every registered
 * setting by category ("All settings", generated from the schemas), the
 * core plugins (on/off and their options), plus the list of problems.
 * Risky changes show "Keep these settings?" in place of the title bar. Every change applies at once and is stored through the runtime.
 */
export function SettingsSheet({
  runtime,
  problems,
  portrait,
  onClose,
}: {
  readonly runtime: ForseeRuntime;
  readonly problems: Problems;
  /** Tall screen: the sections go in a row above the controls. */
  readonly portrait: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const [tab, setTab] = useSettingsPosition<Tab>('tab', 'keyboard');
  const trialPending = useSettingsTrial(runtime) !== null;
  const problemCount = problems.issues.length + problems.errors.length;
  const tabs: Choice<Tab>[] = [
    { value: 'keyboard', label: 'Keyboard' },
    { value: 'voice', label: 'Voice' },
    { value: 'speech', label: 'Speaking' },
    { value: 'input', label: 'Input' },
    { value: 'all', label: 'All settings' },
    { value: 'plugins', label: 'Plugins' },
    { value: 'problems', label: problemCount > 0 ? `Problems (${problemCount})` : 'Problems' },
  ];
  return (
    <Sheet
      title="Settings"
      id="settings"
      onClose={onClose}
      banner={trialPending ? <SettingsTrialBanner runtime={runtime} /> : null}
    >
      <div
        className={`grid h-full min-h-0 gap-[clamp(1rem,3vw,2rem)] ${
          portrait
            ? 'grid-rows-[clamp(7.75rem,15vh,10.75rem)_minmax(0,1fr)]'
            : 'grid-cols-[clamp(9rem,20vw,15rem)_minmax(0,1fr)]'
        }`}
      >
        <nav aria-label="Settings sections" className="min-h-0">
          <ChoiceGroup
            label="Sections"
            hideLabel
            idPrefix="settings/tab"
            choices={tabs}
            value={tab}
            onChoose={setTab}
            columns={portrait ? Math.ceil(tabs.length / 2) : 1}
            checkMark={false}
            className={portrait ? 'h-full' : 'h-full max-h-[34rem]'}
          />
        </nav>
        <section aria-label={tabs.find((t) => t.value === tab)?.label} className="min-h-0">
          {tab === 'keyboard' && <KeyboardSection runtime={runtime} />}
          {tab === 'voice' && <VoiceSection runtime={runtime} />}
          {tab === 'speech' && <SpeakingSection runtime={runtime} />}
          {tab === 'input' && <InputSection runtime={runtime} />}
          {tab === 'plugins' && <PluginsSection runtime={runtime} />}
          {tab === 'all' && <AllSettingsSection runtime={runtime} />}
          {tab === 'problems' && <ProblemsSection problems={problems} />}
        </section>
      </div>
    </Sheet>
  );
}

const SECTION = 'flex h-full min-h-0 flex-col gap-[clamp(1rem,3vh,2rem)]';

/** Where the control bar (Speak, Pause, Settings) can go. */
const CONTROL_BAR_POSITIONS: Choice<ControlBarSetting>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'right', label: 'Right' },
  { value: 'left', label: 'Left' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
];

/** Keyboards per page (the active one is marked). */
const KEYBOARDS_PER_PAGE = 6;

function KeyboardSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const active = useActiveLayout(runtime).definition;
  const catalogue = useKeyboardCatalogue(runtime);
  const ui = runtime.settings.namespaces.ui;
  const controlBar = controlBarSettingOf(useSetting(ui, 'controlBar'));
  const [page, setPage] = useSettingsPosition('keyboard/page', 0);
  const pages = Math.max(1, Math.ceil(catalogue.length / KEYBOARDS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const choices = catalogue
    .slice(current * KEYBOARDS_PER_PAGE, (current + 1) * KEYBOARDS_PER_PAGE)
    .map((layout) => ({ value: layout.id, label: layout.name, detail: layout.locale }));
  return (
    <div className={SECTION}>
      {runtime.layout.fallback ? (
        <p className="rounded-xl bg-surface-overlay px-4 py-3 text-[clamp(1rem,2.4vh,1.25rem)]">
          No plugin offers a keyboard right now, so the built-in fallback keyboard is in use. Check
          Standard keyboards in Settings → Plugins.
        </p>
      ) : (
        <ChoiceGroup
          label={pages > 1 ? `Keyboard (page ${current + 1} of ${pages})` : 'Keyboard'}
          idPrefix="settings/layout"
          choices={choices}
          value={active.id}
          onChoose={(id) => {
            try {
              runtime.layout.select(id);
            } catch (error) {
              runtime.reportError(error, 'app.settings.layout');
            }
          }}
          columns={2}
          className="max-h-[24rem] flex-[3]"
        />
      )}
      <ChoiceGroup
        label="Control bar (Speak, Pause, Settings)"
        idPrefix="settings/control-bar"
        choices={CONTROL_BAR_POSITIONS}
        value={controlBar}
        onChoose={(value) => runtime.settings.set(ui, 'controlBar', value)}
        columns={5}
        className="max-h-[8rem] flex-1"
      />
      <p className="text-[clamp(0.9rem,2.2vh,1.15rem)] text-ink-muted">
        Keyboards come from plugins. Choose which standard keyboards are listed in Settings →
        Plugins → Standard keyboards.
      </p>
      {pages > 1 && (
        <div className="grid min-h-[3.5rem] grid-cols-2 gap-[clamp(0.75rem,2vh,1.25rem)]">
          <GazeTarget
            id="settings/keyboard-page/previous"
            dwellClass="function"
            label="Previous keyboards"
            appearance="neutral"
            disabled={current === 0}
            onActivate={() => setPage(Math.max(0, current - 1))}
            className={TAB_BUTTON}
          >
            <Icon name="previous" size={26} />
            <span>Previous</span>
          </GazeTarget>
          <GazeTarget
            id="settings/keyboard-page/next"
            dwellClass="function"
            label="More keyboards"
            appearance="neutral"
            disabled={current >= pages - 1}
            onActivate={() => setPage(Math.min(pages - 1, current + 1))}
            className={TAB_BUTTON}
          >
            <Icon name="next" size={26} />
            <span>More</span>
          </GazeTarget>
        </div>
      )}
    </div>
  );
}

function sortVoices(voices: readonly Voice[], locale: string): Voice[] {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  const rank = (voice: Voice): number =>
    voice.locale.toLowerCase() === locale.toLowerCase()
      ? 0
      : voice.locale.split('-')[0]?.toLowerCase() === language
        ? 1
        : 2;
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function useVoices(runtime: ForseeRuntime): readonly Voice[] | null {
  const [voices, setVoices] = useState<readonly Voice[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      runtime.speech.listVoices().then(
        (list) => {
          if (live) setVoices(list);
        },
        (error: unknown) => {
          runtime.reportError(error, 'app.settings.voices');
          if (live) setVoices([]);
        },
      );
    };
    load();
    const subscription = runtime.speech.engine.events.on('voicesChanged', load);
    return () => {
      live = false;
      subscription.dispose();
    };
  }, [runtime]);
  return voices;
}

function VoiceSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const voices = useVoices(runtime);
  const voiceId = String(useSetting(runtime.settings.namespaces.speech, 'voiceId') ?? '');
  const [page, setPage] = useSettingsPosition('voice/page', 0);
  const choices = useMemo<Choice<string>[]>(() => {
    const list = sortVoices(voices ?? [], runtime.kernel.locale);
    return [
      { value: '', label: 'Automatic', detail: 'the device’s default voice' },
      ...list.map((voice) => ({
        value: formatVoiceId(voice.providerId, voice.id),
        label: voice.name,
        detail: voice.locale,
      })),
    ];
  }, [voices, runtime]);
  const pages = Math.max(1, Math.ceil(choices.length / VOICES_PER_PAGE));
  // A remembered page can be past the end while voices load or after they change.
  const current = Math.min(page, pages - 1);
  const shown = choices.slice(current * VOICES_PER_PAGE, (current + 1) * VOICES_PER_PAGE);

  const testVoice = (): void => {
    runtime.speech.unlock();
    runtime.kernel.commands
      .execute('speech.speak', { text: 'This is how I sound.', log: false, interrupt: true }, 'app')
      .catch((error: unknown) => runtime.reportError(error, 'app.settings.testVoice'));
  };

  return (
    <div className={SECTION}>
      {voices !== null && voices.length === 0 && (
        <p className="rounded-xl bg-surface-overlay px-4 py-3 text-[clamp(1rem,2.4vh,1.25rem)] text-ink-muted">
          No offline voices were found on this device, so Forsee cannot speak here. Text you write
          is kept and shown instead.
        </p>
      )}
      <ChoiceGroup
        label={pages > 1 ? `Offline voices (page ${current + 1} of ${pages})` : 'Offline voices'}
        idPrefix="settings/voice"
        choices={shown}
        value={voiceId}
        onChoose={(value) => runtime.speech.updateSettings({ voiceId: value })}
        columns={2}
        className="flex-[3]"
      />
      <div className="grid min-h-[3.5rem] flex-1 grid-cols-3 gap-[clamp(0.75rem,2vh,1.25rem)]">
        <GazeTarget
          id="settings/voice-page/previous"
          dwellClass="function"
          label="Previous voices"
          appearance="neutral"
          disabled={current === 0}
          onActivate={() => setPage(Math.max(0, current - 1))}
          className={TAB_BUTTON}
        >
          <Icon name="previous" size={26} />
          <span>Previous</span>
        </GazeTarget>
        <GazeTarget
          id="settings/voice-page/next"
          dwellClass="function"
          label="More voices"
          appearance="neutral"
          disabled={current >= pages - 1}
          onActivate={() => setPage(Math.min(pages - 1, current + 1))}
          className={TAB_BUTTON}
        >
          <Icon name="next" size={26} />
          <span>More</span>
        </GazeTarget>
        <GazeTarget
          id="settings/voice/test"
          dwellClass="function"
          label="Test voice"
          appearance="speak"
          onActivate={testVoice}
          className={TAB_BUTTON}
        >
          <Icon name="speak" size={26} />
          <span>Test voice</span>
        </GazeTarget>
      </div>
    </div>
  );
}

const SPEAK_MODES: Choice<SpeakMode>[] = [
  { value: 'on-demand', label: 'When I select Speak' },
  { value: 'each-sentence', label: 'After each sentence' },
  { value: 'each-word', label: 'After each word' },
];

function SpeakingSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const ns = runtime.settings.namespaces.speech;
  const rate = Number(useSetting(ns, 'rate') ?? 1);
  const mode = String(useSetting(ns, 'speakMode') ?? 'on-demand') as SpeakMode;
  const range = RATE_FIELD ? safeRange(RATE_FIELD) : { min: 0.5, max: 2 };
  const step = (direction: -1 | 1): void => {
    if (!RATE_FIELD) return;
    runtime.speech.updateSettings({ rate: stepSettingValue(RATE_FIELD, rate, direction) });
  };
  return (
    <div className={SECTION}>
      <StepperControl
        idPrefix="settings/rate"
        label="Speaking rate"
        valueText={`${rate.toFixed(1)}×`}
        downLabel="Slower"
        upLabel="Faster"
        canDown={rate > range.min + 1e-9}
        canUp={rate < range.max - 1e-9}
        onStep={step}
        className="max-h-[10rem] flex-1"
      />
      <ChoiceGroup
        label="When to speak"
        idPrefix="settings/speak-mode"
        choices={SPEAK_MODES}
        value={mode}
        onChoose={(value) => runtime.speech.updateSettings({ speakMode: value })}
        className="max-h-[10rem] flex-1"
      />
    </div>
  );
}

function InputSection({ runtime }: { readonly runtime: ForseeRuntime }): ReactNode {
  const ui = runtime.settings.namespaces.ui;
  const clickSound = useSetting(ui, 'clickSound') === true;
  const physicalKeyboard = useSetting(ui, 'physicalKeyboard') === true;
  const general = runtime.settings.namespaces.general;
  const autoCapitalise = useSetting(general, 'autoCapitalise') !== false;
  // One step, with "Keep these settings?" (the defaults may be faster than this user can manage).
  const reset = (): void =>
    resetSettings(
      runtime,
      GAZE_SETTING_FIELDS.filter((field) => DWELL_TIME_KEYS.has(field.key)).map((field) => ({
        namespace: GAZE_SETTINGS_NAMESPACE,
        field,
        category: field.category ?? '',
      })),
    );
  return (
    <div className={SECTION}>
      <div className="grid max-h-[10rem] min-h-0 flex-1 grid-cols-3 gap-[clamp(0.75rem,2vh,1.25rem)]">
        <ToggleTarget
          id="settings/click-sound"
          label="Click sound"
          value={clickSound}
          onChange={(value) => runtime.settings.set(ui, 'clickSound', value)}
        />
        <ToggleTarget
          id="settings/physical-keyboard"
          label="Typing on a keyboard"
          value={physicalKeyboard}
          onChange={(value) => runtime.settings.set(ui, 'physicalKeyboard', value)}
        />
        <ToggleTarget
          id="settings/auto-capitalise"
          label="Automatic capitals"
          value={autoCapitalise}
          onChange={(value) => runtime.settings.set(general, 'autoCapitalise', value)}
        />
      </div>
      <div className="flex max-h-[12rem] min-h-0 flex-1 flex-col gap-2">
        <h3 className="text-[clamp(0.95rem,2.2vh,1.2rem)] font-semibold text-ink-muted">
          Dwell speed
        </h3>
        <div className="flex min-h-0 flex-1 gap-[clamp(0.75rem,2vh,1.25rem)]">
          <DwellSpeedControls
            horizontal
            idPrefix="settings/dwell"
            commands={{
              faster: { command: DWELL_FASTER_COMMAND },
              slower: { command: DWELL_SLOWER_COMMAND },
            }}
            className="flex-[3]"
          />
          <GazeTarget
            id="settings/reset-dwell"
            dwellClass="destructive"
            label="Reset dwell times"
            appearance="neutral"
            onActivate={reset}
            className={`${TAB_BUTTON} flex-1`}
          >
            <span>Reset</span>
          </GazeTarget>
        </div>
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_PROBLEMS_SHOWN = 8;

function ProblemsSection({ problems }: { readonly problems: Problems }): ReactNode {
  const rows = [
    ...problems.issues.map((issue) => ({
      key: `issue-${issue.part}-${issue.message}`,
      where: `Start-up: ${issue.part}`,
      what: issue.message,
    })),
    ...[...problems.errors].reverse().map((entry, i) => ({
      key: `error-${i}-${entry.at}`,
      where: entry.context,
      what: messageOf(entry.error),
    })),
  ];
  if (rows.length === 0) {
    return (
      <p className="text-[clamp(1rem,2.6vh,1.4rem)] text-ink-muted">
        No problems so far. Things that go wrong (a part that did not start, a failed save) are
        listed here.
      </p>
    );
  }
  return (
    <ul className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {rows.slice(0, MAX_PROBLEMS_SHOWN).map((row) => (
        <li key={row.key} className="rounded-xl bg-surface-overlay px-4 py-2">
          <p className="text-sm font-semibold text-ink-muted">{row.where}</p>
          <p className="line-clamp-2 break-words text-base">{row.what}</p>
        </li>
      ))}
      {rows.length > MAX_PROBLEMS_SHOWN && (
        <li className="px-4 text-sm text-ink-muted">
          …and {rows.length - MAX_PROBLEMS_SHOWN} more (see the browser console).
        </li>
      )}
    </ul>
  );
}
