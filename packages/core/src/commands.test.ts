import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from './commands';
import { ForseeError, isForseeError } from './errors';
import { FakeClock } from './testing';

describe('CommandRegistry', () => {
  it('registers, lists and executes with typed args and context', async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn((args: { text: string } | undefined) => args?.text.length);
    registry.register('composition.insert', handler, { title: 'Type' });
    registry.register('plugin.x', () => 'x', { title: 'X', owner: 'plugin', description: 'd' });
    expect(registry.list()).toEqual([
      { id: 'composition.insert', title: 'Type', owner: 'app', public: true, requires: [] },
      {
        id: 'plugin.x',
        title: 'X',
        owner: 'plugin',
        description: 'd',
        public: false,
        requires: [],
      },
    ]);
    await expect(registry.execute('composition.insert', { text: 'abc' }, 'keyboard')).resolves.toBe(
      3,
    );
    expect(handler).toHaveBeenCalledWith(
      { text: 'abc' },
      { commandId: 'composition.insert', source: 'keyboard' },
    );
  });

  it('runs synchronous handlers before execute returns', () => {
    const registry = new CommandRegistry();
    let ran = false;
    registry.register(
      'a.b',
      () => {
        ran = true;
      },
      { title: 'A' },
    );
    void registry.execute('a.b');
    expect(ran).toBe(true);
  });

  it('rejects duplicates and empty ids', () => {
    const registry = new CommandRegistry();
    registry.register('a.b', () => undefined, { title: 'A' });
    expect(() => registry.register('a.b', () => undefined, { title: 'A' })).toThrow(ForseeError);
    expect(() => registry.register('', () => undefined, { title: 'A' })).toThrow(/empty/);
  });

  it('rejects unknown commands with unknown-command and emits failed', async () => {
    const registry = new CommandRegistry();
    const failed = vi.fn();
    registry.events.on('failed', failed);
    const error: unknown = await registry.execute('nope').catch((e: unknown) => e);
    expect(isForseeError(error, 'unknown-command')).toBe(true);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ id: 'nope' }));
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('bad');
      },
    ],
    ['rejects', () => Promise.reject(new Error('bad'))],
  ])('wraps a handler that %s as handler-error with the cause', async (_label, handler) => {
    const registry = new CommandRegistry();
    registry.register('a.b', handler, { title: 'A' });
    const failed = vi.fn();
    const did = vi.fn();
    registry.events.on('failed', failed);
    registry.events.on('didExecute', did);
    const error: unknown = await registry.execute('a.b').catch((e: unknown) => e);
    expect(isForseeError(error, 'handler-error')).toBe(true);
    expect((error as ForseeError).cause).toEqual(new Error('bad'));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(did).not.toHaveBeenCalled();
  });

  it.each([
    [
      'throws',
      'invalid-argument' as const,
      () => {
        throw new ForseeError('invalid-argument', 'needs text');
      },
    ],
    [
      'rejects',
      'permission-denied' as const,
      () => Promise.reject(new ForseeError('permission-denied', 'no')),
    ],
  ])(
    'passes on a ForseeError that a handler %s, keeping its code',
    async (_label, code, handler) => {
      const registry = new CommandRegistry();
      registry.register('a.b', handler, { title: 'A' });
      const failed = vi.fn();
      registry.events.on('failed', failed);
      const error: unknown = await registry.execute('a.b').catch((e: unknown) => e);
      expect(isForseeError(error, code)).toBe(true);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ error }));
    },
  );

  describe('authorize', () => {
    const caller = (pluginId: string, held: readonly string[] = []) => ({
      pluginId,
      hasPermission: (scope: string) => held.includes(scope),
    });
    const attempt = (registry: CommandRegistry, id: string, by: ReturnType<typeof caller>) => {
      try {
        registry.authorize(id, by);
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it('describes app commands as public and plugin commands as private by default', () => {
      const registry = new CommandRegistry();
      registry.register('app.do', () => 1, { title: 'App' });
      registry.register('community.a.do', () => 1, { title: 'A', owner: 'community.a' });
      registry.register('community.b.do', () => 1, {
        title: 'B',
        owner: 'community.b',
        public: true,
        requires: ['speech.output'],
      });
      expect(registry.list()).toEqual([
        { id: 'app.do', title: 'App', owner: 'app', public: true, requires: [] },
        { id: 'community.a.do', title: 'A', owner: 'community.a', public: false, requires: [] },
        {
          id: 'community.b.do',
          title: 'B',
          owner: 'community.b',
          public: true,
          requires: ['speech.output'],
        },
      ]);
    });

    it('lets a plugin execute its own command even when it is private', () => {
      const registry = new CommandRegistry();
      registry.register('community.a.do', () => 1, {
        title: 'A',
        owner: 'community.a',
        requires: ['speech.output'],
      });
      expect(attempt(registry, 'community.a.do', caller('community.a'))).toBeUndefined();
    });

    it("denies another plugin's private command, whatever the caller holds", () => {
      const registry = new CommandRegistry();
      registry.register('community.a.do', () => 1, { title: 'A', owner: 'community.a' });
      const denied = attempt(registry, 'community.a.do', caller('community.b', ['speech.output']));
      expect(isForseeError(denied, 'permission-denied')).toBe(true);
    });

    it('requires every listed scope for a public command and names the missing ones', () => {
      const registry = new CommandRegistry();
      registry.register('community.a.say', () => 1, {
        title: 'Say',
        owner: 'community.a',
        public: true,
        requires: ['speech.output', 'composition.read'],
      });
      const all = caller('community.b', ['speech.output', 'composition.read']);
      expect(attempt(registry, 'community.a.say', all)).toBeUndefined();
      const denied = attempt(registry, 'community.a.say', caller('community.b', ['speech.output']));
      expect(isForseeError(denied, 'permission-denied')).toBe(true);
      expect((denied as ForseeError).details).toEqual({ missing: ['composition.read'] });
    });

    it('reports an unknown command', () => {
      const registry = new CommandRegistry();
      expect(
        isForseeError(attempt(registry, 'nope', caller('community.a')), 'unknown-command'),
      ).toBe(true);
    });

    it('does not restrict execute itself, which trusts its caller', async () => {
      const registry = new CommandRegistry();
      registry.register('community.a.do', () => 7, { title: 'A', owner: 'community.a' });
      await expect(registry.execute('community.a.do', undefined, 'keyboard')).resolves.toBe(7);
    });
  });

  it('emits willExecute and didExecute with duration', async () => {
    const clock = new FakeClock();
    const registry = new CommandRegistry({ clock });
    registry.register(
      'a.slow',
      () => {
        clock.advance(25);
        return Promise.resolve('done');
      },
      { title: 'Slow' },
    );
    const events: string[] = [];
    registry.events.on('willExecute', (e) => events.push(`will:${e.id}`));
    registry.events.on('didExecute', (e) =>
      events.push(`did:${e.id}:${e.durationMs}:${String(e.result)}`),
    );
    await registry.execute('a.slow');
    expect(events).toEqual(['will:a.slow', 'did:a.slow:25:done']);
  });

  it('unregisters only its own registration', async () => {
    const registry = new CommandRegistry();
    const first = registry.register('a.b', () => 1, { title: 'A' });
    first.dispose();
    expect(registry.has('a.b')).toBe(false);
    registry.register('a.b', () => 2, { title: 'A' });
    first.dispose();
    await expect(registry.execute('a.b')).resolves.toBe(2);
  });

  it('emits changed on add and remove', () => {
    const registry = new CommandRegistry();
    const changes: string[] = [];
    registry.events.on('changed', (e) => changes.push(`${e.change}:${e.id}`));
    registry.register('a.b', () => 1, { title: 'A' }).dispose();
    expect(changes).toEqual(['added:a.b', 'removed:a.b']);
  });

  it('a throwing event listener does not break execution', async () => {
    const report = vi.fn();
    const registry = new CommandRegistry({ onListenerError: report });
    registry.events.on('willExecute', () => {
      throw new Error('listener');
    });
    registry.register('a.b', () => 1, { title: 'A' });
    await expect(registry.execute('a.b')).resolves.toBe(1);
    expect(report).toHaveBeenCalled();
  });
});
