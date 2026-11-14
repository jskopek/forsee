import { type ByteReader, type ByteWriter } from './binary';

/**
 * Character n-gram model (default order 5: four characters of context) for
 * next-letter probabilities inside words the word model does not know.
 *
 * Written for this project from the textbook definitions: counts of the
 * next symbol after each context of up to `order - 1` symbols, smoothed by
 * Witten–Bell interpolation down to a uniform distribution. Words are framed
 * as `BOW c1 … cn EOW`.
 *
 * Storage (section `CHAR`): u32 order; u32 A (alphabet size, symbol 0 is
 * BOW and 1 is EOW); u32[A] code points; u32 K (context nodes); u32[K+1]
 * child start; u32 E; u16[E] child symbol; u32[K+1] next start; u32 F;
 * u32 count width (2 or 4); u16[F] next symbol; u16 or u32 [F] next count.
 * Context nodes form a trie read backwards (the child of the node for
 * context `x` via symbol `y` is the node for `yx`), numbered breadth-first
 * from the empty context (node 0), so the child at edge index `e` is node
 * `e + 1`. Children and next lists are sorted by symbol.
 */

export const BOW_SYMBOL = 0;
export const EOW_SYMBOL = 1;

interface BuildNode {
  readonly children: Map<number, BuildNode>;
  readonly next: Map<number, number>;
  total: number;
}

function newNode(): BuildNode {
  return { children: new Map(), next: new Map(), total: 0 };
}

export interface CharModelStats {
  readonly alphabet: number;
  readonly contexts: number;
}

/** Accumulates words and writes the `CHAR` section. */
export class CharModelBuilder {
  private readonly words = new Map<string, number>();

  constructor(
    readonly order = 5,
    readonly minCount = 2,
  ) {
    if (order < 1 || order > 8) throw new RangeError('char order must be 1..8');
  }

  /** Adds a (normalised) word with a weight (rounded, at least 1). */
  addWord(word: string, weight: number): void {
    if (word === '') return;
    this.words.set(word, (this.words.get(word) ?? 0) + Math.max(1, Math.round(weight)));
  }

  write(out: ByteWriter): CharModelStats {
    const cps = new Set<number>();
    const sortedWords = [...this.words.keys()].sort();
    for (const word of sortedWords) for (const ch of word) cps.add(ch.codePointAt(0)!);
    const alphabet = [0, 0, ...[...cps].sort((a, b) => a - b)];
    const symOf = new Map<number, number>();
    alphabet.forEach((cp, i) => {
      if (i >= 2) symOf.set(cp, i);
    });
    const K = this.order - 1;
    const root = newNode();
    for (const word of sortedWords) {
      const weight = this.words.get(word) ?? 1;
      const syms = [BOW_SYMBOL];
      for (const ch of word) syms.push(symOf.get(ch.codePointAt(0)!)!);
      syms.push(EOW_SYMBOL);
      for (let i = 1; i < syms.length; i++) {
        const target = syms[i]!;
        let node = root;
        add(node, target, weight);
        for (let k = 1; k <= K && i - k >= 0; k++) {
          const s = syms[i - k]!;
          let child = node.children.get(s);
          if (!child) {
            child = newNode();
            node.children.set(s, child);
          }
          node = child;
          add(node, target, weight);
        }
      }
    }
    // Breadth-first numbering with pruning of rare long contexts.
    const nodes: BuildNode[] = [root];
    const childLists: [number, BuildNode][][] = [];
    const depth: number[] = [0];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const kept = [...node.children.entries()]
        .filter(([, c]) => (depth[i] ?? 0) + 1 < 2 || c.total >= this.minCount)
        .sort((a, b) => a[0] - b[0]);
      childLists.push(kept);
      for (const [, child] of kept) {
        nodes.push(child);
        depth.push((depth[i] ?? 0) + 1);
      }
    }
    out.u32(this.order);
    out.u32(alphabet.length);
    out.u32Array(alphabet);
    out.u32(nodes.length);
    const ctxStart: number[] = [0];
    const ctxSym: number[] = [];
    for (const list of childLists) {
      for (const [sym] of list) ctxSym.push(sym);
      ctxStart.push(ctxSym.length);
    }
    const nextStart: number[] = [0];
    const nextSym: number[] = [];
    const nextCount: number[] = [];
    for (const node of nodes) {
      for (const [sym, count] of [...node.next.entries()].sort((a, b) => a[0] - b[0])) {
        nextSym.push(sym);
        nextCount.push(count);
      }
      nextStart.push(nextSym.length);
    }
    out.u32Array(ctxStart);
    out.u32(ctxSym.length);
    out.u16Array(ctxSym);
    out.u32Array(nextStart);
    out.u32(nextSym.length);
    const width = nextCount.every((c) => c <= 0xffff) ? 2 : 4;
    out.u32(width);
    out.u16Array(nextSym);
    if (width === 2) out.u16Array(nextCount);
    else out.u32Array(nextCount);
    return { alphabet: alphabet.length, contexts: nodes.length };
  }
}

