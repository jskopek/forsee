import type { ActivateEvent, CommandInvocation } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { distributionToJson, withActivationDistribution } from './activation';

const event: Pick<ActivateEvent, 'distribution'> = {
  distribution: {
    entries: [
      { targetId: 'k/a', text: 'a', probability: 0.7 },
      { targetId: 'k/s', text: 's', probability: 0.2 },
      { targetId: 'k/x', probability: 0.1 },
    ],
  },
};

describe('withActivationDistribution', () => {
  it('attaches the distribution to composition.insert without one', () => {
    const invocation: CommandInvocation = { command: 'composition.insert', args: { text: 'a' } };
    const run = withActivationDistribution(invocation, event);
    expect(run).toEqual({
      command: 'composition.insert',
      args: {
        text: 'a',
        distribution: {
          entries: [
            { targetId: 'k/a', text: 'a', probability: 0.7 },
            { targetId: 'k/s', text: 's', probability: 0.2 },
            { targetId: 'k/x', probability: 0.1 },
          ],
        },
      },
    });
    // Inputs are not mutated.
    expect(invocation).toEqual({ command: 'composition.insert', args: { text: 'a' } });
  });

  it('keeps a distribution the invocation already carries', () => {
    const own = { entries: [{ targetId: 'mine', probability: 1 }] };
    const invocation = { command: 'composition.insert', args: { text: 'a', distribution: own } };
    expect(withActivationDistribution(invocation, event)).toBe(invocation);
  });

  it('leaves other commands and empty distributions alone', () => {
    const del: CommandInvocation = { command: 'composition.deleteGrapheme' };
    expect(withActivationDistribution(del, event)).toBe(del);
    const insert: CommandInvocation = { command: 'composition.insert', args: { text: 'a' } };
    expect(withActivationDistribution(insert, { distribution: { entries: [] } })).toBe(insert);
  });

  it('produces JSON (no undefined fields)', () => {
    const json = distributionToJson(event.distribution);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});
