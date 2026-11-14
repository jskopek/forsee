import type { LocaleTag } from '@forsee/plugin-api';
import type { Tokeniser } from './contracts';

/**
 * Tokeniser for conversational text.
 *
 * Policy (English, and the generic fallback):
 * - **Words** are runs of letters, combining marks and digits, joined by a
 *   single in-word apostrophe or hyphen (`don't`, `well-known`). Leading and
 *   trailing apostrophes are dropped (`'cause` → `cause`). Curly apostrophes
 *   and Unicode hyphens are folded to `'` and `-`.
 * - **Case**: model keys are lower-cased with the locale's rules
 *   (`normalise`). The surface form is kept on each `Token`, so model
 *   builders can learn display forms such as `I`, `I'm` or `Monday`.
 * - **Numbers** (`42`, `3.5`, `1,000`, `3:30`) are single tokens of kind
 *   `number`; a digit run followed by letters (`2nd`) is a word.
 * - **Emoji** (including ZWJ sequences, skin tones and flags) are single
 *   tokens of kind `emoji`, normalised without variation selectors.
 * - **Sentence boundaries** are `.`, `!`, `?`, `…` and line breaks, except a
 *   `.` after a known abbreviation (`Mr.`, `Dr.`). Other punctuation
 *   (commas, quotes, brackets) is dropped and does not break the context.
 *
 * Locale seam: `createTokeniser(locale)` looks up `LanguageRules` by the
 * primary language subtag. Only English is implemented; other languages
 * get the generic rules (same word shape, locale-aware lower-casing, no
 * abbreviation list). Languages written without spaces (Chinese, Japanese,
 * Thai) will need a rules object that segments words with
 * `Intl.Segmenter`; register it in `LANGUAGE_RULES`.
 */

/** Sentence-start pseudo word used as model context. */
export const SENTENCE_START = '<s>';
/** Sentence-end pseudo word (predicted by the model, never shown). */
export const SENTENCE_END = '</s>';
/** Out-of-vocabulary pseudo word. */
export const UNKNOWN_WORD = '<unk>';

/** True for the model's pseudo words. */
export function isSpecialWord(word: string): boolean {
  return word === SENTENCE_START || word === SENTENCE_END || word === UNKNOWN_WORD;
}

export type TokenKind = 'word' | 'number' | 'emoji';

/** One token with its position and surface form. */
export interface Token {
  readonly kind: TokenKind;
  /** As written (apostrophes and hyphens folded). */
  readonly surface: string;
  /** Model key (lower-cased, NFC). */
  readonly normal: string;
  /** UTF-16 offsets into the input. */
  readonly start: number;
  readonly end: number;
  /** True for the first token of a sentence. */
  readonly sentenceInitial: boolean;
}

/** Language-specific parts of tokenisation. */
export interface LanguageRules {
  /** Lower-case form used as a model key. */
  lowercase(word: string): string;
  /** Lower-case words (without the dot) after which `.` does not end a sentence. */
  readonly abbreviations: ReadonlySet<string>;
  /**
   * Display form of a normalised word when no casing evidence exists (only
   * sentence-initial uses were seen). English capitalises `I` and its
   * contractions.
   */
  defaultDisplay(normal: string): string;
}

/** The full tokeniser used by the prediction package. */
export interface ForseeTokeniser extends Tokeniser {
  readonly locale: LocaleTag;
  /** All tokens with positions; punctuation is not returned. */
  tokens(text: string): Token[];
  /** Tokens grouped into sentences. */
  sentences(text: string): Token[][];
  /**
   * Model context for predicting the next word after `textBefore` (which
   * must not include the partial word): the normalised words of the current
   * sentence, preceded by `SENTENCE_START` when the sentence start is within
   * the last `maxWords` positions. Example: `"Hello. How are "` → `["how", "are"]`
   * with `maxWords` 2, `["<s>", "how", "are"]` with 3.
   */
  context(textBefore: string, maxWords?: number): string[];
  /** Display form for a normalised word without casing evidence (see `LanguageRules.defaultDisplay`). */
  defaultDisplay(normal: string): string;
}

function makeLowercase(locale: string): (word: string) => string {
  return (word) => {
    try {
      return word.toLocaleLowerCase(locale);
    } catch {
      return word.toLowerCase();
    }
  };
}

const ENGLISH_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'mt',
  'jr',
  'sr',
  'vs',
  'etc',
  'approx',
  'appt',
  'dept',
]);