function add(node: BuildNode, sym: number, weight: number): void {
  node.next.set(sym, (node.next.get(sym) ?? 0) + weight);
  node.total += weight;
}

/** Runtime character model. */
export class CharModel {
  private readonly symOf = new Map<number, number>();
  private readonly totals: Float64Array;

  private constructor(
    readonly order: number,
    private readonly codepoints: Uint32Array,
    private readonly ctxStart: Uint32Array,
    private readonly ctxSym: Uint16Array,
    private readonly nextStart: Uint32Array,
    private readonly nextSym: Uint16Array,
    private readonly nextCount: Uint16Array | Uint32Array,
  ) {
    for (let i = 2; i < codepoints.length; i++) this.symOf.set(codepoints[i]!, i);
    const k = nextStart.length - 1;
    this.totals = new Float64Array(Math.max(0, k));
    for (let n = 0; n < k; n++) {
      let sum = 0;
      for (let j = nextStart[n]!; j < nextStart[n + 1]!; j++) sum += nextCount[j]!;
      this.totals[n] = sum;
    }
  }

  static read(r: ByteReader): CharModel {
    const order = r.u32();
    const a = r.u32();
    const codepoints = r.u32Array(a);
    const k = r.u32();
    const ctxStart = r.u32Array(k + 1);
    const e = r.u32();
    const ctxSym = r.u16Array(e);
    const nextStart = r.u32Array(k + 1);
    const f = r.u32();
    const width = r.u32();
    const nextSym = r.u16Array(f);
    const nextCount = width === 2 ? r.u16Array(f) : r.u32Array(f);
    return new CharModel(order, codepoints, ctxStart, ctxSym, nextStart, nextSym, nextCount);
  }

  get alphabetSize(): number {
    return this.codepoints.length;
  }

  /** The string for a symbol (`""` for BOW/EOW). */
  symbolText(sym: number): string {
    return sym < 2 ? '' : String.fromCodePoint(this.codepoints[sym] ?? 0xfffd);
  }

  /**
   * Distribution over the next symbol after `prefix` (normalised word
   * prefix). Index = symbol; index 0 (BOW) is always 0; index 1 is EOW.
   */
  distribution(prefix: string): Float64Array {
    const ctx: number[] = [BOW_SYMBOL];
    for (const ch of prefix) {
      const sym = this.symOf.get(ch.codePointAt(0)!);
      if (sym === undefined) ctx.length = 0;
      else ctx.push(sym);
    }
    const nodes = [0];
    let node = 0;
    for (let k = 1; k < this.order && k <= ctx.length; k++) {
      const child = this.child(node, ctx[ctx.length - k]!);
      if (child < 0) break;
      node = child;
      nodes.push(node);
    }
    const a = this.codepoints.length;
    const p = new Float64Array(a);
    if (a < 2) return p;
    const uniform = 1 / (a - 1);
    for (let s = 1; s < a; s++) p[s] = uniform;
    for (const n of nodes) {
      if (n >= this.totals.length) continue;
      const total = this.totals[n]!;
      const types = this.nextStart[n + 1]! - this.nextStart[n]!;
      if (total <= 0) continue;
      const keep = types / (total + types);
      for (let s = 1; s < a; s++) p[s] = p[s]! * keep;
      for (let j = this.nextStart[n]!; j < this.nextStart[n + 1]!; j++) {
        const s = this.nextSym[j]!;
        p[s] = p[s]! + this.nextCount[j]! / (total + types);
      }
    }
    return p;
  }

  private child(node: number, sym: number): number {
    let lo = this.ctxStart[node] ?? 0;
    let hi = this.ctxStart[node + 1] ?? 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const s = this.ctxSym[mid]!;
      if (s === sym) return mid + 1;
      if (s < sym) lo = mid + 1;
      else hi = mid;
    }
    return -1;
  }
}
