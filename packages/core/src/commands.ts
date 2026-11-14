import type {
  CommandArgs,
  CommandContext,
  CommandDescriptor,
  CommandExposure,
  CommandHandler,
  Disposable,
  PermissionScope,
} from '@forsee/plugin-api';
import { toDisposable } from './disposable';
import { ForseeError, isForseeError } from './errors';
import { EventBus, type EventBusOptions } from './event-bus';
import type { Clock } from './platform';

/** Events emitted by the command registry. */
export interface CommandEventMap {
  /** Before a known command's handler runs. */
  willExecute: { readonly id: string; readonly args: unknown; readonly source: string };
  /** After a handler returned (or its promise resolved). */
  didExecute: {
    readonly id: string;
    readonly args: unknown;
    readonly source: string;
    readonly result: unknown;
    /** Monotonic ms from start to settle. */
    readonly durationMs: number;
  };
  /** Execution failed: unknown command or handler error. */
  failed: {
    readonly id: string;
    readonly args: unknown;
    readonly source: string;
    readonly error: ForseeError;
  };
  /** A command was registered or unregistered. */
  changed: { readonly id: string; readonly change: 'added' | 'removed' };
}

/** Options for `CommandRegistry`. */
export interface CommandRegistryOptions extends EventBusOptions {
  /** For `durationMs`. Without it durations are 0. */
  readonly clock?: Clock;
}

/** Owner id of commands registered by the app itself. */
export const APP_COMMAND_OWNER = 'app';

/**
 * A plugin asking to execute a command, as seen by `CommandRegistry.authorize`.
 * The plugin host builds one per plugin from its granted permissions.
 */
export interface CommandCaller {
  /** The calling plugin's id. */
  readonly pluginId: string;
  /** Whether the calling plugin currently holds `scope`. */
  hasPermission(scope: PermissionScope): boolean;
}

interface Entry {
  readonly descriptor: CommandDescriptor;
  readonly handler: CommandHandler<unknown>;
}

/**
 * The command registry.
 *
 * Behaviour:
 * - `register` throws `ForseeError('duplicate')` if the id is taken; the
 *   returned disposable unregisters only that registration.
 * - `execute` always returns a promise. Unknown ids reject with
 *   `ForseeError('unknown-command')`; a handler that throws or rejects makes
 *   it reject with `ForseeError('handler-error')` whose `cause` is the
 *   original error. Both emit `failed`. Errors are never swallowed.
 * - Handlers run synchronously inside `execute` (before it returns), so a
 *   synchronous handler's effects are visible immediately after the call.
 */
export class CommandRegistry implements Disposable {
  readonly events: EventBus<CommandEventMap>;
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Clock | undefined;

  constructor(options: CommandRegistryOptions = {}) {
    this.events = new EventBus(options);
    this.clock = options.clock;
  }

  /** Registers a handler. Typed arguments for ids in `CommandArgsMap`. */
  register<K extends string>(
    id: K,
    handler: CommandHandler<CommandArgs<K>>,
    descriptor: {
      readonly title: string;
      readonly description?: string;
      readonly owner?: string;
    } & CommandExposure,
  ): Disposable {
    if (id === '') throw new ForseeError('invalid-argument', 'Command id must not be empty');
    if (this.entries.has(id)) {
      throw new ForseeError('duplicate', `Command already registered: ${id}`);
    }
    const entry: Entry = {
      descriptor: {
        id,
        title: descriptor.title,
        owner: descriptor.owner ?? APP_COMMAND_OWNER,
        // App commands are public unless stated otherwise; plugin commands are private.
        public: descriptor.public ?? (descriptor.owner ?? APP_COMMAND_OWNER) === APP_COMMAND_OWNER,
        requires: [...(descriptor.requires ?? [])],
        ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
      },
      handler: handler as CommandHandler<unknown>,
    };
    this.entries.set(id, entry);
    this.events.emit('changed', { id, change: 'added' });
    return toDisposable(() => {
      if (this.entries.get(id) === entry) {
        this.entries.delete(id);
        this.events.emit('changed', { id, change: 'removed' });
      }
    });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Descriptors of every registered command, sorted by id. */
  list(): CommandDescriptor[] {
    return [...this.entries.values()]
      .map((e) => e.descriptor)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * Executes a command.
   * @param source who invoked it (`"app"`, `"keyboard"`, a plugin id); default `"app"`.
   */
  /**
   * Checks whether a plugin may execute a command, without running it. The
   * plugin host must call this before `execute` for every call that
   * originates from a plugin; `execute` itself trusts its caller (the app,
   * layout keys, tests).
   *
   * Rules: a plugin may always execute its own commands. Any other command
   * must be public, and the plugin must hold every scope in its `requires`.
   *
   * @throws ForseeError `unknown-command` if no such command is registered,
   * `permission-denied` if the rules above are not met.
   */
  authorize(id: string, caller: CommandCaller): void {
    const entry = this.entries.get(id);
    if (!entry) throw new ForseeError('unknown-command', `Unknown command: ${id}`);
    const { owner, requires } = entry.descriptor;
    if (owner === caller.pluginId) return;
    if (!entry.descriptor.public) {
      throw new ForseeError(
        'permission-denied',
        `Command ${id} is private to ${owner} and cannot be executed by ${caller.pluginId}`,
      );
    }
    const missing = requires.filter((scope) => !caller.hasPermission(scope));
    if (missing.length > 0) {
      throw new ForseeError(
        'permission-denied',
        `Command ${id} requires ${missing.join(', ')}, which ${caller.pluginId} does not hold`,
        { details: { missing } },
      );
    }
  }

  execute<K extends string>(id: K, args?: CommandArgs<K>, source = 'app'): Promise<unknown> {
    const entry = this.entries.get(id);
    if (!entry) {
      const error = new ForseeError('unknown-command', `Unknown command: ${id}`);
      this.events.emit('failed', { id, args, source, error });
      return Promise.reject(error);
    }
    const start = this.clock?.now() ?? 0;
    this.events.emit('willExecute', { id, args, source });
    const context: CommandContext = { commandId: id, source };
    const fail = (cause: unknown): Promise<never> => {
      // A handler's own ForseeError keeps its code (`invalid-argument`,
      // `permission-denied`, ...); anything else becomes `handler-error`.
      const message = cause instanceof Error ? cause.message : String(cause);
      const error = isForseeError(cause)
        ? cause
        : new ForseeError('handler-error', `Command ${id} failed: ${message}`, { cause });
      this.events.emit('failed', { id, args, source, error });
      return Promise.reject(error);
    };
    const succeed = (result: unknown): unknown => {
      const durationMs = (this.clock?.now() ?? 0) - start;
      this.events.emit('didExecute', { id, args, source, result, durationMs });
      return result;
    };
    let raw: unknown;
    try {
      raw = entry.handler(args, context);
    } catch (cause) {
      return fail(cause);
    }
    return Promise.resolve(raw).then(succeed, fail);
  }

  dispose(): void {
    this.entries.clear();
    this.events.dispose();
  }
}
