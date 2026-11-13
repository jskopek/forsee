/** A piece of an utterance's text, with its offset in the whole text. */
export interface TextChunk {
  /** UTF-16 offset of `text` in the original text. */
  readonly start: number;
  readonly text: string;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;
const CLAUSE_END = /[,;:—–]$/u;

/**
 * Splits `text` into pieces of at most `maxChars` UTF-16 units, so that
 * Chromium's habit of cutting long utterances short (and stalling on them)
 * cannot lose speech. Breaks are chosen, in order of preference, after a
 * sentence end, after a clause mark, at whitespace, and only then in the
 * middle of a word (never inside a surrogate pair). The pieces concatenate
 * back to exactly `text`; whitespace-only pieces are dropped, so an
 * all-blank text gives no chunks.
 */
export function chunkText(text: string, maxChars: number): TextChunk[] {
  const limit = Math.max(20, Math.floor(maxChars));
  if (text.trim() === '') return [];
  if (text.length <= limit) return [{ start: 0, text }];
  const chunks: TextChunk[] = [];
  let position = 0;
  while (position < text.length) {
    let end = Math.min(position + limit, text.length);
    if (end < text.length) end = findBreak(text, position, end, limit);
    const piece = text.slice(position, end);
    if (piece.trim() !== '') chunks.push({ start: position, text: piece });
    position = end;
  }
  return chunks;
}

/** A break position in `(position, limit]`, preferring late sentence ends, then clauses, then spaces. */
function findBreak(text: string, position: number, limit: number, maxChars: number): number {
  const floor = position + Math.floor(maxChars / 3);
  const tests: readonly ((before: string, after: string) => boolean)[] = [
    (before, after) => SENTENCE_END.test(before) && /\s/u.test(after),
    (before, after) => CLAUSE_END.test(before) && /\s/u.test(after),
    (before, after) => /\s$/u.test(before) || /^\s/u.test(after),
  ];
  for (const lowest of [floor, position + 1]) {
    for (const test of tests) {
      for (let i = limit; i >= lowest; i -= 1) {
        const before = text.slice(Math.max(position, i - 8), i);
        if (test(before, text.charAt(i))) return i;
      }
    }
  }
  // Hard cut, not between the halves of a surrogate pair.
  const high = text.charCodeAt(limit - 1);
  return high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
}

/** Length of the word starting at `index` (for providers that report no `charLength`). */
export function wordLengthAt(text: string, index: number): number {
  const match = /^[\p{L}\p{M}\p{N}'’-]+/u.exec(text.slice(index));
  return match ? match[0].length : Math.min(1, Math.max(0, text.length - index));
}
