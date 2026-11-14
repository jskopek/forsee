import { FakeClock } from '@forsee/core';
import type { PluginManifest } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import type { ConsentRecord } from './contracts';
import { MemoryConsentStorage, PluginPermissionManager } from './permissions';
import { ScriptedConsentPrompt, testManifest } from './testing';

const MANIFEST: PluginManifest = testManifest({
  id: 'community.perm',
  permissions: ['composition.read', 'history.read', 'network:api.example.com'],
  optionalPermissions: ['speech.output', 'camera'],
});

function setup(options: { answer?: boolean; storage?: MemoryConsentStorage } = {}) {
  const consent = new ScriptedConsentPrompt(options.answer ?? true);
  const clock = new FakeClock({ wall: Date.UTC(2026, 10, 13) });
  const errors: unknown[] = [];
  const storage = options.storage ?? new MemoryConsentStorage();
  const manager = new PluginPermissionManager({
    consent,
    clock,
    appVersion: '1.4.0',
    storage,
    reportError: (error) => errors.push(error),
  });
  return { consent, clock, manager, storage, errors };
}

describe('install consent', () => {
  it('asks once for every install scope and records the decision', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    expect(manager.has('community.perm', 'composition.read')).toBe(false);
    expect(await manager.requestInstall('community.perm')).toBe(true);
    expect(consent.requests).toEqual([
      {
        pluginId: 'community.perm',
        scopes: ['composition.read', 'history.read', 'network:api.example.com'],
        reason: 'install',
      },
    ]);
    expect(manager.has('community.perm', 'composition.read')).toBe(true);
    expect(manager.has('community.perm', 'network:api.example.com')).toBe(true);
    // Asking again does not prompt.
    expect(await manager.requestInstall('community.perm')).toBe(true);
    expect(consent.requests).toHaveLength(1);
    const record = manager.records('community.perm').find((r) => r.scope === 'composition.read');
    expect(record).toEqual({
      pluginId: 'community.perm',
      scope: 'composition.read',
      granted: true,
      decidedAt: Date.UTC(2026, 10, 13),
      version: '1.0.0',
      appVersion: '1.4.0',
      reason: 'install',
    });
  });

  it('records a refusal, holds nothing, and asks again on a later install attempt', async () => {
    const { manager, consent } = setup({ answer: false });
    manager.register(MANIFEST, 'directory');
    expect(await manager.requestInstall('community.perm')).toBe(false);
    expect(manager.has('community.perm', 'composition.read')).toBe(false);
    expect(manager.records('community.perm').every((r) => !r.granted)).toBe(true);
    consent.setAnswer(true);
    expect(await manager.requestInstall('community.perm')).toBe(true);
    expect(consent.requests).toHaveLength(2);
  });

  it('asks only for scopes added by a new version', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    manager.register(
      {
        ...MANIFEST,
        version: '1.1.0',
        permissions: [...(MANIFEST.permissions ?? []), 'inference'],
      },
      'directory',
    );
    await manager.requestInstall('community.perm');
    expect(consent.requests[1]?.scopes).toEqual(['inference']);
  });

  it('grants first-party plugins their permissions without prompting, nothing more', async () => {
    const { manager, consent } = setup();
    manager.register({ ...MANIFEST, id: 'forsee.perm' }, 'first-party');
    expect(await manager.requestInstall('forsee.perm')).toBe(true);
    expect(manager.has('forsee.perm', 'composition.read')).toBe(true);
    expect(manager.has('forsee.perm', 'history.read')).toBe(true);
    expect(manager.has('forsee.perm', 'speech.output')).toBe(false);
    expect(manager.has('forsee.perm', 'gaze.read')).toBe(false);
    expect(consent.requests).toEqual([]);
    expect(manager.records('forsee.perm').map((r) => r.reason)).toEqual([
      'first-party',
      'first-party',
      'first-party',
    ]);
  });
});

describe('first-use consent', () => {
  it('requires a second, first-use consent for sensitive scopes granted at install', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    expect(manager.has('community.perm', 'history.read')).toBe(false);
    expect(await manager.ensure('community.perm', 'history.read')).toBe(true);
    expect(consent.requests[1]).toEqual({
      pluginId: 'community.perm',
      scopes: ['history.read'],
      reason: 'first-use',
    });
    expect(manager.has('community.perm', 'history.read')).toBe(true);
    expect(await manager.ensure('community.perm', 'history.read')).toBe(true);
    expect(consent.requests).toHaveLength(2);
  });

  it('does not prompt at first use for a non-sensitive install scope', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    expect(await manager.ensure('community.perm', 'composition.read')).toBe(true);
    expect(consent.requests).toHaveLength(1);
  });

  it('never prompts at first use before install consent', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    expect(await manager.ensure('community.perm', 'history.read')).toBe(false);
    expect(consent.requests).toEqual([]);
  });

  it('asks for optional scopes at first use and remembers a refusal', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    consent.answerNext(false);
    expect(await manager.ensure('community.perm', 'speech.output')).toBe(false);
    expect(await manager.ensure('community.perm', 'speech.output')).toBe(false);
    expect(consent.requests.filter((r) => r.reason === 'first-use')).toHaveLength(1);
    // The user can still grant it from the settings.
    expect(await manager.grant('community.perm', 'speech.output')).toBe(true);
    expect(manager.has('community.perm', 'speech.output')).toBe(true);
  });

  it('shares one prompt between concurrent requests', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    const results = await Promise.all([
      manager.ensure('community.perm', 'camera'),
      manager.ensure('community.perm', 'camera'),
    ]);
    expect(results).toEqual([true, true]);
    expect(consent.requests.filter((r) => r.reason === 'first-use')).toHaveLength(1);
  });

  it('refuses undeclared scopes without prompting', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    expect(await manager.ensure('community.perm', 'microphone')).toBe(false);
    expect(await manager.ensure('community.unknown', 'camera')).toBe(false);
    expect(await manager.grant('community.perm', 'microphone')).toBe(false);
    expect(consent.requests).toHaveLength(1);
  });

  it('treats a failing prompt as no decision', async () => {
    const { manager, consent, errors } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    consent.answerNext(() => Promise.reject(new Error('dialog crashed')));
    expect(await manager.ensure('community.perm', 'camera')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(await manager.ensure('community.perm', 'camera')).toBe(true);
  });
});

