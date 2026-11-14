import type { ErrorReporter, Kernel } from '@forsee/core';
import type { ActivationOutcome, GazePipeline, TargetRegistry } from '@forsee/gaze';
import type { EdgeSides, LayoutRuntime } from '@forsee/layouts';
import type { CandidateStabiliser, PredictionEngine } from '@forsee/prediction';
import type {
  ActivateEvent,
  CommandInvocation,
  Disposable,
  DwellClass,
  ForseeApi,
  JsonObject,
  RegionId,
  RegionSize,
  TargetRole,
  ThemeDefinition,
} from '@forsee/plugin-api';
import type { ComponentType, ReactNode } from 'react';

/**
 * Contracts of the UI package (B8 implements them; C1–C7 consume them).
 * The UI renders; it owns no state that is not also in the kernel. Every
 * selectable element is a `GazeTarget`, which registers with the gaze
 * target registry instead of handling hover itself.
 *
 * **Two kinds of UI code** (ARCHITECTURE.md, "Decisions: activation and UI
 * boundary"):
 *
 * - **Trusted host infrastructure** may use the kernel directly, through
 *   `HostUiServices`: the app frame and regions, the keyboard view and gaze
 *   targets, dwell feedback, the settings shell, calibration, and the
 *   plugin host itself.
 * - **Features** are first-party plugins built on the public `ForseeApi`
 *   through the plugin host: the prediction strip's data, phrases,
 *   quick-fire replies, history, partner display content, any provider. A
 *   feature panel receives its plugin's `ForseeApi` (`PanelComponentProps`)
 *   and never the kernel. Where `ForseeApi` lacks something a feature
 *   needs, the API is extended (additively), never bypassed.
 */

/**
 * What trusted host infrastructure needs, provided once at the root
 * (`<HostUiProvider services={...}>`). Only infrastructure code reads it
 * (see the module comment); feature panels get `PanelComponentProps.api`.
 */
export interface HostUiServices {
  readonly kernel: Kernel;
  /** The gaze pipeline; absent in tap-only or test setups (targets then fire on click). */
  readonly gaze?: GazePipeline;
  /** The prediction engine, for the host's wiring of it; features read predictions through `ForseeApi`. */
  readonly prediction?: PredictionEngine;
  readonly stabiliseCandidates?: CandidateStabiliser;
}

