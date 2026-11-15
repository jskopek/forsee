import {
  FakeClock,
  SequentialIdSource,
  createKernel,
  type ErrorReporter,
  type Kernel,
} from '@forsee/core';
import {
  DEFAULT_DWELL_CONFIG,
  GAZE_SETTINGS_NAMESPACE,
  GAZE_SETTING_FIELDS,
  createGazePipeline,
  createTargetRegistry,
  type DwellConfig,
  type GazeEngineConfigPatch,
  type GazePipeline,
  type GazeTargetRegistry,
} from '@forsee/gaze';
import { createAutoPointerSource, type AutoPointerSource } from '@forsee/gaze-web';
import { FakePointerEnvironment, type PointerScript } from '@forsee/gaze-web/testing';
import { createLayoutRuntime, getBuiltinLayout, type LayoutRuntime } from '@forsee/layouts';
import type {
  Disposable,
  JsonObject,
  LayoutDefinition,
  Point,
  PredictionProvider,
  Rect,
} from '@forsee/plugin-api';
import {
  createNgramProvider,
  createPredictionEngine,
  createUserModel,
  type PredictionEngine,
} from '@forsee/prediction';
import { loadEnglishModel } from '@forsee/prediction/english';
import { act, render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { HostUiServices } from './contracts';
import { measureElement, type UiDomEnvironment } from './dom';
import { HostUiProvider } from './provider';

/**
 * Test helpers for this package and for the app assembler: a real kernel,
 * a real gaze pipeline fed by the automatic pointer source over a
 * `FakePointerEnvironment`, a real layout runtime and a prediction engine
 * with the English model, all on one `FakeClock`. Import from
 * `@forsee/ui/testing` in a test file that opts into jsdom
 * (`// @vitest-environment jsdom`).
 */

/** Measures elements by their `data-forsee-measure` name (jsdom has no layout). */
export type MeasureByName = (name: string, element: Element) => Rect | undefined;

/**
 * A scriptable `UiDomEnvironment`: rectangles come from `measure`
 * (falling back to `getBoundingClientRect`, all zeros in jsdom) and
 * `notify` plays a resize.
 */
export class FakeDomEnvironment implements UiDomEnvironment {
  private readonly observers = new Set<() => void>();

  constructor(public measureByName: MeasureByName = () => undefined) {}

  readonly measure = (element: Element): Rect => {
    const name = element.getAttribute('data-forsee-measure');
    return (
      (name === null ? undefined : this.measureByName(name, element)) ?? measureElement(element)
    );
  };

  readonly observe = (_element: Element, onChange: () => void): Disposable => {
    const entry = (): void => onChange();
    this.observers.add(entry);
    return { dispose: () => void this.observers.delete(entry) };
  };

  /** Number of live observations (leak checks). */
  get observerCount(): number {
    return this.observers.size;
  }

  /** Re-measures every observed element (a window resize). */
  notify(): void {
    for (const observer of [...this.observers]) observer();
  }
}

/** A `MeasureByName` from a fixed table of rectangles. */
export function rectsByName(table: Readonly<Record<string, Rect>>): MeasureByName {
  return (name) => table[name];
}

/** Options of `createTestHost`. */
export interface TestHostOptions {
  /** Layout for `runtime`. Default: the built-in QWERTY (`forsee/en-qwerty`). */
  readonly layout?: LayoutDefinition;
  /** Dwell configuration. Default: `DEFAULT_DWELL_CONFIG`. */
  readonly dwell?: DwellConfig;
  readonly engine?: GazeEngineConfigPatch;
  /** Build a gaze pipeline. Default true; false gives a tap-only (click) setup. */
  readonly gaze?: boolean;
  /** Build a prediction engine with the English model. Default true. */
  readonly prediction?: boolean;
  /** Prediction providers to register instead of the English-model n-gram provider. */
  readonly providers?: readonly PredictionProvider[];
  /** Rectangles for elements by `data-forsee-measure` name. */
  readonly measure?: MeasureByName;
}

/** Everything `createTestHost` built. */
export interface TestHost {
  readonly clock: FakeClock;
  readonly kernel: Kernel;
  /** Undefined when built with `gaze: false`. */
  readonly pipeline: GazePipeline | undefined;
  readonly registry: GazeTargetRegistry;
  /** The fake pointer the automatic source listens to. */
  readonly pointer: FakePointerEnvironment;
  readonly source: AutoPointerSource | undefined;
  readonly runtime: LayoutRuntime;
  readonly prediction: PredictionEngine | undefined;
  readonly services: HostUiServices;
  readonly dom: FakeDomEnvironment;
  /** Everything reported through `reportError`. */
  readonly errors: [unknown, string][];
  readonly reportError: ErrorReporter;
  /** Advances the clock inside `act`, flushing promises (command outcomes) too. */
  advance(ms: number): Promise<void>;
  /** Plays a pointer script against `pointer` and the clock, inside `act`. */
  play(script: PointerScript): Promise<void>;
  /** Moves the pointer to `point` and holds it there for `holdMs`. */
  dwellAt(point: Point, holdMs: number): Promise<void>;
  /** The centre of a registered target, for pointing at it. */
  centreOf(targetId: string): Point;
  dispose(): void;
}

/** Builds a test host (not rendered). */
export function createTestHost(options: TestHostOptions = {}): TestHost {
  const clock = new FakeClock();
  const errors: [unknown, string][] = [];
  const reportError: ErrorReporter = (error, context) => {
    errors.push([error, context]);
  };
  const registry = createTargetRegistry({ reportError });
  const late: { kernel?: Kernel } = {};
  const pipeline =
    options.gaze === false
      ? undefined
      : createGazePipeline({
          clock,
          targets: registry,
          dwell: options.dwell ?? DEFAULT_DWELL_CONFIG,
          ...(options.engine === undefined ? {} : { engine: options.engine }),
          executeCommand: (command, args, source) => {
            if (!late.kernel) return Promise.reject(new Error('kernel not ready'));
            return late.kernel.commands.execute(command, args as JsonObject | undefined, source);
          },
          reportError,
        });
  const kernel = createKernel({
    clock,
    ids: new SequentialIdSource(),
    deviceId: 'test-device',
    reportError,
    ...(pipeline ? { gaze: pipeline } : {}),
  });
  late.kernel = kernel;
  kernel.settings.registerSchema(GAZE_SETTINGS_NAMESPACE, GAZE_SETTING_FIELDS);

  const pointer = new FakePointerEnvironment();
  const source = pipeline ? createAutoPointerSource({ clock, environment: pointer }) : undefined;
  if (pipeline && source) pipeline.setSource(source.source);

  let prediction: PredictionEngine | undefined;
  if (options.prediction !== false) {
    const providers = options.providers ?? [
      createNgramProvider({ base: loadEnglishModel(), user: createUserModel({ clock }) }),
    ];
    for (const provider of providers) {
      kernel.extensions.register('predictionProviders', 'app', provider);
    }
    prediction = createPredictionEngine({ extensions: kernel.extensions, clock, reportError });
  }

  const layout = options.layout ?? getBuiltinLayout('forsee/en-qwerty');
  if (!layout) throw new Error('The built-in QWERTY layout is missing');
  const runtime = createLayoutRuntime(layout, { onListenerError: reportError });
  const dom = new FakeDomEnvironment(options.measure);
  const services: HostUiServices = {
    kernel,
    ...(pipeline ? { gaze: pipeline } : {}),
    ...(prediction ? { prediction } : {}),
  };

  const host: TestHost = {
    clock,
    kernel,
    pipeline,
    registry,
    pointer,
    source,
    runtime,
    prediction,
    services,
    dom,
    errors,
    reportError,
    async advance(ms) {
      await act(async () => {
        clock.advance(ms);
        await flushPromises();
      });
    },
    async play(script) {
      await act(async () => {
        script.play(pointer, clock);
        await flushPromises();
      });
    },
    async dwellAt(point, holdMs) {
      await act(async () => {
        pointer.move(point.x, point.y);
        clock.advance(holdMs);
        await flushPromises();
      });
    },
    centreOf(targetId) {
      const target = registry.get(targetId);
      if (!target) throw new Error(`No registered target ${targetId}`);
      return {
        x: target.rect.x + target.rect.width / 2,
        y: target.rect.y + target.rect.height / 2,
      };
    },
    dispose() {
      pipeline?.dispose();
      prediction?.dispose();
      kernel.dispose();
    },
  };
  return host;
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Options of `renderWithHost`. */
export interface RenderWithHostOptions extends TestHostOptions {
  /** Use an existing host instead of building one. */
  readonly host?: TestHost;
  readonly render?: Omit<RenderOptions, 'queries'>;
}

/** What `renderWithHost` returns: Testing Library's result plus the host. */
export type RenderWithHostResult = RenderResult & { readonly host: TestHost };

/** Wraps `ui` in a `HostUiProvider` over the test host's services. */
export function HostUiTestProvider({
  host,
  children,
}: {
  readonly host: TestHost;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <HostUiProvider services={host.services} dom={host.dom} reportError={host.reportError}>
      {children}
    </HostUiProvider>
  );
}

/**
 * Renders `ui` inside a `HostUiProvider` with real engines (see
 * `createTestHost`). Unmount with Testing Library's `cleanup` (or
 * `result.unmount()`) and call `result.host.dispose()` afterwards.
 */
export function renderWithHost(
  ui: ReactElement,
  options: RenderWithHostOptions = {},
): RenderWithHostResult {
  const host = options.host ?? createTestHost(options);
  const result = render(ui, {
    ...options.render,
    wrapper: ({ children }: { children?: ReactNode }) => (
      <HostUiTestProvider host={host}>{children}</HostUiTestProvider>
    ),
  });
  return Object.assign(result, { host });
}
