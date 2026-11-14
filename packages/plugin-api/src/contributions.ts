import type { LocaleTag, Point, Rect } from './common';
import type { CommandExposure, CommandHandler } from './commands';
import type { ContextEntryInput } from './context';
import type { DwellClass, GazeSource, KeyDistribution } from './gaze';
import type { LayoutDefinition } from './layout';
import type { PluginPlatform } from './manifest';
import type { PredictionProvider } from './prediction';
import type { RegionId } from './regions';
import type { SettingField } from './settings';
import type { VoiceProvider } from './speech';

/**
 * Contribution types for every extension point in plan section 6.
 *
 * Every contribution has an `id`. Within one extension point, ids are
 * globally unique; plugin contributions are prefixed with the plugin id
 * (`<pluginId>/<name>`), which the plugin host enforces. Declarative
 * contributions are plain JSON; logic contributions hold implementation
 * objects (for sandboxed plugins, RPC proxies with the same shape).
 */

// ---------------------------------------------------------------- themes

/**
 * Theme tokens: semantic colour roles, carried over from the prototype's
 * Tailwind palette. Values are CSS colour strings.
 */
export type ThemeToken =
  | 'background'
  | 'surface'
  | 'text'
  | 'textMuted'
  | 'border'
  | 'keyBack'
  | 'keyFront'
  | 'keyBorder'
  | 'keyText'
  | 'functionBack'
  | 'functionFront'
  | 'functionBorder'
  | 'functionText'
  | 'predictionBack'
  | 'predictionFront'
  | 'predictionBorder'
  | 'predictionText'
  | 'dangerBack'
  | 'dangerFront'
  | 'dangerBorder'
  | 'dangerText'
  | 'primaryBack'
  | 'primaryFront'
  | 'primaryBorder'
  | 'primaryText'
  | 'dwellProgress'
  | 'focusRing'
  | 'warningBack'
  | 'warningText';

/** A theme. Missing tokens fall back to the built-in theme with the same `colorScheme`. */
export interface ThemeDefinition {
  readonly id: string;
  readonly name: string;
  readonly colorScheme: 'light' | 'dark';
  readonly tokens: Partial<Readonly<Record<ThemeToken, string>>>;
  /** Multiplier for all font sizes (large print). Default 1. */
  readonly fontScale?: number;
}

// ---------------------------------------------------------------- phrases

/** One phrase tile. */
export interface Phrase {
  /** Unique within the phrase set. */
  readonly id: string;
  /** What is spoken and logged. */
  readonly text: string;
  /** Shorter tile label; defaults to `text`. */
  readonly label?: string;
  /**
   * Recorded message (message banking): path of an audio file relative to
   * the plugin folder (contributed sets) or the profile (user sets). When set
   * it is played instead of synthesising `text`.
   */
  readonly recording?: string;
}

/** A category of phrases ("Greetings", "Medical needs"). */
export interface PhraseCategory {
  readonly id: string;
  readonly name: string;
  readonly phrases: readonly Phrase[];
}

/** A phrase set (one JSON file). */
export interface PhraseSet {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly locale: LocaleTag;
  readonly categories: readonly PhraseCategory[];
}

// ---------------------------------------------------------------- vocabularies

/** A word or multi-word term to add to prediction. */
export interface VocabularyEntry {
  readonly text: string;
  /** Relative weight, > 0. Default 1. */
  readonly weight?: number;
}

/** A vocabulary (names, places, professional terms). */
export interface Vocabulary {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly locale: LocaleTag;
  readonly entries: readonly VocabularyEntry[];
}

// ---------------------------------------------------------------- settings

/** A group of settings shown as one section. `id` is the settings namespace. */
export interface SettingsContribution {
  /** Settings namespace: `"app"` or a plugin id. */
  readonly id: string;
  readonly title: string;
  readonly fields: readonly SettingField[];
}

// ---------------------------------------------------------------- commands

/** A command a plugin adds (bindable to keys). */
export interface CommandContribution extends CommandExposure {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly handler: CommandHandler;
}

// ---------------------------------------------------------------- context providers

/**
 * A context provider. It writes facts into the context store, either by
 * pushing (`ForseeApi.context.set`) or when the host asks (`refresh`), for
 * example just before a prediction request.
 */
export interface ContextProvider {
  readonly id: string;
  readonly name: string;
  /** Keys this provider writes (documentation for consent screens and other plugins). */
  readonly provides: readonly string[];
  /** Returns current entries; the host writes them with this plugin as source. */
  refresh?(): readonly ContextEntryInput[] | Promise<readonly ContextEntryInput[]>;
}

// ---------------------------------------------------------------- text transforms

/** When a text transform runs. */
export type TextTransformTrigger = 'word-boundary' | 'commit';

/** Input to a text transform. */
export interface TextTransformInput {
  readonly trigger: TextTransformTrigger;
  /** Full composition text at the moment of the trigger. */
  readonly text: string;
  readonly locale: LocaleTag;
}

/**
 * A text transform (abbreviation expansion, autocorrect). Runs on a word
 * boundary (after a space or punctuation is inserted) or on commit (just
 * before speaking). Returns the replacement full text, or `null` for no
 * change. Transforms run in registration order, each seeing the previous
 * output; a replacement is one undo step.
 */
export interface TextTransform {
  readonly id: string;
  readonly name: string;
  readonly triggers: readonly TextTransformTrigger[];
  transform(input: TextTransformInput): string | null | Promise<string | null>;
}

// ---------------------------------------------------------------- output sinks

