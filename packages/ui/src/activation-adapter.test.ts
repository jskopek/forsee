import {
  createLayoutRuntime,
  getBuiltinLayout,
  keyIdOfTarget,
  targetId,
  type LayoutRuntime,
} from '@forsee/layouts';
import type { ActivateEvent, JsonObject, KeyDistribution } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { createActivationAdapter } from './activation-adapter';

interface Call {
  readonly command: string;
  readonly args: JsonObject | undefined;
  readonly source: string;
}

function setup(layoutId = 'forsee/en-qwerty', failWith?: Error) {
  const layout = getBuiltinLayout(layoutId);
  if (!layout) throw new Error(layoutId);
  const runtime: LayoutRuntime = createLayoutRuntime(layout);
  const calls: Call[] = [];
  const errors: unknown[] = [];
  const adapter = createActivationAdapter({
    runtime,
    keyIdOf: (id) => keyIdOfTarget(runtime.view.layoutId, runtime.view.pageId, id),
    execute: (command, args, source) => {
      calls.push({ command, args, source });
      return failWith ? Promise.reject(failWith) : Promise.resolve(true);
    },
    reportError: (error) => errors.push(error),
  });
  const idOf = (keyId: string): string =>
    targetId(runtime.view.layoutId, runtime.view.pageId, keyId);
  return { runtime, calls, errors, adapter, idOf };
}

const DISTRIBUTION: KeyDistribution = {
  entries: [
    { targetId: 'x/h', text: 'h', probability: 0.7 },
    { targetId: 'x/j', text: 'j', probability: 0.3 },
  ],
};

function activation(id: string, repeatIndex = 0): ActivateEvent {
  return {
    type: 'activate',
    targetId: id,
    method: 'dwell',
    repeatIndex,
    point: { x: 1, y: 2 },
    distribution: DISTRIBUTION,
    t: 100,
  };
}

const OWNER = { executedBy: 'owner' } as const;

describe('createActivationAdapter', () => {
  it('inserts a letter with the distribution attached, once, from source gaze', async () => {
    const { adapter, calls, idOf } = setup();
    const result = await adapter.handle(activation(idOf('k-h')), OWNER);
    expect(calls).toEqual([
      {
        command: 'composition.insert',
        args: {
          text: 'h',
          distribution: {
            entries: [
              { targetId: 'x/h', text: 'h', probability: 0.7 },
              { targetId: 'x/j', text: 'j', probability: 0.3 },
            ],
          },
        },
        source: 'gaze',
      },
    ]);
    expect(result.kind).toBe('executed');
  });

  it('escalates backspace by repeatIndex: letter, word, clear', async () => {
    const { adapter, calls, idOf } = setup();
    for (const repeatIndex of [0, 1, 2, 3]) {
      await adapter.handle(activation(idOf('k-backspace'), repeatIndex), OWNER);
    }
    expect(calls.map((c) => c.command)).toEqual([
      'composition.deleteGrapheme',
      'composition.deleteWord',
      'composition.clear',
      'composition.clear',
    ]);
    // Only composition.insert carries a distribution.
    expect(calls.every((c) => c.args === undefined)).toBe(true);
  });

  it('opens a group and returns after a sub-key (coarse layout)', async () => {
    const { adapter, calls, runtime, idOf } = setup('forsee/en-coarse-groups');
    const open = await adapter.handle(activation(idOf('grp-abcde')), OWNER);
    expect(open.kind).toBe('view-changed');
    expect(runtime.view.openGroup?.id).toBe('grp-abcde');
    expect(calls).toEqual([]);

    const letter = await adapter.handle(activation(idOf('k-c')), OWNER);
    expect(letter.kind).toBe('executed');
    expect(calls[0]?.args?.text).toBe('c');
    expect(runtime.view.openGroup).toBeNull();

    await adapter.handle(activation(idOf('grp-wxyz')), OWNER);
    const back = await adapter.handle(activation(idOf('$back')), OWNER);
    expect(back.kind).toBe('view-changed');
    expect(runtime.view.openGroup).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('switches pages, and a one-shot page returns after a letter', async () => {
    const { adapter, calls, runtime, idOf } = setup();
    expect((await adapter.handle(activation(idOf('k-numbers')), OWNER)).kind).toBe('view-changed');
    expect(runtime.view.pageId).toBe('numbers');
    await adapter.handle(activation(idOf('n-shift')), OWNER);
    expect(runtime.view.pageId).toBe('upper');
    await adapter.handle(activation(idOf('u-h')), OWNER);
    expect(calls[0]?.args?.text).toBe('H');
    expect(runtime.view.pageId).toBe('letters');
  });

  it('ignores stale, foreign and pipeline-executed activations', async () => {
    const { adapter, calls, runtime, idOf } = setup();
    const stale = idOf('k-h');
    runtime.showPage('numbers');
    expect((await adapter.handle(activation(stale), OWNER)).kind).toBe('ignored');
    expect((await adapter.handle(activation('predictions/0/hello'), OWNER)).kind).toBe('ignored');
    expect(
      (
        await adapter.handle(activation(idOf('n-1')), {
          executedBy: 'pipeline',
          failed: false,
        })
      ).kind,
    ).toBe('ignored');
    // A key of the same page that is not on the screen right now (spacer ids too).
    runtime.showPage('letters');
    expect((await adapter.handle(activation(idOf('k-pad-l')), OWNER)).kind).toBe('ignored');
    expect((await adapter.handle(activation(idOf('n-1')), OWNER)).kind).toBe('ignored');
    expect(calls).toEqual([]);
  });

  it('executes each activation exactly once, and nothing after dispose', async () => {
    const { adapter, calls, idOf } = setup();
    const event = activation(idOf('k-a'));
    const [first, second] = await Promise.all([
      adapter.handle(event, OWNER),
      adapter.handle(event, OWNER),
    ]);
    expect([first.kind, second.kind]).toEqual(['executed', 'ignored']);
    expect(calls).toHaveLength(1);
    // A single key asked to repeat does nothing.
    expect((await adapter.handle(activation(idOf('k-a'), 1), OWNER)).kind).toBe('ignored');
    adapter.dispose();
    expect((await adapter.handle(activation(idOf('k-b')), OWNER)).kind).toBe('ignored');
    expect(calls).toHaveLength(1);
  });

  it('executes synchronously inside handle', () => {
    const { adapter, calls, idOf } = setup();
    void adapter.handle(activation(idOf('k-a')), OWNER);
    expect(calls).toHaveLength(1);
  });

  it('reports a failing command and says so', async () => {
    const failure = new Error('boom');
    const { adapter, errors, idOf } = setup('forsee/en-qwerty', failure);
    const result = await adapter.handle(activation(idOf('k-a')), OWNER);
    expect(result).toMatchObject({ kind: 'failed', error: failure });
    expect(errors).toEqual([failure]);
  });
});
