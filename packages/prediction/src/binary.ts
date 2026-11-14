/**
 * Little-endian binary writing and reading for the model file format, plus
 * the 8-bit quantiser used for log-probabilities and a base64 decoder.
 * Pure ES2022.
 */

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Growable little-endian byte writer. */
export class ByteWriter {
  private buffer = new Uint8Array(1024);
  private view = new DataView(this.buffer.buffer);
  private length = 0;

  get position(): number {
    return this.length;
  }

  private ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  f32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  /** Pads with zero bytes to a multiple of 4. */
  align4(): void {
    while (this.length % 4 !== 0) this.u8(0);
  }

  /** Overwrites a u32 written earlier. */
  patchU32(offset: number, value: number): void {
    this.view.setUint32(offset, value, true);
  }

  u16Array(values: Iterable<number>): void {
    this.align4();
    for (const v of values) this.u16(v);
  }

  u32Array(values: Iterable<number>): void {
    this.align4();
    for (const v of values) this.u32(v);
  }

  f32Array(values: Iterable<number>): void {
    this.align4();
    for (const v of values) this.f32(v);
  }

  u8Array(values: Iterable<number>): void {
    for (const v of values) this.u8(v);
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Error thrown for malformed model files. */
export class ModelFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelFormatError';
  }
}

/**
 * Little-endian reader. Typed arrays are zero-copy views when the data is
 * aligned and the host is little-endian, copies otherwise.
 */
export class ByteReader {
  private readonly view: DataView;
  pos: number;

  constructor(
    private readonly data: Uint8Array,
    start = 0,
    private readonly end = data.length,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = start;
  }

  /** Bytes left before the end of this reader's range. */
  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new ModelFormatError('Unexpected end of model data');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  align4(): void {
    while (this.pos % 4 !== 0) this.pos++;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8Array(n: number): Uint8Array {
    return this.bytes(n);
  }

  u16Array(n: number): Uint16Array {
    this.align4();
    this.need(n * 2);
    const abs = this.data.byteOffset + this.pos;
    let out: Uint16Array;
    if (LITTLE_ENDIAN_HOST && abs % 2 === 0) {
      out = new Uint16Array(this.data.buffer, abs, n);
    } else {
      out = new Uint16Array(n);
      for (let i = 0; i < n; i++) out[i] = this.view.getUint16(this.pos + i * 2, true);
    }
    this.pos += n * 2;
    return out;
  }

  u32Array(n: number): Uint32Array {
    this.align4();
    this.need(n * 4);
    const abs = this.data.byteOffset + this.pos;
    let out: Uint32Array;
    if (LITTLE_ENDIAN_HOST && abs % 4 === 0) {
      out = new Uint32Array(this.data.buffer, abs, n);
    } else {
      out = new Uint32Array(n);
      for (let i = 0; i < n; i++) out[i] = this.view.getUint32(this.pos + i * 4, true);
    }
    this.pos += n * 4;
    return out;
  }

  f32Array(n: number): Float32Array {
    this.align4();
    this.need(n * 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getFloat32(this.pos + i * 4, true);
    this.pos += n * 4;
    return out;
  }
}

// ------------------------------------------------------------------ quantisation

/** Number of levels of the 8-bit quantiser. */
export const QUANT_LEVELS = 256;

/**
 * Builds a sorted codebook of at most 256 centroids for `values` by
 * equal-population binning (each centroid is the mean of one bucket of the
 * sorted values). Deterministic.
 */
export function buildCodebook(values: ArrayLike<number>): Float32Array {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  const book = new Float32Array(QUANT_LEVELS);
  if (n === 0) return book;
  for (let k = 0; k < QUANT_LEVELS; k++) {
    const lo = Math.floor((k * n) / QUANT_LEVELS);
    const hi = Math.max(lo + 1, Math.floor(((k + 1) * n) / QUANT_LEVELS));
    let sum = 0;
    const end = Math.min(hi, n);
    const start = Math.min(lo, n - 1);
    for (let i = start; i < end; i++) sum += sorted[i] ?? 0;
    book[k] = sum / Math.max(1, end - start);
  }
  // Float32 rounding can break monotonicity only by equal neighbours; enforce it.
  for (let k = 1; k < QUANT_LEVELS; k++) {
    if ((book[k] ?? 0) < (book[k - 1] ?? 0)) book[k] = book[k - 1] ?? 0;
  }
  return book;
}

/** Index of the codebook entry nearest to `value`. */
export function quantise(book: Float32Array, value: number): number {
  let lo = 0;
  let hi = book.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((book[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs((book[lo - 1] ?? 0) - value) <= Math.abs((book[lo] ?? 0) - value)) {
    // Prefer the lowest index among ties so output is deterministic.
    let k = lo - 1;
    while (k > 0 && book[k - 1] === book[k]) k--;
    return k;
  }
  return lo;
}

// ------------------------------------------------------------------ base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** Decodes standard base64 (padding optional, whitespace ignored). */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? (B64_INDEX[code] ?? -1) : -1;
    if (v < 0) throw new ModelFormatError('Invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Encodes bytes as standard base64 with padding. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += c === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}
