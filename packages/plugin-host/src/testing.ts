/**
 * Test doubles for packages that build on the plugin host
 * (`@forsee/plugin-host/testing`): a scripted consent prompt, in-memory
 * storages and file readers, a structural layout validator, and a helper
 * that builds a kernel plus a `ForseeApi` for a test manifest.
 */
import {
  createKernel,
  FakeClock,
  SequentialIdSource,
  type ErrorReporter,
  type Kernel,
  type KernelOptions,
} from '@forsee/core';
import type { LayoutValidator } from '@forsee/layouts';
import {
  API_VERSION,
  type ForseeApi,
  type LayoutDefinition,
  type PermissionScope,
  type PluginManifest,
  type PrivateStorageApi,
} from '@forsee/plugin-api';
import { createPluginApi } from './api';
import type {
  ConsentPrompt,
  PluginApiServices,
  PluginApiSession,
  PluginFiles,
  PluginOrigin,
} from './contracts';
import { isPlainObject } from './guards';
import { createMemoryPluginStorage, MemoryInstallStorage } from './host';
import { PanelTargets } from './panels';
import { MemoryConsentStorage, PluginPermissionManager } from './permissions';

export { createMemoryPluginStorage, MemoryConsentStorage, MemoryInstallStorage };

/** One request seen by `ScriptedConsentPrompt`. */
export interface ConsentRequestRecord {
  readonly pluginId: string;
  readonly scopes: readonly PermissionScope[];
  readonly reason: 'install' | 'first-use';
}

type ConsentAnswer = boolean | ((request: ConsentRequestRecord) => boolean | Promise<boolean>);

/**
 * A consent prompt whose answers are scripted: a fixed answer, a function,
 * or a queue (`answerNext`) consumed before the default. Records every request.
 */
export class ScriptedConsentPrompt implements ConsentPrompt {
  readonly requests: ConsentRequestRecord[] = [];
  private readonly queue: ConsentAnswer[] = [];

  constructor(private answer: ConsentAnswer = true) {}

  /** Changes the default answer. */
  setAnswer(answer: ConsentAnswer): void {
    this.answer = answer;
  }

  /** Queues answers for the next requests, in order. */
  answerNext(...answers: ConsentAnswer[]): void {
    this.queue.push(...answers);
  }

  ask(request: Parameters<ConsentPrompt['ask']>[0]): Promise<boolean> {
    const record: ConsentRequestRecord = {
      pluginId: request.manifest.id,
      scopes: [...request.scopes],
      reason: request.reason,
    };
    this.requests.push(record);
    const answer = this.queue.length > 0 ? this.queue.shift() : this.answer;
    return Promise.resolve(typeof answer === 'function' ? answer(record) : answer === true);
  }
}

/** Plugin files held in memory: path → text (objects are serialised as JSON). */
export class MemoryPluginFiles implements PluginFiles {
  readonly reads: string[] = [];
  private readonly files: Map<string, string>;

  constructor(files: Readonly<Record<string, unknown>> = {}) {
    this.files = new Map(
      Object.entries(files).map(([path, value]) => [
        path,
        typeof value === 'string' ? value : JSON.stringify(value),
      ]),
    );
  }

  readText(path: string): Promise<string> {
    this.reads.push(path);
    const text = this.files.get(path);
    return text === undefined
      ? Promise.reject(new Error(`No such file: ${path}`))
      : Promise.resolve(text);
  }
}

/**
 * A structural layout validator for tests (the real one is
 * `@forsee/layouts`): checks `schemaVersion`, `id`, `name`, `family`,
 * `locale`, `initialPage` naming a page, and pages with rows of keys.
 */
export const testLayoutValidator: LayoutValidator = (json) => {
  const issues: { path: string; message: string }[] = [];
  if (!isPlainObject(json))
    return { ok: false, issues: [{ path: '', message: 'Expected an object' }] };
  if (json.schemaVersion !== 1) issues.push({ path: '/schemaVersion', message: 'Expected 1' });
  for (const key of ['id', 'name', 'locale', 'initialPage'] as const) {
    if (typeof json[key] !== 'string' || json[key] === '') {
      issues.push({ path: `/${key}`, message: 'Expected a non-empty string' });
    }
  }
  if (json.family !== 'precise' && json.family !== 'coarse') {
    issues.push({ path: '/family', message: 'Expected "precise" or "coarse"' });
  }
  const pages = json.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    issues.push({ path: '/pages', message: 'Expected at least one page' });
  } else {
    const ids = pages.map((page: unknown) => (isPlainObject(page) ? page.id : undefined));
    if (!ids.includes(json.initialPage)) {
      issues.push({ path: '/initialPage', message: 'Names no page' });
    }
    pages.forEach((page: unknown, i) => {
      if (!isPlainObject(page) || typeof page.id !== 'string' || !Array.isArray(page.rows)) {
        issues.push({ path: `/pages/${i}`, message: 'Expected { id, name, rows }' });
      }
    });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: json as unknown as LayoutDefinition };
};

