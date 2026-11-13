import type { JsonObject } from './common';
import type { KeyDistribution } from './gaze';
import type { PermissionScope } from './manifest';

/**
 * Commands (plan section 4): every action has an id. Keys, plugins and tests
 * all invoke commands; nothing calls UI handlers directly.
 *
 * Ids are dot-separated: `<area>.<verb>` for built-ins, `<pluginId>.<verb>`
 * or `<pluginId>/<verb>` for plugin commands (the plugin host enforces the
 * plugin's prefix). Arguments are a JSON object (or absent) so that a layout
 * file can bind any command to a key.
 */

/**
 * Arguments of the built-in commands. Other packages may add entries by
 * declaration merging (`declare module '@forsee/plugin-api' { interface
 * CommandArgsMap { 'layout.showPage': { page: string } } }`). `undefined`
 * means the command takes no arguments.
 */
export interface CommandArgsMap {
  /** Append text to the composition. `distribution` is the selection's uncertainty, for the predictor. */
  'composition.insert': { readonly text: string; readonly distribution?: KeyDistribution };
  /** Delete the last grapheme cluster. */
  'composition.deleteGrapheme': undefined;
  /** Delete the last word (and the whitespace after it). */
  'composition.deleteWord': undefined;
  /** Clear the composition (undoable). */
  'composition.clear': undefined;
  /** Undo the last composition change. */
  'composition.undo': undefined;
  /** Replace the current partial word with `text` and add a trailing space. */
  'composition.acceptPrediction': { readonly text: string };
  /**
   * Speak. Without `text`: commit the composition (take its text and clear it)
   * and speak that. With `text`: speak it, leaving the composition alone
   * (phrases, quick-fire, re-speak). Both append to history unless `log` is false.
   */
  'speech.speak': { readonly text?: string; readonly log?: boolean } | undefined;
  /** Stop speaking immediately. */
  'speech.stop': undefined;
  /** Stop all gaze selection until a deliberate wake dwell. */
  'gaze.pause': undefined;
  /** Resume gaze selection. */
  'gaze.resume': undefined;
}

/**
 * Ids of the commands registered by the kernel itself. (Not `keyof
 * CommandArgsMap`, because other packages add their own commands to that map.)
 */
export type BuiltinCommandId =
  | 'composition.insert'
  | 'composition.deleteGrapheme'
  | 'composition.deleteWord'
  | 'composition.clear'
  | 'composition.undo'
  | 'composition.acceptPrediction'
  | 'speech.speak'
  | 'speech.stop'
  | 'gaze.pause'
  | 'gaze.resume';

/** Every built-in command id, in a stable order. */
export const BUILTIN_COMMAND_IDS: readonly BuiltinCommandId[] = [
  'composition.insert',
  'composition.deleteGrapheme',
  'composition.deleteWord',
  'composition.clear',
  'composition.undo',
  'composition.acceptPrediction',
  'speech.speak',
  'speech.stop',
  'gaze.pause',
  'gaze.resume',
];

/** Arguments for a command id: typed for known ids, a JSON object otherwise. */
export type CommandArgs<K extends string> = K extends keyof CommandArgsMap
  ? CommandArgsMap[K]
  : JsonObject | undefined;

/** Metadata shown in key-binding pickers and the command list. */
export interface CommandDescriptor {
  readonly id: string;
  /** Human-readable title, for example "Delete word". */
  readonly title: string;
  readonly description?: string;
  /** Plugin id that registered it, or `"app"` for built-ins. */
  readonly owner: string;
  /**
   * Whether plugins other than the owner may execute it. Built-ins are
   * public; a plugin's commands are private unless it registers them with
   * `public: true`. The owner, the app and layout keys can always execute it.
   */
  readonly public: boolean;
  /**
   * Permission scopes a plugin other than the owner must hold to execute a
   * public command (for example `composition.write` for `composition.insert`).
   * Empty when none. Ignored for private commands, which other plugins cannot
   * execute at all.
   */
  readonly requires: readonly PermissionScope[];
}

/**
 * How a command is exposed to other plugins (see `CommandDescriptor.public`
 * and `CommandDescriptor.requires`). Omitted fields mean private, no scopes.
 */
export interface CommandExposure {
  readonly public?: boolean;
  readonly requires?: readonly PermissionScope[];
}

/** Context the registry passes to every handler. */
export interface CommandContext {
  /** Id of the command being executed. */
  readonly commandId: string;
  /** Who invoked it: a plugin id, `"app"`, or `"keyboard"` for layout keys. */
  readonly source: string;
}

/**
 * A command implementation. May be synchronous or return a promise. The
 * result should be structured-clone-safe if plugins may call the command.
 */
export type CommandHandler<A = JsonObject | undefined> = (
  args: A,
  context: CommandContext,
) => unknown;
