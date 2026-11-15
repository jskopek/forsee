# @forsee/prediction

Two-speed word prediction for Forsee (work package B4): tokeniser, n-gram language model runtime and builder, character model, user-adaptive layer, phrase recall, the `forsee.ngram` provider and the prediction engine that merges every provider. Pure TypeScript: no DOM, no Node, no timers (the engine takes an injected `Clock`).

Contracts are in [`src/contracts.ts`](src/contracts.ts) and `@forsee/plugin-api` (`prediction.ts`).

## Quick start

```ts
import {
  createNgramProvider,
  createPhraseRecall,
  createPredictionEngine,
  createUserModel,
} from '@forsee/prediction';
import { loadEnglishModel } from '@forsee/prediction/english';

const base = loadEnglishModel(); // or loadLanguageModel(bytesOfModelFile)
const user = createUserModel({ clock });
user.load(savedJson); // from lm/user-counts.json, if any
const phrases = createPhraseRecall({ clock }); // feed with phrases.add(text, createdAt) from history
const ngram = createNgramProvider({ base, user, phrases });
kernel.extensions.register('predictionProviders', 'app', ngram);

const engine = createPredictionEngine({
  extensions: kernel.extensions,
  clock,
  context: () => kernel.context.list(),
  access: (c) => permissionManager.predictionAccess(c), // plugin host
});
const session = engine.predict({
  textBefore: state.textBeforeCaret,
  partialWord: state.partialWord,
  partialWordSteps: state.partialWordSteps,
  locale: 'en-GB',
  maxCandidates: 5,
  kinds: ['completions', 'nextWords', 'letters', 'phrases'],
});
show(session.instant);
session.onUpdate(show); // refined answers, already stabilised
session.pin(dwellingOnText); // keep that candidate in its slot
```

## Pieces

