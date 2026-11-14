/**
 * Capability tests (review round 1): instead of checking each API method
 * against its documented scope, take one capability away and check that its
 * data or effect cannot be reached through ANY path. A probe plugin holding
 * every other scope uses every API method, event, command, provider and
 * handler, while the app does everything that feeds plugins data (typing,
 * prediction, learning, transforms, speaking, output sinks, context refresh).
 *
 * Each test also runs with every scope as a control, so that a probe that
 * observed nothing at all could not pass.
 */
import { formatVoiceId, type PermissionScope } from '@forsee/plugin-api';
import { PLUGIN_API_METHODS } from '@forsee/plugin-host';
import { describe, expect, it } from 'vitest';
import { createHarness, settle, type Harness } from './harness';
import { ALL_SCOPES, createProbe, type Probe } from './probe';

const PROBE = 'forsee.probe';

const without = (scope: PermissionScope): PermissionScope[] =>
  ALL_SCOPES.filter((s) => s !== scope);

/**
 * What the app does that hands plugins data: type `text` (with a word
 * boundary, so transforms run), predict, learn and forget, send to output
 * sinks, refresh context providers, run plugin commands from a key, choose
 * the probe's voice if it offers one, press Speak, and report speech
 * progress (a word boundary and an error quoting the text).
 */
async function appActivity(h: Harness, text: string, speak: { log: boolean }): Promise<void> {
  const { kernel } = h;
  await kernel.commands.execute('composition.insert', { text }, 'keyboard');
  await kernel.commands.execute('composition.insert', { text: ' ' }, 'keyboard');
  await settle();
  const session = h.prediction.predict(h.query());
  session.onUpdate(() => undefined);
  await settle();
  await h.prediction.learn({ text, origin: 'composition', locale: 'en-GB', createdAt: 1 });
  await h.prediction.forget({ kind: 'words', words: [text] });
  for (const { contribution } of kernel.extensions.list('outputSinks')) {
    await contribution.send({ text }).catch(() => undefined);
  }
  for (const { contribution } of kernel.extensions.list('contextProviders')) {
    await Promise.resolve(contribution.refresh?.()).catch(() => undefined);
  }
  for (const { contribution } of kernel.extensions.list('commands')) {
    await kernel.commands.execute(contribution.id, undefined, 'keyboard').catch(() => undefined);
  }
  const voice = (await h.speech.listVoices()).find((v) => v.providerId.startsWith(`${PROBE}/`));
  if (voice) h.speech.setVoice(formatVoiceId(voice.providerId, voice.id));
  await kernel.commands.execute('composition.speak', { log: speak.log }, 'keyboard');
  await settle();
  h.appVoice.boundary(0, text.length);
  h.appVoice.failCurrent(`could not say "${text}"`);
  await settle();
}

async function run(
  permissions: readonly PermissionScope[],
  script: (h: Harness, probe: Probe) => Promise<void>,
  beforePlugins?: (h: Pick<Harness, 'kernel'>) => Promise<void>,
): Promise<{ probe: Probe; harness: Harness }> {
  const probe = createProbe(PROBE, permissions);
  const harness = await createHarness({
    firstParty: [probe.plugin],
    ...(beforePlugins ? { beforePlugins: (kernel) => beforePlugins({ kernel }) } : {}),
  });
  await script(harness, probe);
  await settle();
  return { probe, harness };
}

describe('capability: the probe covers the whole API', () => {
  it('calls every ForseeApi method', () => {
    expect([...createProbe(PROBE, []).methods].sort()).toEqual([...PLUGIN_API_METHODS].sort());
  });
});

describe('capability: composition text needs composition.read', () => {
  const SECRET = 'zq-composition-sentinel';

  const script = async (h: Harness, probe: Probe): Promise<void> => {
    await probe.exercise(1);
    // Not logged, so the text never becomes history (history.read is a separate capability).
    await appActivity(h, SECRET, { log: false });
    await h.kernel.commands.execute('composition.insert', { text: SECRET }, 'keyboard');
    await probe.exercise(2);
    await h.kernel.commands.execute('composition.clear', undefined, 'keyboard');
    await appActivity(h, SECRET, { log: false });
    await h.kernel.commands.execute('composition.insert', { text: SECRET }, 'keyboard');
    await probe.exercise(3);
  };

  it('a plugin with every other scope never observes the composition', async () => {
    const { probe } = await run(without('composition.read'), script);
    expect(probe.observed.length).toBeGreaterThan(100);
    expect(probe.text()).not.toContain(SECRET);
  });

  it('control: with composition.read it does', async () => {
    const { probe } = await run(ALL_SCOPES, script);
    expect(probe.text()).toContain(SECRET);
  });
});

describe('capability: conversation history needs history.read', () => {
  const SAID_BEFORE = 'zq-said-before-sentinel';
  const PARTNER = 'zq-partner-sentinel';

  const before = async ({ kernel }: Pick<Harness, 'kernel'>): Promise<void> => {
    await kernel.commands.execute('composition.insert', { text: SAID_BEFORE }, 'keyboard');
    await kernel.commands.execute('composition.speak', undefined, 'keyboard');
    kernel.conversation.append({ body: `${PARTNER}-1`, sender: 'contact' });
  };

  const script = async (h: Harness, probe: Probe): Promise<void> => {
    await probe.exercise(1);
    h.kernel.conversation.append({ body: `${PARTNER}-2`, sender: 'contact' });
    await appActivity(h, 'hello there', { log: true });
    await probe.exercise(2);
    h.kernel.conversation.append({ body: `${PARTNER}-3`, sender: 'contact' });
    await appActivity(h, 'see you later', { log: true });
    await probe.exercise(3);
  };

  it('a plugin with every other scope never observes past utterances', async () => {
    const { probe, harness } = await run(without('history.read'), script, before);
    // The undo stack still holds what was said before; the probe could not undo into it.
    expect(harness.kernel.conversation.listRecent(20).length).toBeGreaterThan(3);
    expect(probe.text()).not.toContain(SAID_BEFORE);
    expect(probe.text()).not.toContain(PARTNER);
  });

  it('control: with history.read it does', async () => {
    const { probe } = await run(ALL_SCOPES, script, before);
    expect(probe.text()).toContain(SAID_BEFORE);
    expect(probe.text()).toContain(PARTNER);
  });
});

describe('capability: changing the composition needs composition.write', () => {
  /** Every composition change, in order, while the same script runs. */
  async function changes(permissions: readonly PermissionScope[] | null): Promise<string[]> {
    const log: string[] = [];
    const probe = createProbe(PROBE, permissions ?? []);
    const harness = await createHarness({ firstParty: permissions ? [probe.plugin] : [] });
    harness.kernel.bus.on('composition.changed', (e) => log.push(`${e.reason}:${e.state.text}`));
    const exercise = async (round: number): Promise<void> => {
      if (permissions) await probe.exercise(round);
    };
    await exercise(1);
    await appActivity(harness, 'hello world', { log: true });
    await harness.kernel.commands.execute('composition.insert', { text: 'more' }, 'keyboard');
    await exercise(2);
    await appActivity(harness, 'second', { log: true });
    await exercise(3);
    await settle();
    return log;
  }

  it('a plugin with every other scope causes no change at all', async () => {
    const baseline = await changes(null);
    expect(baseline.length).toBeGreaterThan(5);
    expect(await changes(without('composition.write'))).toEqual(baseline);
  });

  it('control: with composition.write it does', async () => {
    const baseline = await changes(null);
    expect(await changes(ALL_SCOPES)).not.toEqual(baseline);
  });
});
