/**
 * UTF-8 encoding without `TextEncoder`/`TextDecoder`, which are not part of
 * the ES2022 library that engine packages compile against. Lone surrogates
 * encode as U+FFFD; invalid byte sequences decode as U+FFFD.
 */

/** Encodes a string as UTF-8. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decodes UTF-8 bytes to a string. */
export function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  const n = bytes.length;
  const at = (k: number): number => bytes[k] ?? 0;
  const cont = (k: number): boolean => k < n && (at(k) & 0xc0) === 0x80;
  while (i < n) {
    const b0 = at(i);
    let cp = 0xfffd;
    let len = 1;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc2 && b0 < 0xe0 && cont(i + 1)) {
      cp = ((b0 & 0x1f) << 6) | (at(i + 1) & 0x3f);
      len = 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0 && cont(i + 1) && cont(i + 2)) {
      const v = ((b0 & 0x0f) << 12) | ((at(i + 1) & 0x3f) << 6) | (at(i + 2) & 0x3f);
      if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) {
        cp = v;
        len = 3;
      }
    } else if (b0 >= 0xf0 && b0 < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const v =
        ((b0 & 0x07) << 18) |
        ((at(i + 1) & 0x3f) << 12) |
        ((at(i + 2) & 0x3f) << 6) |
        (at(i + 3) & 0x3f);
      if (v >= 0x10000 && v <= 0x10ffff) {
        cp = v;
        len = 4;
      }
    }
    result += String.fromCodePoint(cp);
    i += len;
  }
  return result;
}