/** A valid minimal layout with the given id. */
export function testLayout(id: string): LayoutDefinition {
  return {
    schemaVersion: 1,
    id,
    name: 'Test layout',
    family: 'precise',
    locale: 'en-GB',
    initialPage: 'main',
    pages: [
      {
        id: 'main',
        name: 'Main',
        rows: [
          {
            keys: [
              {
                id: 'a',
                label: 'a',
                action: { command: 'composition.insert', args: { text: 'a' } },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** A valid manifest for tests, with overrides. */
export function testManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'community.test-plugin',
    name: 'Test plugin',
    version: '1.0.0',
    apiVersion: API_VERSION,
    minAppVersion: '0.0.0',
    description: 'A plugin for tests.',
    author: 'Tests',
    ...overrides,
  };
}

/** Options for `createTestPluginApi`. */
export interface TestPluginApiOptions {
  readonly manifest?: PluginManifest;
  /** Default `directory`. */
  readonly origin?: PluginOrigin;
  /**
   * Scopes to grant beyond install consent (as if the user granted them in
   * settings, so sensitive and optional scopes are held without prompting).
   * `'all'` grants every declared scope. Default: none.
   */
  readonly grant?: readonly PermissionScope[] | 'all';
  /** Default: a prompt that grants everything. */
  readonly consent?: ScriptedConsentPrompt;
  readonly kernel?: Kernel;
  readonly kernelOptions?: Partial<KernelOptions>;
  readonly services?: Partial<PluginApiServices>;
}

/** What `createTestPluginApi` returns. */
export interface TestPluginApi {
  readonly kernel: Kernel;
  readonly clock: FakeClock;
  readonly api: ForseeApi;
  readonly session: PluginApiSession;
  readonly permissions: PluginPermissionManager;
  readonly consent: ScriptedConsentPrompt;
  readonly panels: PanelTargets;
  readonly storage: PrivateStorageApi;
  /** Errors reported by the kernel and the plugin API. */
  readonly errors: { readonly error: unknown; readonly context: string }[];
}

/**
 * Builds a started kernel (fake clock, sequential ids), a permission
 * manager with install consent given, and a `ForseeApi` for the manifest.
 */
export async function createTestPluginApi(
  options: TestPluginApiOptions = {},
): Promise<TestPluginApi> {
  const manifest = options.manifest ?? testManifest();
  const errors: { error: unknown; context: string }[] = [];
  const reportError: ErrorReporter = (error, context) => errors.push({ error, context });
  const clock = new FakeClock();
  const kernel =
    options.kernel ??
    createKernel({
      clock,
      ids: new SequentialIdSource(),
      deviceId: 'test-device',
      reportError,
      ...options.kernelOptions,
    });
  if (!kernel.started) await kernel.start();
  const consent = options.consent ?? new ScriptedConsentPrompt(true);
  const permissions = new PluginPermissionManager({
    consent,
    clock,
    appVersion: '1.0.0',
    reportError,
  });
  const origin = options.origin ?? 'directory';
  permissions.register(manifest, origin);
  await permissions.requestInstall(manifest.id);
  const declared = [...(manifest.permissions ?? []), ...(manifest.optionalPermissions ?? [])];
  const grant = options.grant === 'all' ? declared : (options.grant ?? []);
  for (const scope of grant) await permissions.grant(manifest.id, scope);
  const panels = new PanelTargets({ reportError });
  const storage = createMemoryPluginStorage()(manifest.id);
  const session = createPluginApi(kernel, { manifest, origin }, permissions, {
    storage,
    validateLayout: testLayoutValidator,
    panels,
    reportError,
    ...options.services,
  });
  return {
    kernel,
    clock: kernel.clock instanceof FakeClock ? kernel.clock : clock,
    api: session.api,
    session,
    permissions,
    consent,
    panels,
    storage,
    errors,
  };
}
