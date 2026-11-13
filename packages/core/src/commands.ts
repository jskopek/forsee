import type {
  CommandArgs,
  CommandContext,
  CommandDescriptor,
  CommandHandler,
  Disposable,
} from '@forsee/plugin-api';
import { toDisposable } from './disposable';
import { ForseeError } from './errors';
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
    descriptor: { readonly title: string; readonly description?: string; readonly owner?: string },
  ): Disposable {
    if (id === '') throw new ForseeError('invalid-argument', 'Command id must not be empty');
    if (this.entries.has(id)) {
      throw new ForseeError('duplicate', `Command already registered: ${id}`);
    }
    const entry: Entry = {
      descriptor: {
        id,
        title: descriptor.title,
        owner: descriptor.owner ?? 'app',
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
      const message = cause instanceof Error ? cause.message : String(cause);
      const error = new ForseeError('handler-error', `Command ${id} failed: ${message}`, { cause });
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
