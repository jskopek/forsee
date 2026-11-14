/**
 * Named screen regions (plan section 4, "Regions"). The UI renders them; the
 * kernel's region model only records which panels are assigned where.
 *
 * - `composition`: the composition bar (also a rest zone: it never fires).
 * - `quickfire`: one-dwell interjections ("yes", "no", "hold on").
 * - `predictions`: the prediction strip.
 * - `main`: the keyboard or the active main panel.
 * - `side`: side panels (phrases, history, plugin panels).
 */
export type RegionId = 'composition' | 'quickfire' | 'predictions' | 'main' | 'side';

/** All region ids in their default top-to-bottom, then side, order. */
export const REGION_IDS: readonly RegionId[] = [
  'composition',
  'quickfire',
  'predictions',
  'main',
  'side',
];

/**
 * Discrete size steps for a region. Discrete steps rather than a free number
 * keep resizing operable by gaze ("bigger" / "smaller" keys).
 */
export type RegionSize = 'compact' | 'normal' | 'expanded';

/** State of one region. */
export interface RegionState {
  readonly id: RegionId;
  /** Global panel ids (`<ownerId>/<panelId>`) assigned to the region, in display order. */
  readonly panels: readonly string[];
  /** The panel currently shown when the region shows one at a time; `null` if none. Always one of `panels`. */
  readonly activePanel: string | null;
  readonly visible: boolean;
  readonly size: RegionSize;
}
