import { computeSlots } from '@forsee/layouts';
import { stabiliseCandidates } from '@forsee/prediction';
import type { Candidate, Rect, TargetDescriptor } from '@forsee/plugin-api';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMeasuredRect } from './use-measured-rect';
import { fitFontPx } from './keyboard-view';
import { useEngagedTargetId, useHostUi, usePrediction } from './provider';
import { useTargetRegistrations } from './registration';
import { restDescriptor } from './rest-zone';
import { TargetFace } from './target-face';

/** Props of `PredictionStrip`. */
export interface PredictionStripProps {
  /** Number of fixed slots. Default 4. */
  readonly slots?: number;
  /** Target id prefix. Default `predictions`. */
  readonly idPrefix?: string;
  /** Command that accepts a candidate, called with `{ text }`. Default `composition.acceptPrediction`. */
  readonly acceptCommand?: string;
  /** Gap between slots, CSS pixels. Default 8. */
  readonly gapPx?: number;
  readonly className?: string;
}

const NO_CANDIDATES: readonly Candidate[] = Object.freeze([]);

/** Target id of the candidate `text` in slot `index`. */
export function predictionTargetId(prefix: string, index: number, text: string): string {
  return `${prefix}/${index}/${text}`;
}

function slotRects(bounds: Rect, count: number, gapPx: number): Rect[] {
  const keys = Array.from({ length: count }, (_, i) => ({
    id: `slot-${i}`,
    spacer: true as const,
  }));
  return computeSlots([{ keys }], bounds, { gapPx, edgeGrowthPx: 0 }).map((slot) => slot.rect);
}

/**
 * Word candidates from the shared prediction session: completions while a
 * word is being typed, next words after a space. A fixed number of slots
 * keeps positions stable; each candidate is a gaze target (dwell class
 * `prediction`) whose command accepts it, executed once by the pipeline.
 *
 * While gaze rests on a candidate, the strip pins it (`session.pin`), so a
 * refined result cannot move it, and keeps it in its slot if a new list
 * arrives anyway. A candidate's target id includes its text, so a slot
 * whose word changes starts its dwell afresh. Empty slots are rest areas.
 */
export function PredictionStrip({
  slots = 4,
  idPrefix = 'predictions',
  acceptCommand = 'composition.acceptPrediction',
  gapPx = 8,
  className = '',
}: PredictionStripProps): ReactNode {
  const { services } = useHostUi();
  const snapshot = usePrediction();
  const engagedId = useEngagedTargetId();
  const [bounds, boundsRef] = useMeasuredRect();

  const result = snapshot.result;
  const incoming =
    result === null
      ? NO_CANDIDATES
      : snapshot.partialWord === ''
        ? result.nextWords
        : result.completions;

  // Keep the dwelt-on candidate in its slot when the list changes
  // ("storing information from previous renders").
  const [previousIncoming, setPreviousIncoming] = useState(incoming);
  const [shownAll, setShownAll] = useState(incoming);
  const prefix = `${idPrefix}/`;
  const pinnedText = engagedId?.startsWith(prefix)
    ? (shownAll.find((c, i) => predictionTargetId(idPrefix, i, c.text) === engagedId)?.text ?? null)
    : null;
  if (incoming !== previousIncoming) {
    setPreviousIncoming(incoming);
    const stabilise = services.stabiliseCandidates ?? stabiliseCandidates;
    setShownAll(stabilise(shownAll.slice(0, slots), incoming, pinnedText));
  }
  const shown = useMemo(() => shownAll.slice(0, slots), [shownAll, slots]);

  const session = snapshot.session;
  useEffect(() => {
    session?.pin(pinnedText);
  }, [session, pinnedText]);

  const rects = useMemo(
    () => (bounds ? slotRects(bounds, slots, gapPx) : null),
    [bounds, slots, gapPx],
  );

  const descriptors = useMemo<readonly TargetDescriptor[] | null>(() => {
    if (!rects) return null;
    return rects.map((rect, i) => {
      const candidate = shown[i];
      if (!candidate) return restDescriptor(`${idPrefix}/empty-${i}`, rect);
      return {
        id: predictionTargetId(idPrefix, i, candidate.text),
        rect,
        dwellClass: 'prediction',
        command: { command: acceptCommand, args: { text: candidate.text } },
        label: candidate.text,
      };
    });
  }, [rects, shown, idPrefix, acceptCommand]);
  useTargetRegistrations(descriptors);

  return (
    <div
      ref={boundsRef}
      data-forsee-measure="predictions"
      role="group"
      aria-label="Word predictions"
      className={`relative h-full w-full ${className}`}
    >
      {bounds &&
        rects?.map((rect, i) => {
          const descriptor = descriptors?.[i];
          const style = {
            left: `${rect.x - bounds.x}px`,
            top: `${rect.y - bounds.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          };
          const candidate = shown[i];
          if (!candidate || !descriptor) {
            return (
              <div
                key={`empty-${i}`}
                aria-hidden="true"
                data-part="empty-slot"
                className="absolute rounded-xl border-2 border-dashed border-surface-overlay"
                style={style}
              />
            );
          }
          return (
            <TargetFace
              key={descriptor.id}
              id={descriptor.id}
              descriptor={descriptor}
              appearance="prediction"
              accessibleName={candidate.text}
              position="absolute"
              style={style}
            >
              <span
                className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap pb-[0.12em] pt-[0.04em] font-medium leading-tight"
                style={{
                  fontSize: `${fitFontPx(candidate.text, rect.width, rect.height, 0.42)}px`,
                }}
              >
                {candidate.text}
              </span>
            </TargetFace>
          );
        })}
    </div>
  );
}