/** Props of the `GazeTarget` component B8 provides. */
export interface GazeTargetProps {
  /** Unique target id; see `TargetDescriptor.id`. */
  readonly id: string;
  readonly dwellClass: DwellClass;
  /**
   * Executed on activation by the gaze pipeline (exactly once, with the
   * selection's distribution attached to `composition.insert`). Leave it out
   * when `onActivate` resolves and executes the activation itself.
   */
  readonly command?: CommandInvocation;
  /**
   * Called on every activation (dwell, click, switch) with the full
   * `ActivateEvent`: target id, method, `repeatIndex`, point, distribution
   * and time. When `command` is set, the pipeline has already executed it
   * and `onActivate` must not execute it again (use it for feedback only).
   * When `command` is absent, `onActivate` owns execution: it executes at
   * most once and attaches the distribution with
   * `withActivationDistribution(invocation, event)` from `@forsee/gaze`.
   * A click without a gaze pipeline produces an `ActivateEvent` with method
   * `direct` and a single-entry distribution.
   */
  readonly onActivate?: (event: ActivateEvent) => void;
  readonly likelihood?: number;
  readonly text?: string;
  readonly label?: string;
  readonly afterActivate?: 'look-away' | 'repeat';
  readonly disabled?: boolean;
  /**
   * Role of the registered target (default `select`). `wake` targets fire
   * only while selection is paused (the pause overlay's resume target);
   * `rest` targets never fire.
   */
  readonly role?: TargetRole;
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * Props passed to a first-party feature panel rendered in a region. A
 * feature panel is part of a first-party plugin and reaches app state only
 * through that plugin's `api`; it renders `GazeTarget`s for its selectable
 * elements (the provider wires them to the pipeline).
 */
export interface PanelComponentProps {
  /** Global panel id (`<ownerId>/<panelId>`). */
  readonly panelId: string;
  readonly region: RegionId;
  readonly size: RegionSize;
  /** The owning first-party plugin's API, as registered with the component. */
  readonly api: ForseeApi;
}

/** A first-party panel's React component, registered under its `PanelContribution.id`. */
export type PanelComponent = ComponentType<PanelComponentProps>;

/** A registered first-party panel: its component and the owning plugin's API. */
export interface RegisteredPanelComponent {
  readonly component: PanelComponent;
  readonly api: ForseeApi;
}

/**
 * Where first-party panels register their components (`render.kind ===
 * 'component'`). The owning plugin registers from its `activate`, passing
 * the `ForseeApi` it received; the region renderer passes it as
 * `PanelComponentProps.api`.
 */
export interface PanelComponentRegistry {
  register(panelId: string, component: PanelComponent, api: ForseeApi): Disposable;
  get(panelId: string): RegisteredPanelComponent | undefined;
}

/** Props of the keyboard view B8 provides (host infrastructure). */
export interface KeyboardViewProps {
  readonly runtime: LayoutRuntime;
  /**
   * Used by the keyboard view to register its keys. Default: the gaze
   * pipeline's registry from `HostUiServices` (none without a pipeline: the
   * keys then fire on click only).
   */
  readonly targets?: TargetRegistry;
  /** Gap between keys, CSS pixels. Default 8. */
  readonly gapPx?: number;
  /** Edge and corner enlargement, CSS pixels (`GeometryOptions.edgeGrowthPx`). Default 12; 0 disables. */
  readonly edgeGrowthPx?: number;
  /** Which sides of the keyboard are screen edges (for edge enlargement). Default all. */
  readonly edges?: Partial<EdgeSides>;
  /**
   * Register the `layout.showPage` and `layout.back` command handlers for
   * this runtime while mounted (skipped when another owner already has
   * them). Default true.
   */
  readonly registerLayoutCommands?: boolean;
  /**
   * Set each letter key's `likelihood` from the shared prediction session's
   * next-letter probabilities (adaptive dwell). Default true.
   */
  readonly adaptiveDwell?: boolean;
  readonly className?: string;
}

/** Applies a theme as CSS variables on the document root (B8). */
export type ThemeApplier = (theme: ThemeDefinition) => void;

// ------------------------------------------------------------------ activation adapter

/** Executes a command, typically `kernel.commands.execute` (host infrastructure). */
export type CommandExecutor = (
  command: string,
  args: JsonObject | undefined,
  source: string,
) => Promise<unknown>;

/** What the activation adapter did with one activation. */
export type ActivationAdapterResult =
  /** Not this adapter's: not a key of the current view, or the pipeline already executed it. */
  | { readonly kind: 'ignored' }
  /** The runtime handled it without an action (opened a group, went back, showed a page). */
  | { readonly kind: 'view-changed' }
  /** The action ran once; `invocation` is what was executed (distribution attached). */
  | { readonly kind: 'executed'; readonly invocation: CommandInvocation }
  /** The action ran once and rejected; the error also went to `reportError`. */
  | { readonly kind: 'failed'; readonly invocation: CommandInvocation; readonly error: unknown };

/** Options of `ActivationAdapterFactory`. */
export interface ActivationAdapterOptions {
  readonly runtime: LayoutRuntime;
  /**
   * Maps a target id to a key id of the runtime's current view, or
   * `undefined` when the target is not one of its keys (for example
   * `keyIdOfTarget(layoutId, view.pageId, id)` from `@forsee/layouts`). A
   * target of a page that is no longer showing maps to `undefined`.
   */
  readonly keyIdOf: (targetId: string) => string | undefined;
  readonly execute: CommandExecutor;
  /** Where failed commands go. Default: core's `defaultErrorReporter`. */
  readonly reportError?: ErrorReporter;
}

/**
 * The keyboard view's activation adapter (`createActivationAdapter` in
 * `activation-adapter.ts`). Layout targets carry no command, so the gaze pipeline
 * executes nothing for them and delivers the full `ActivateEvent` with
 * `executedBy: 'owner'`. For each such event, `handle`:
 *
 * 1. returns `ignored` unless `outcome.executedBy` is `'owner'` and
 *    `keyIdOf(event.targetId)` gives a key, so an activation the pipeline
 *    ran, or another owner's target, is never executed here;
 * 2. asks `runtime.activate(keyId, event.repeatIndex)` for the action,
 *    which applies escalation (`repeatIndex` picks the step), groups,
 *    page changes and `returnToPage`; `null` gives `view-changed`;
 * 3. attaches the selection's distribution with
 *    `withActivationDistribution(action, event)` from `@forsee/gaze`;
 * 4. executes the result exactly once with `execute(command, args, 'gaze')`.
 *
 * The keyboard view (`createActivationAdapter`) feeds it every activation
 * of its key targets, as delivered by the pipeline's `onActivate` (routed
 * per target id through the provider's event hub) or built for a direct
 * click or Enter key when there is no pipeline (`executedBy: 'owner'`).
 * `dispose` stops it handling anything further.
 */
export interface ActivationAdapter extends Disposable {
  handle(event: ActivateEvent, outcome: ActivationOutcome): Promise<ActivationAdapterResult>;
}

/** Factory signature of the activation adapter. */
export type ActivationAdapterFactory = (options: ActivationAdapterOptions) => ActivationAdapter;
