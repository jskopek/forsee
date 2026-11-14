import type { Kernel } from '@forsee/core';
import type { GazePipeline, TargetRegistry } from '@forsee/gaze';
import type { LayoutRuntime } from '@forsee/layouts';
import type { CandidateStabiliser, PredictionEngine } from '@forsee/prediction';
import type {
  CommandInvocation,
  DwellClass,
  RegionId,
  RegionSize,
  ThemeDefinition,
} from '@forsee/plugin-api';
import type { ComponentType, ReactNode } from 'react';

/**
 * Contracts of the UI package (B8 implements them; C1–C7 consume them).
 * The UI renders; it owns no state that is not also in the kernel. Every
 * selectable element is a `GazeTarget`, which registers with the gaze
 * target registry instead of handling hover itself.
 */

/** Everything the React tree needs, provided once at the root (`<ForseeProvider services={...}>`). */
export interface UiServices {
  readonly kernel: Kernel;
  /** The gaze pipeline; absent in tap-only or test setups (targets then fire on click). */
  readonly gaze?: GazePipeline;
  readonly prediction?: PredictionEngine;
  readonly stabiliseCandidates?: CandidateStabiliser;
}

/** Props of the `GazeTarget` component B8 provides. */
export interface GazeTargetProps {
  /** Unique target id; see `TargetDescriptor.id`. */
  readonly id: string;
  readonly dwellClass: DwellClass;
  /** Runs on activation (dwell, click, switch). */
  readonly command?: CommandInvocation;
  /** Called on activation in addition to (or instead of) `command`. */
  readonly onActivate?: (repeatIndex: number) => void;
  readonly likelihood?: number;
  readonly text?: string;
  readonly label?: string;
  readonly afterActivate?: 'look-away' | 'repeat';
  readonly disabled?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}

/** Props passed to a first-party panel component rendered in a region. */
export interface PanelComponentProps {
  /** Global panel id (`<ownerId>/<panelId>`). */
  readonly panelId: string;
  readonly region: RegionId;
  readonly size: RegionSize;
  readonly services: UiServices;
}

/** A first-party panel's React component, registered under its `PanelContribution.id`. */
export type PanelComponent = ComponentType<PanelComponentProps>;

/** Where first-party panels register their components (`render.kind === 'component'`). */
export interface PanelComponentRegistry {
  register(panelId: string, component: PanelComponent): { dispose(): void };
  get(panelId: string): PanelComponent | undefined;
}

/** Props of the keyboard view B8 provides. */
export interface KeyboardViewProps {
  readonly runtime: LayoutRuntime;
  /** Used by the keyboard view to register its keys. */
  readonly targets: TargetRegistry;
}

/** Applies a theme as CSS variables on the document root (B8). */
export type ThemeApplier = (theme: ThemeDefinition) => void;
