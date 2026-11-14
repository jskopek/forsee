import { ForseeError, defaultErrorReporter, type ErrorReporter } from '@forsee/core';
import type {
  ActivateEvent,
  Disposable,
  GazeSample,
  GazeSource,
  JsonObject,
  SelectionMethodId,
  SourceError,
} from '@forsee/plugin-api';
import {
  assertDwellConfig,
  resolveGazeEngineConfig,
  type GazeEngineConfig,
  type GazeEngineConfigPatch,
} from './config';
import type {
  CalibrationModel,
  DwellConfig,
  EngageEvent,
  FixationState,
  GazeFilter,
  GazePipeline,
  GazePipelineOptions,
  HitTestResult,
  SelectionEvent,
  SelectionMethod,
  TargetRegistry,
} from './contracts';
import { createGazeFilter } from './filter';
import { IdtFixationDetector } from './fixation';
import { DwellSelection, createSelectionMethod } from './selection';
import { roleOf } from './targets';

/**
 * The assembled input pipeline:
 *
 *   source → calibration correction → filter → fixation detection
 *          → hit test (with hysteresis) → key distribution → selection → command
 *
 * Per valid sample: the calibration model (if any) corrects the point, the
 * filter for the source's kind smooths it (`pointer` sources are not
 * filtered), `onSample` listeners see the result, the fixation detector
 * updates, the registry hit-tests the filtered point with the previously
 * engaged target as hysteresis anchor (press samples use none: a tap is
 * where it is), and when a fixation is in progress the hit's key
 * distribution is recomputed from the fixation centroid and spread. The
 * selection method then turns that into progress and activation events.
 *
 * On activation the target's command (from the registry, at activation
 * time) is run through `executeCommand(command, args, 'gaze')`. If it is
 * `composition.insert` without a `distribution`, the activation's
 * distribution is attached (unless `attachDistribution` is false). A wake
 * target without a command resumes the pipeline directly. `onActivate`
 * listeners run after the command settles; failures go to `reportError`.
 *
 * Between samples, a clock interval (`tickIntervalMs`) sends `tick` inputs
 * so dwell progress keeps moving for slow sources. With `tickIntervalMs` 0
 * the pipeline is driven by samples alone.
 */
class GazePipelineImpl implements GazePipeline {
  readonly targets: TargetRegistry;
  private readonly clock: GazePipelineOptions['clock'];
  private readonly executeCommand: GazePipelineOptions['executeCommand'];
  private readonly reportError: ErrorReporter;
  private readonly attachDistribution: boolean;

  private dwell: DwellConfig;
  private engine: GazeEngineConfig;
  private methodId: SelectionMethodId;
  private method: SelectionMethod;
  private methodSubscription: Disposable;
  private readonly targetsSubscription: Disposable;
  private pausedFlag = false;
  private disposed = false;

  private source: GazeSource | null = null;
  private sourceToken = 0;
  private sourceKind: 'pointer' | 'gaze' = 'gaze';
  private calibration: CalibrationModel | null = null;
  private filter: GazeFilter;
  private fixationDetector: IdtFixationDetector;
  private tickTimer: Disposable | null = null;

  private engagedId: string | null = null;
  private inRestZone = false;

  private readonly selectionListeners = new Set<{ fn: (event: SelectionEvent) => void }>();
  private readonly sampleListeners = new Set<{ fn: (sample: GazeSample) => void }>();
  private readonly activateListeners = new Set<{ fn: (event: ActivateEvent) => void }>();
  private readonly engageListeners = new Set<{ fn: (event: EngageEvent) => void }>();
  private readonly sourceErrorListeners = new Set<{ fn: (error: SourceError) => void }>();

  constructor(options: GazePipelineOptions) {
    this.clock = options.clock;
    this.targets = options.targets;
    this.executeCommand = options.executeCommand;
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.attachDistribution = options.attachDistribution ?? true;
    this.dwell = assertDwellConfig(options.dwell);
    this.engine = resolveGazeEngineConfig(options.engine ?? {});
    this.filter = createGazeFilter(this.sourceKind, this.engine.filter);
    this.fixationDetector = new IdtFixationDetector(this.engine.fixation);
    this.methodId = options.method ?? 'dwell';
    this.method = this.buildMethod(this.methodId);
    this.methodSubscription = this.method.onEvent((event) => this.onMethodEvent(event));
    this.targetsSubscription = this.targets.onDidChange(() => this.onTargetsChanged());
  }

  // ---------------------------------------------------------------- GazeControl

  get paused(): boolean {
    return this.pausedFlag;
  }

  pause(): void {
    if (this.disposed || this.pausedFlag) return;
    this.pausedFlag = true;
    this.method.setPaused(true);
  }

  resume(): void {
    if (this.disposed || !this.pausedFlag) return;
    this.pausedFlag = false;
    this.method.setPaused(false);
  }

  // ---------------------------------------------------------------- configuration

  get selectionMethod(): SelectionMethodId {
    return this.methodId;
  }

  get dwellConfig(): DwellConfig {
    return this.dwell;
  }

  get engineConfig(): GazeEngineConfig {
    return this.engine;
  }

