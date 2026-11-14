import type { CommandInvocation } from '@forsee/plugin-api';
import type { ReactNode } from 'react';
import { GazeTarget } from './gaze-target';

/** One tile of a `PhraseBar`. */
export interface PhraseTile {
  /** Unique within the bar; the target id is `<idPrefix>/<id>`. */
  readonly id: string;
  /** What the tile shows. */
  readonly label: string;
  /** What one dwell (or tap) runs; the gaze pipeline executes it once. */
  readonly command: CommandInvocation;
  /** Drawn in the alarm colour (for example "Help"). */
  readonly emphasis?: boolean;
}

/** Props of `PhraseBar`. */
export interface PhraseBarProps {
  /** Accessible name of the row. */
  readonly label: string;
  readonly tiles: readonly PhraseTile[];
  /** Target id prefix. Default `phrases`. */
  readonly idPrefix?: string;
  readonly className?: string;
}

/**
 * A row of one-dwell phrase tiles (the quick-fire replies). Each tile is a
 * gaze target whose command the pipeline runs exactly once. The data comes
 * from a plugin through the kernel's registries; this component only draws
 * it. Renders nothing for an empty list.
 */
export function PhraseBar({
  label,
  tiles,
  idPrefix = 'phrases',
  className = '',
}: PhraseBarProps): ReactNode {
  if (tiles.length === 0) return null;
  return (
    <nav
      aria-label={label}
      className={`grid h-full w-full gap-[clamp(0.375rem,1vw,0.75rem)] ${className}`}
      style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}
    >
      {tiles.map((tile) => (
        <GazeTarget
          key={tile.id}
          id={`${idPrefix}/${tile.id}`}
          dwellClass="function"
          command={tile.command}
          label={tile.label}
          appearance={tile.emphasis === true ? 'danger' : 'prediction'}
          className="h-full w-full px-1"
        >
          <span
            className={`line-clamp-2 max-w-full break-words text-center text-[clamp(0.85rem,2.2vh,1.3rem)] leading-tight ${
              tile.emphasis === true ? 'font-bold uppercase tracking-wide' : 'font-medium'
            }`}
          >
            {tile.label}
          </span>
        </GazeTarget>
      ))}
    </nav>
  );
}