| Module             | What it does                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokeniser.ts`     | Word, number and emoji tokens; lower-cased model keys with surface forms kept for display; sentence boundaries; locale seam (`LANGUAGE_RULES`).                                                                                                                                                                             |
| `builder.ts`       | `ModelBuilder`: two streaming passes over text, interpolated Kneser–Ney estimation, pruning, quantisation, file writing. Used by `tools/lm-build`.                                                                                                                                                                          |
| `ngram-model.ts`   | `NgramLanguageModel` / `loadLanguageModel(bytes)`: the runtime (`LanguageModel`).                                                                                                                                                                                                                                           |
| `char-model.ts`    | Character n-gram model (order 5, Witten–Bell) for next-letter probabilities in unknown words.                                                                                                                                                                                                                               |
| `user-model.ts`    | `AdaptiveUserModel`: recency-weighted counts of the user's words, bigrams and trigrams (`UserModel`), JSON persistence, "my words" listing.                                                                                                                                                                                 |
| `phrases.ts`       | `PhraseStore`: phrase recall from the user's utterances (`PhraseRecall`), prefix plus frecency.                                                                                                                                                                                                                             |
| `noisy.ts`         | Noisy-channel decoding of the typed prefix from per-key distributions.                                                                                                                                                                                                                                                      |
| `provider.ts`      | `createNgramProvider`: the `forsee.ngram` `PredictionProvider` combining all of the above.                                                                                                                                                                                                                                  |
| `engine.ts`        | `createPredictionEngine`: request ids, provider calls, merging, refinement, cancellation, timeouts, failure isolation, stabilisation (`stabiliseCandidates`).                                                                                                                                                               |
| `data/en-tatoeba/` | The shipped English model, built from Tatoeba sentences (**CC BY 2.0 FR**, not MIT; see [its README](data/en-tatoeba/README.md)). Embedded as base64 in `src/en-tatoeba/model.generated.ts` and loaded with `loadEnglishModel()` from the separate entry point `@forsee/prediction/english`, so the main entry stays small. |

## Design decisions

**Tokenisation.** Model keys are lower-cased (locale-aware) NFC strings with `’` folded to `'` and Unicode hyphens to `-`. Words keep in-word apostrophes and hyphens; numbers (`3:30`, `1,000`) and emoji (including ZWJ sequences and flags) are single tokens. `.`, `!`, `?`, `…` and line breaks end a sentence, except after known abbreviations (`Dr.`). Commas and other punctuation are dropped without breaking the context. The display form of each word (`I`, `I'm`, `Sarah`) is learned from mid-sentence casing, with a per-language default (English capitalises `I`). Other languages get generic rules; languages without spaces need a `LanguageRules` entry that segments with `Intl.Segmenter`.

**Smoothing: interpolated Kneser–Ney, stored in backoff form.** The builder estimates an interpolated KN model (one discount per order, `D = n1/(n1 + 2 n2)`), then writes it ARPA-style: each stored n-gram keeps its interpolated probability, each context a backoff weight recomputed after pruning so every conditional distribution sums to 1. KN was chosen over stupid backoff because the runtime needs real probabilities: letter probabilities must form a sub-distribution, completions are normalised over the typed prefix, and the base model is linearly interpolated with the user layer. Stupid-backoff scores do not sum to 1. KN's continuation counts also favour words that follow many contexts, which suits next-word prediction. The unigram level can mix in a Zipf prior over a word list.

**Runtime.** Word ids follow the alphabetical order of the keys, so the words starting with a prefix form one id range and every successor list (sorted by id) has a contiguous sub-range for it. Completions are therefore exact top-k searches: trigram successors in range, bigram successors in range, then the best unigrams in range (scanned for small ranges, walked from a probability-sorted list for large ones), all scored with the full backoff formula. The probability mass of a prefix range is computed in closed form from unigram prefix sums plus the in-range successors, which gives letter distributions: the range is split by next grapheme and each part's mass divided by the whole. The character model (weight 0.1, or 1 when no known word has the prefix) covers unknown words.

**User layer.** Counts of the user's words, bigrams and trigrams, each stamped with the time of last update and decayed with a half-life (default 30 days) relative to the injected clock's wall time. Sums of decayed counts are kept incrementally (everything decays at the same rate). Estimation is Witten–Bell interpolation. The provider mixes `P = (1 − λ) P_base + λ P_user` with `λ = 0.6 · m / (m + 5)`, where `m` is the user's decayed token count, so an empty user layer changes nothing and an empty base model leaves the user layer in charge. Phrase tiles and re-speaks count less than composed text (0.25 and 0.5). Learned words are listed by `entries()`; `forget` removes words from every n-gram (and from phrase recall). Size is capped (20 000 words, 60 000 bigrams and trigrams), dropping the least recent and least used first.

**Uncertain input.** When `partialWordSteps` carry key distributions, every step's alternatives (keys with a `text`) are combined into a beam of at most 8 prefixes, each weighted by the product of its key probabilities; the literal prefix is always kept. A candidate's score is `Σ π(prefix) · P(word | context)` over the prefixes it extends, divided by the total probability of all prefixes, i.e. the posterior that it is the intended word. Letter probabilities are averaged over prefixes by the same posterior.

**Engine.** See the comment at the top of [`src/engine.ts`](src/engine.ts) for the merging rule. Providers that throw, reject, answer with a stale `requestId` or time out (async `predict` 250 ms, `refine` 1000 ms) are left out and reported through the `ErrorReporter`; typing never waits. Requests carry `conversation` and `context` only for providers that the `access` hook allows (default: owner `"app"` only), and `learn`/`forget` go only to providers allowed to learn.

## Model file format (version 1)

A little-endian binary file, loadable from a `Uint8Array` with no parsing library (the metadata section is JSON, read with `JSON.parse`). Typed arrays start on 4-byte boundaries so they map as views without copying.

```
header      "FSLM"  u16 version=1  u16 order  u32 sectionCount  u32 reserved
table       sectionCount × (u32 tag, u32 offset, u32 byteLength)
META        UTF-8 JSON: locale, description, KN discounts, word-list weight, token and sentence counts
VOCB        u32 V; u32[V+1] offsets; UTF-8 bytes of the normalised words.
            Ids 0, 1, 2 are <s>, </s>, <unk>; ids 3.. are the words in sorted (UTF-16) order
DISP        u32 M; u32[M] word ids; u32[M+1] offsets; UTF-8 display forms (only where they differ)
UNIG        f32[256] log10 p codebook; f32[256] log10 backoff codebook; u8[V] p; u8[V] backoff
BIGR        u32 B; u32 idWidth (2|4); f32[256] p codebook; f32[256] backoff codebook;
            u32[V+1] start (successors of word v are entries start[v]..start[v+1], sorted by id);
            id[B] next word; u8[B] p; u8[B] backoff (of the bigram as a trigram context)
TRIG        u32 T; u32 idWidth; f32[256] p codebook; u32[B+1] start (indexed by bigram entry);
            id[T] next word; u8[T] p
CHAR        character model (see src/char-model.ts): alphabet, context trie, next-symbol counts
```

Probabilities are quantised to 8 bits with a per-table codebook of 256 log10 values (equal-population bins), which keeps the error small where most values are. Unknown section tags are skipped by readers, so sections can be added without a version bump; anything older readers cannot skip bumps the version. Possible later savings: variable-length successor offsets, a sparse trigram start table, 16-bit unigram quantisation if accuracy needs it.

Build models with `tools/lm-build` (see its README).

## Measurements

The shipped English model's figures (keystroke savings 57% top 3 on 2,000 held-out Tatoeba sentences) are in [`data/en-tatoeba/README.md`](data/en-tatoeba/README.md#measurements).

- `predict` latency on a laptop-class container: English model p50 ≈ 0.05 ms, p95 ≈ 0.6 ms; synthetic 50 000-word model (237k bigrams, 292k trigrams, 3.9 MiB) p50 ≈ 0.05 ms, p95 ≈ 0.22 ms. See `tools/lm-build/src/bench.test.ts`.