  setSelectionMethod(method: SelectionMethodId): void {
    this.assertLive();
    if (method === this.methodId) return;
    const next = this.buildMethod(method);
    this.method.reset();
    this.methodSubscription.dispose();
    this.method.dispose();
    this.methodId = method;
    this.method = next;
    this.methodSubscription = next.onEvent((event) => this.onMethodEvent(event));
  }

  setDwellConfig(config: DwellConfig): void {
    this.assertLive();
    this.dwell = assertDwellConfig(config);
    if (this.method instanceof DwellSelection)
      this.method.setConfig(this.dwell, this.engine.selection);
  }

  setEngineConfig(patch: GazeEngineConfigPatch): void {
    this.assertLive();
    this.engine = resolveGazeEngineConfig(patch, this.engine);
    this.filter = createGazeFilter(this.sourceKind, this.engine.filter);
    this.fixationDetector = new IdtFixationDetector(this.engine.fixation);
    if (this.method instanceof DwellSelection)
      this.method.setConfig(this.dwell, this.engine.selection);
    this.restartTicks();
  }

  setCalibration(model: CalibrationModel | null): void {
    this.assertLive();
    this.calibration = model;
    this.filter.reset();
    this.fixationDetector.reset();
  }

  // ---------------------------------------------------------------- sources

  setSource(source: GazeSource | null): void {
    this.assertLive();
    this.stopSource();
    this.method.reset();
    this.setEngaged(null, false, this.clock.now());
    if (!source) return;
    this.source = source;
    this.sourceKind = source.kind;
    this.filter = createGazeFilter(source.kind, this.engine.filter);
    this.fixationDetector.reset();
    const token = ++this.sourceToken;
    this.restartTicks();
    try {
      source.start(
        (sample) => {
          if (token === this.sourceToken) this.processSample(sample);
        },
        (error) => {
          if (token === this.sourceToken) this.onSourceErrorInternal(error);
        },
      );
    } catch (error) {
      this.stopSource();
      throw error;
    }
  }

  switchInput(pressed: boolean): void {
    if (this.disposed) return;
    this.method.process({ type: 'switch', t: this.clock.now(), pressed });
  }

  // ---------------------------------------------------------------- listeners

  onSelection(listener: (event: SelectionEvent) => void): Disposable {
    return subscribe(this.selectionListeners, listener, this.disposed);
  }

  onSample(listener: (sample: GazeSample) => void): Disposable {
    return subscribe(this.sampleListeners, listener, this.disposed);
  }

  onActivate(listener: (event: ActivateEvent) => void): Disposable {
    return subscribe(this.activateListeners, listener, this.disposed);
  }

  onEngage(listener: (event: EngageEvent) => void): Disposable {
    return subscribe(this.engageListeners, listener, this.disposed);
  }

  onSourceError(listener: (error: SourceError) => void): Disposable {
    return subscribe(this.sourceErrorListeners, listener, this.disposed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.targetsSubscription.dispose();
    this.stopSource();
    this.methodSubscription.dispose();
    this.method.dispose();
    this.disposed = true;
    this.selectionListeners.clear();
    this.sampleListeners.clear();
    this.activateListeners.clear();
    this.engageListeners.clear();
    this.sourceErrorListeners.clear();
  }

  // ---------------------------------------------------------------- internals

  private assertLive(): void {
    if (this.disposed) throw new ForseeError('disposed', 'The gaze pipeline has been disposed');
  }

  private buildMethod(id: SelectionMethodId): SelectionMethod {
    const method = createSelectionMethod(id, {
      dwell: this.dwell,
      tuning: this.engine.selection,
      reportError: this.reportError,
    });
    method.setPaused(this.pausedFlag);
    return method;
  }

  private stopSource(): void {
    this.sourceToken += 1;
    this.tickTimer?.dispose();
    this.tickTimer = null;
    const source = this.source;
    this.source = null;
    if (source) {
      try {
        source.stop();
      } catch (error) {
        this.reportError(error, 'gaze.source.stop');
      }
    }
  }

  private restartTicks(): void {
    this.tickTimer?.dispose();
    this.tickTimer = null;
    if (!this.source || this.engine.tickIntervalMs <= 0) return;
    this.tickTimer = this.clock.setInterval(() => {
      if (!this.disposed) this.method.process({ type: 'tick', t: this.clock.now() });
    }, this.engine.tickIntervalMs);
  }

  private onSourceErrorInternal(error: SourceError): void {
    if (!error.recoverable) {
      // The source has stopped itself; drop it without calling stop().
      this.sourceToken += 1;
      this.source = null;
      this.tickTimer?.dispose();
      this.tickTimer = null;
      this.method.reset();
      this.setEngaged(null, false, this.clock.now());
    }
    emit(this.sourceErrorListeners, error, this.reportError, 'gaze.sourceError');
  }

  private processSample(raw: GazeSample): void {
    if (this.disposed) return;
    const usable =
      raw.valid && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.t);
    let sample: GazeSample = usable ? raw : { ...raw, valid: false };
    if (usable && this.calibration) {
      const corrected = this.calibration.apply({ x: raw.x, y: raw.y });
      sample = { ...sample, x: corrected.x, y: corrected.y };
    }
    sample = this.filter.filter(sample);
    emit(this.sampleListeners, sample, this.reportError, 'gaze.sample');

    const fixation = this.fixationDetector.update(sample);
    let hit: HitTestResult = NO_HIT;
    if (sample.valid) {
      const anchor = sample.press === true ? null : this.engagedId;
      hit = this.targets.hitTest({ x: sample.x, y: sample.y }, anchor);
      hit = this.withFixationDistribution(hit, fixation);
      this.setEngaged(hit.target?.id ?? null, hit.inRestZone, sample.t);
    }
    this.method.process({ type: 'sample', sample, fixation, hit });
  }

