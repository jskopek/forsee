/**
 * Grapheme cluster helpers for deleting "one letter" as the user sees it
 * (an emoji with skin tone, a flag, a letter with combining accents).
 *
 * Uses `Intl.Segmenter` when the runtime has it (looked up structurally, so
 * this does not depend on the TypeScript lib declaring it) and otherwise a
 * compact approximation of the Unicode extended grapheme cluster rules that
 * matter for typed text: combining marks, variation selectors, emoji
 * modifiers, tag sequences, ZWJ sequences, regional-indicator pairs and CRLF.
 */

interface SegmentLike {
  readonly segment: string;
}
interface SegmenterLike {
  segment(input: string): Iterable<SegmentLike>;
}
type SegmenterConstructor = new (
  locales?: string | readonly string[],
  options?: { granularity: 'grapheme' },
) => SegmenterLike;

function findSegmenter(): SegmenterLike | null {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (typeof ctor !== 'function') return null;
  try {
    return new ctor(undefined, { granularity: 'grapheme' });
  } catch {
    return null;
  }
}

const nativeSegmenter: SegmenterLike | null = findSegmenter();

const ZWJ = '‍';
const MARK = /^\p{M}$/u;

/** Code points that attach to the preceding one (Grapheme_Cluster_Break=Extend, simplified). */
function isExtend(cp: string): boolean {
  if (MARK.test(cp)) return true;
  const c = cp.codePointAt(0) ?? 0;
  return (
    c === 0x200c || // zero-width non-joiner
    (c >= 0xfe00 && c <= 0xfe0f) || // variation selectors
    (c >= 0x1f3fb && c <= 0x1f3ff) || // emoji skin-tone modifiers
    (c >= 0xe0020 && c <= 0xe007f) || // tag characters (subdivision flags)
    (c >= 0xe0100 && c <= 0xe01ef) // variation selectors supplement
  );
}
const REGIONAL_INDICATOR = /^[\u{1f1e6}-\u{1f1ff}]$/u;

/** How many code points at the end of `cps` form the last grapheme cluster (fallback rules). */
function lastClusterSize(cps: readonly string[]): number {
  const end = cps.length;
  if (end === 0) return 0;
  let start = end - 1;
  for (;;) {
    const cur = cps[start]!;
    const prev = cps[start - 1];
    if (prev === undefined) break;
    if (isExtend(cur) || cur === ZWJ) {
      start -= 1;
      continue;
    }
    if (prev === ZWJ && start >= 2) {
      start -= 2;
      continue;
    }
    if (start === end - 1) {
      if (cur === '\n' && prev === '\r') {
        start -= 1;
      } else if (REGIONAL_INDICATOR.test(cur) && REGIONAL_INDICATOR.test(prev)) {
        let run = 0;
        for (let k = end - 1; k >= 0 && REGIONAL_INDICATOR.test(cps[k]!); k -= 1) run += 1;
        if (run % 2 === 0) start -= 1;
      }
    }
    break;
  }
  return end - start;
}

/** UTF-16 length of the last grapheme cluster of `text`, using only the fallback rules. */
export function lastGraphemeLengthFallback(text: string): number {
  const cps = Array.from(text);
  const size = lastClusterSize(cps);
  let length = 0;
  for (let i = cps.length - size; i < cps.length; i += 1) length += cps[i]!.length;
  return length;
}

/** Splits into grapheme clusters using only the fallback rules. */
export function splitGraphemesFallback(text: string): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  while (cps.length > 0) {
    const size = lastClusterSize(cps);
    out.push(cps.splice(cps.length - size, size).join(''));
  }
  return out.reverse();
}

/** UTF-16 length of the last grapheme cluster of `text` (0 for empty text). */
export function lastGraphemeLength(text: string): number {
  if (text === '') return 0;
  if (nativeSegmenter) {
    let last = '';
    for (const s of nativeSegmenter.segment(text)) last = s.segment;
    return last.length;
  }
  return lastGraphemeLengthFallback(text);
}

/** Splits text into grapheme clusters. */
export function splitGraphemes(text: string): string[] {
  if (nativeSegmenter) return Array.from(nativeSegmenter.segment(text), (s) => s.segment);
  return splitGraphemesFallback(text);
}

/** Whether the native `Intl.Segmenter` is in use (for diagnostics and tests). */
export const hasNativeGraphemeSegmenter: boolean = nativeSegmenter !== null;
