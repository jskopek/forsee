/** Small string helpers shared by the models. */

const MARK_RE = /^(?:\p{M}|\u200D|\uFE0F)$/u;

/**
 * The grapheme of `word` starting at UTF-16 offset `offset`: one code point
 * plus any following combining marks, joiners and variation selectors. Good
 * enough for alphabetic scripts; full UAX #29 clustering is not needed for
 * word keys.
 */
export function nextGrapheme(word: string, offset: number): string {
  const first = word.codePointAt(offset);
  if (first === undefined) return '';
  let end = offset + (first > 0xffff ? 2 : 1);
  for (;;) {
    const cp = word.codePointAt(end);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    if (!MARK_RE.test(ch)) break;
    end += ch.length;
  }
  return word.slice(offset, end);
}

/** Upper-cases the first grapheme (`"i'm"` → `"I'm"`). */
export function capitaliseFirst(text: string, locale = 'en'): string {
  const g = nextGrapheme(text, 0);
  if (g === '') return text;
  let upper: string;
  try {
    upper = g.toLocaleUpperCase(locale);
  } catch {
    upper = g.toUpperCase();
  }
  return upper + text.slice(g.length);
}