  /** Replaces the hit's distribution with one centred on the current fixation, when there is one. */
  private withFixationDistribution(hit: HitTestResult, state: FixationState): HitTestResult {
    const target = hit.target;
    const fixation = state.fixation;
    if (target?.text === undefined || !fixation) return hit;
    return {
      ...hit,
      distribution: this.targets.keyDistribution(
        { x: fixation.x, y: fixation.y },
        fixation.spreadPx,
        target.id,
      ),
    };
  }

  /** A layout change removed the engaged target: drop its progress so it cannot fire. */
  private onTargetsChanged(): void {
    if (this.disposed || this.engagedId === null || this.targets.get(this.engagedId)) return;
    this.method.reset();
    this.setEngaged(null, false, this.clock.now());
  }

  private setEngaged(targetId: string | null, inRestZone: boolean, t: number): void {
    if (targetId === this.engagedId && inRestZone === this.inRestZone) return;
    this.engagedId = targetId;
    this.inRestZone = inRestZone;
    emit(this.engageListeners, { targetId, inRestZone, t }, this.reportError, 'gaze.engage');
  }

  private onMethodEvent(event: SelectionEvent): void {
    emit(this.selectionListeners, event, this.reportError, 'gaze.selection');
    if (event.type === 'activate') this.runActivation(event);
  }

  private runActivation(event: ActivateEvent): void {
    const target = this.targets.get(event.targetId);
    const invocation = target?.command;
    const finish = (): void => {
      emit(this.activateListeners, event, this.reportError, 'gaze.activate');
    };
    if (!invocation) {
      if (target && roleOf(target) === 'wake') this.resume();
      finish();
      return;
    }
    let args: JsonObject | undefined = invocation.args;
    if (
      this.attachDistribution &&
      invocation.command === 'composition.insert' &&
      args?.distribution === undefined
    ) {
      args = { ...args, distribution: toJsonDistribution(event) };
    }
    let promise: Promise<unknown>;
    try {
      promise = this.executeCommand(invocation.command, args, 'gaze');
    } catch (error) {
      promise = Promise.reject(
        error instanceof Error ? error : new Error(String(error), { cause: error }),
      );
    }
    promise.then(
      () => finish(),
      (error: unknown) => {
        this.reportError(error, `gaze.command:${invocation.command}`);
        finish();
      },
    );
  }
}

const NO_HIT: HitTestResult = Object.freeze({
  target: null,
  inRestZone: false,
  distribution: Object.freeze({ entries: Object.freeze([]) }),
});

function toJsonDistribution(event: ActivateEvent): JsonObject {
  return {
    entries: event.distribution.entries.map((e) =>
      e.text === undefined
        ? { targetId: e.targetId, probability: e.probability }
        : { targetId: e.targetId, text: e.text, probability: e.probability },
    ),
  };
}

function subscribe<T>(
  set: Set<{ fn: (value: T) => void }>,
  listener: (value: T) => void,
  disposed: boolean,
): Disposable {
  const entry = { fn: listener };
  if (!disposed) set.add(entry);
  let done = false;
  return {
    dispose: () => {
      if (done) return;
      done = true;
      set.delete(entry);
    },
  };
}

function emit<T>(
  set: Set<{ fn: (value: T) => void }>,
  value: T,
  reportError: ErrorReporter,
  context: string,
): void {
  for (const entry of [...set]) {
    if (!set.has(entry)) continue;
    try {
      entry.fn(value);
    } catch (error) {
      reportError(error, context);
    }
  }
}

/**
 * Builds the gaze input pipeline. The result also satisfies the kernel's
 * `GazeControl`, so it can be passed as `createKernel({ gaze })`.
 *
 * ```ts
 * const targets = createTargetRegistry();
 * const gaze = createGazePipeline({
 *   clock: host.clock,
 *   targets,
 *   dwell: DEFAULT_DWELL_CONFIG,
 *   executeCommand: (id, args, source) => kernel.commands.execute(id, args, source),
 * });
 * const kernel = createKernel({ ..., gaze });
 * gaze.setSource(pointerSource);
 * ```
 *
 * (The kernel needs the pipeline and the pipeline needs the kernel's
 * `execute`; close over a variable as above, assigned after `createKernel`.)
 */
export function createGazePipeline(options: GazePipelineOptions): GazePipeline {
  return new GazePipelineImpl(options);
}