describe('network scopes', () => {
  it('match the declared host exactly', async () => {
    const { manager } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    expect(manager.allowsHost('community.perm', 'api.example.com')).toBe(true);
    expect(manager.allowsHost('community.perm', 'API.Example.com')).toBe(true);
    expect(manager.allowsHost('community.perm', 'evil.api.example.com')).toBe(false);
    expect(manager.allowsHost('community.perm', 'example.com')).toBe(false);
    expect(manager.allowsHost('community.perm', 'api.example.com.evil.net')).toBe(false);
    expect(manager.has('community.perm', 'network:other.example.com')).toBe(false);
    expect(manager.allowedNetworkHosts('community.perm')).toEqual(['api.example.com']);
  });
});

describe('revocation', () => {
  it('takes effect at once, emits a change and is not undone by ensure', async () => {
    const { manager, consent } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    const changes: string[] = [];
    manager.onDidChange((id) => changes.push(id));
    const pending = manager.revoke('community.perm', 'composition.read');
    expect(manager.has('community.perm', 'composition.read')).toBe(false);
    expect(changes).toEqual(['community.perm']);
    await pending;
    expect(await manager.ensure('community.perm', 'composition.read')).toBe(false);
    expect(consent.requests).toHaveLength(1);
    // Revoked install scopes do not block loading again.
    expect(await manager.requestInstall('community.perm')).toBe(true);
    expect(
      manager.records('community.perm').find((r) => r.scope === 'composition.read')?.reason,
    ).toBe('revoke');
  });

  it('keeps a revocation of a first-party scope across registrations', async () => {
    const { manager } = setup();
    const manifest = { ...MANIFEST, id: 'forsee.perm' };
    manager.register(manifest, 'first-party');
    await manager.revoke('forsee.perm', 'composition.read');
    manager.register(manifest, 'first-party');
    expect(manager.has('forsee.perm', 'composition.read')).toBe(false);
  });
});

describe('persistence', () => {
  it('round-trips records through storage', async () => {
    const storage = new MemoryConsentStorage();
    const first = setup({ storage });
    first.manager.register(MANIFEST, 'directory');
    await first.manager.requestInstall('community.perm');
    await first.manager.ensure('community.perm', 'history.read');
    await first.manager.revoke('community.perm', 'composition.read');
    await first.manager.flush();
    expect(storage.records).toHaveLength(3);

    const second = setup({ storage });
    await second.manager.load();
    second.manager.register(MANIFEST, 'directory');
    expect(second.manager.has('community.perm', 'history.read')).toBe(true);
    expect(second.manager.has('community.perm', 'network:api.example.com')).toBe(true);
    expect(second.manager.has('community.perm', 'composition.read')).toBe(false);
    expect(await second.manager.requestInstall('community.perm')).toBe(true);
    expect(second.consent.requests).toEqual([]);
    expect(second.manager.records()).toEqual(first.manager.records());
  });

  it('skips malformed records and reports them', async () => {
    const good: ConsentRecord = {
      pluginId: 'community.perm',
      scope: 'composition.read',
      granted: true,
      decidedAt: 1,
      version: '1.0.0',
      appVersion: '1.0.0',
      reason: 'install',
    };
    const storage = new MemoryConsentStorage([
      good,
      { ...good, scope: 'root' },
      { ...good, pluginId: '../x' },
      { ...good, granted: 'yes' },
      { ...good, reason: 'because' },
      'garbage',
      null,
    ]);
    const { manager, errors } = setup({ storage });
    await manager.load();
    expect(manager.records()).toEqual([good]);
    expect(errors).toHaveLength(1);
  });

  it('forgets a plugin entirely', async () => {
    const { manager, storage } = setup();
    manager.register(MANIFEST, 'directory');
    await manager.requestInstall('community.perm');
    manager.forget('community.perm');
    await manager.flush();
    expect(manager.records()).toEqual([]);
    expect(storage.records).toEqual([]);
    expect(manager.has('community.perm', 'composition.read')).toBe(false);
  });
});
