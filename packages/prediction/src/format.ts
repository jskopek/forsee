/**
 * The Forsee language-model file format, version 1 (`.bin`, "FSLM").
 * See `packages/prediction/README.md` for the full description.
 *
 * All integers are little-endian. Every typed array starts on a 4-byte
 * boundary (relative to the start of the file), so a reader can map
 * `Uint16Array`/`Uint32Array` views straight onto the bytes.
 *
 * Header (16 bytes), then a section table, then the sections:
 *
 * | offset | type   | field                                   |
 * | ------ | ------ | --------------------------------------- |
 * | 0      | 4 × u8 | magic `F S L M`                         |
 * | 4      | u16    | format version (1)                      |
 * | 6      | u16    | word n-gram order (1..3)                |
 * | 8      | u32    | section count                           |
 * | 12     | u32    | reserved (0)                            |
 * | 16     | 12 × n | section table: tag (u32), offset, bytes |
 *
 * Unknown section tags are skipped, so later versions can add sections
 * without breaking older readers; a change that older readers cannot skip
 * bumps the format version.
 */

export const MODEL_MAGIC = 'FSLM';
export const MODEL_FORMAT_VERSION = 1;

/** Section tag: 4 ASCII characters packed little-endian into a u32. */
export function sectionTag(name: string): number {
  let tag = 0;
  for (let i = 3; i >= 0; i--) tag = (tag << 8) | (name.charCodeAt(i) & 0xff);
  return tag >>> 0;
}

export const SECTION = {
  /** UTF-8 JSON metadata (`ModelMetadata`). */
  META: sectionTag('META'),
  /** Vocabulary: u32 V, u32[V+1] offsets, UTF-8 bytes of normalised words. */
  VOCAB: sectionTag('VOCB'),
  /** Display forms: u32 M, u32[M] word ids, u32[M+1] offsets, UTF-8 bytes. */
  DISPLAY: sectionTag('DISP'),
  /** Unigrams: f32[256] log10 p codebook, f32[256] log10 backoff codebook, u8[V] p, u8[V] backoff. */
  UNIGRAMS: sectionTag('UNIG'),
  /** Bigrams: u32 B, u32 id width, codebooks, u32[V+1] start, ids[B], u8[B] p, u8[B] backoff. */
  BIGRAMS: sectionTag('BIGR'),
  /** Trigrams: u32 T, u32 id width, codebook, u32[B+1] start, ids[T], u8[T] p. */
  TRIGRAMS: sectionTag('TRIG'),
  /** Character model: see `char-model.ts`. */
  CHARS: sectionTag('CHAR'),
} as const;

/** Word ids of the pseudo words; regular words follow in sorted order. */
export const SOS_ID = 0;
export const EOS_ID = 1;
export const UNK_ID = 2;
export const FIRST_WORD_ID = 3;

/** Largest vocabulary (ids are packed three to a 53-bit key while building). */
export const MAX_VOCABULARY = (1 << 17) - FIRST_WORD_ID;

/** Contents of the META section. */
export interface ModelMetadata {
  readonly locale: string;
  readonly description: string;
  /** Kneser–Ney discounts per order, lowest first. */
  readonly discounts: readonly number[];
  readonly wordListWeight: number;
  readonly tokens: number;
  readonly sentences: number;
}