const ENGLISH_I = /^i(?:'(?:m|d|ll|ve))?$/;

/** Rules by primary language subtag. Add languages here. */
export const LANGUAGE_RULES: Readonly<Record<string, LanguageRules>> = {
  en: {
    lowercase: makeLowercase('en'),
    abbreviations: ENGLISH_ABBREVIATIONS,
    defaultDisplay: (normal) => (ENGLISH_I.test(normal) ? 'I' + normal.slice(1) : normal),
  },
};

function genericRules(language: string): LanguageRules {
  return { lowercase: makeLowercase(language), abbreviations: new Set(), defaultDisplay: (n) => n };
}

/** Primary language subtag, lower case (`"en-GB"` → `"en"`). */
export function primaryLanguage(locale: LocaleTag): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase();
}

const EMOJI_UNIT = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*`;
const TOKEN_RE = new RegExp(
  [
    String.raw`(?<emoji>\p{Regional_Indicator}{2}|${EMOJI_UNIT}(?:\u200D${EMOJI_UNIT})*)`,
    String.raw`(?<number>\p{Nd}+(?:[.,:]\p{Nd}+)*(?![\p{L}\p{M}\p{Nd}]))`,
    String.raw`(?<word>[\p{L}\p{M}\p{N}]+(?:['\u2019\u02BC\-\u2010\u2011][\p{L}\p{M}\p{N}]+)*)`,
    String.raw`(?<boundary>[.!?\u2026\u3002\uFF01\uFF1F]+|\r?\n)`,
  ].join('|'),
  'gu',
);

const APOSTROPHES_RE = /[\u2019\u02BC]/g;
const HYPHENS_RE = /[\u2010\u2011]/g;

function fold(surface: string): string {
  return surface.replace(APOSTROPHES_RE, "'").replace(HYPHENS_RE, '-');
}

class RuleTokeniser implements ForseeTokeniser {
  constructor(
    readonly locale: LocaleTag,
    private readonly rules: LanguageRules,
  ) {}

  normalise(word: string): string {
    if (isSpecialWord(word)) return word;
    return this.rules.lowercase(fold(word).normalize('NFC')).replace(/\uFE0F/g, '');
  }

  defaultDisplay(normal: string): string {
    return this.rules.defaultDisplay(normal);
  }

  words(text: string): string[] {
    return this.tokens(text).map((t) => t.normal);
  }

  tokens(text: string): Token[] {
    return this.sentences(text).flat();
  }

  sentences(text: string): Token[][] {
    return this.scan(text).sentences;
  }

  context(textBefore: string, maxWords = 2): string[] {
    const { sentences, open } = this.scan(textBefore);
    const last = open ? sentences[sentences.length - 1] : undefined;
    const all = [SENTENCE_START, ...(last ?? []).map((t) => t.normal)];
    return all.slice(Math.max(0, all.length - maxWords));
  }

  /** Splits into sentences; `open` is true when the last sentence has no closing boundary yet. */
  private scan(text: string): { sentences: Token[][]; open: boolean } {
    const sentences: Token[][] = [];
    let current: Token[] = [];
    let lastWord: Token | null = null;
    const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags);
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const groups = m.groups ?? {};
      const start = m.index;
      if (groups.boundary !== undefined) {
        const abbreviation =
          groups.boundary === '.' &&
          lastWord !== null &&
          lastWord.end === start &&
          this.rules.abbreviations.has(lastWord.normal);
        if (!abbreviation && current.length > 0) {
          sentences.push(current);
          current = [];
        }
        lastWord = null;
        continue;
      }
      const kind: TokenKind =
        groups.emoji !== undefined ? 'emoji' : groups.number !== undefined ? 'number' : 'word';
      const surface = kind === 'word' ? fold(m[0]) : m[0];
      const normal = kind === 'emoji' ? m[0].replace(/\uFE0F/g, '') : this.normalise(surface);
      const token: Token = {
        kind,
        surface,
        normal,
        start,
        end: start + m[0].length,
        sentenceInitial: current.length === 0,
      };
      current.push(token);
      lastWord = kind === 'word' ? token : null;
    }
    const open = current.length > 0;
    if (open) sentences.push(current);
    return { sentences, open };
  }
}

/** Creates a tokeniser for `locale` (English rules for `en-*`, generic rules otherwise). */
export function createTokeniser(locale: LocaleTag = 'en'): ForseeTokeniser {
  const language = primaryLanguage(locale);
  return new RuleTokeniser(locale, LANGUAGE_RULES[language] ?? genericRules(language || 'en'));
}