/** What an output sink receives. */
export interface OutputPayload {
  readonly text: string;
  /** History record id when the text was logged. */
  readonly utteranceId?: string;
}

/** Somewhere text can be sent instead of, or as well as, speaking it. */
export interface OutputSink {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  send(payload: OutputPayload): Promise<void>;
}

// ---------------------------------------------------------------- panels

/** A panel shown in a region. */
export interface PanelContribution {
  /** Global panel id: `<ownerId>/<panelId>`. */
  readonly id: string;
  readonly title: string;
  /** Default region; the user's profile may move it. */
  readonly region: RegionId;
  /**
   * How it renders: `frame` (sandboxed HTML entry relative to the plugin
   * folder, custom-UI tier) or `component` (a first-party React component
   * registered with `@forsee/ui` under the same id).
   */
  readonly render:
    { readonly kind: 'frame'; readonly entry: string } | { readonly kind: 'component' };
}

/**
 * A selectable rectangle a custom-UI panel registers. Coordinates are CSS
 * pixels relative to the panel frame's top-left; the plugin host translates
 * them into app viewport coordinates and registers real targets.
 */
export interface PanelTarget {
  /** Unique within the panel. */
  readonly id: string;
  readonly rect: Rect;
  readonly dwellClass: DwellClass;
  readonly label?: string;
  readonly afterActivate?: 'look-away' | 'repeat';
  readonly disabled?: boolean;
}

/**
 * `activate` delivered to a panel for one of its targets.
 *
 * Permissions: `point` and `distribution` are delivered without `gaze.read`,
 * because they describe only the plugin's own UI at the moment one of its
 * own targets fired, not the gaze stream. The host must keep them that way:
 * `point` is clamped to the panel frame, and `distribution` contains only
 * this panel's own targets, so an activation never reveals where the user
 * looked outside the panel or anything about other owners' targets.
 */
export interface PanelActivation {
  readonly panelId: string;
  readonly targetId: string;
  readonly repeatIndex: number;
  /**
   * Where the user was looking when the target fired, CSS pixels relative to
   * the panel frame's top-left (like `PanelTarget.rect`), clamped to the
   * frame. Absent when the host has no point (for example a switch press
   * with no gaze).
   */
  readonly point?: Point;
  /**
   * The selection's uncertainty over this panel's own targets: entries for
   * any other target (keyboard keys, other panels, other plugins) are
   * removed, `targetId`s are the panel-local `PanelTarget.id`s, the fired
   * target is always present, and probabilities are renormalised to sum to
   * 1. A plugin that predicts from noisy selections passes it on (for
   * example as `composition.insert`'s `distribution`). Absent when the host
   * delivers none.
   */
  readonly distribution?: KeyDistribution;
}

// ---------------------------------------------------------------- gaze sources

/**
 * A gaze source. In-process sources (first-party, desktop-only native
 * modules) give the implementation; driver plugins describe an external
 * process that the host launches (`native.sidecar`) and connects to with the
 * WebSocket driver protocol.
 */
export type GazeSourceContribution =
  | {
      readonly id: string;
      readonly name: string;
      readonly kind: 'in-process';
      readonly source: GazeSource;
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly kind: 'driver';
      /** Executable path relative to the plugin folder, per platform. */
      readonly executable: Partial<Readonly<Record<'macos' | 'windows' | 'linux', string>>>;
      readonly args?: readonly string[];
      /** Platforms the driver runs on; always desktop. */
      readonly platforms?: readonly Extract<PluginPlatform, 'desktop'>[];
    };

// ---------------------------------------------------------------- the map

/**
 * Extension point id → contribution type. The core extension registry and
 * the plugin API's `register` functions are typed from this map.
 */
export interface ContributionMap {
  layouts: LayoutDefinition;
  themes: ThemeDefinition;
  phraseSets: PhraseSet;
  vocabularies: Vocabulary;
  settings: SettingsContribution;
  commands: CommandContribution;
  predictionProviders: PredictionProvider;
  contextProviders: ContextProvider;
  textTransforms: TextTransform;
  voiceProviders: VoiceProvider;
  outputSinks: OutputSink;
  panels: PanelContribution;
  gazeSources: GazeSourceContribution;
}

/** Name of an extension point. */
export type ExtensionPointId = keyof ContributionMap;

/** Every extension point, with its trust tier (plan section 6 table). */
export const EXTENSION_POINTS: Readonly<
  Record<ExtensionPointId, 'declarative' | 'logic' | 'custom-ui' | 'driver'>
> = {
  layouts: 'declarative',
  themes: 'declarative',
  phraseSets: 'declarative',
  vocabularies: 'declarative',
  settings: 'declarative',
  commands: 'logic',
  predictionProviders: 'logic',
  contextProviders: 'logic',
  textTransforms: 'logic',
  voiceProviders: 'logic',
  outputSinks: 'logic',
  panels: 'custom-ui',
  gazeSources: 'driver',
};

/** A contribution as stored by the extension registry. */
export interface RegisteredContribution<P extends ExtensionPointId = ExtensionPointId> {
  readonly point: P;
  /** The contribution's `id`. */
  readonly id: string;
  /** Plugin id that registered it, or `"app"`. */
  readonly owner: string;
  readonly contribution: ContributionMap[P];
}

/** Payload of an extension registry change. */
export interface ExtensionChange {
  readonly point: ExtensionPointId;
  readonly id: string;
  readonly owner: string;
  readonly change: 'added' | 'removed';
}

/** JSON-only contributions (declarative tier) that can be loaded from files. */
export type DeclarativeContribution = LayoutDefinition | ThemeDefinition | PhraseSet | Vocabulary;
