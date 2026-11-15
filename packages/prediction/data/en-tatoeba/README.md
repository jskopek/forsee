# English model (Tatoeba)

The English word-prediction model the app ships, and the sentences held back to test it. The model itself is embedded in the app bundle as base64 in [`../../src/en-tatoeba/model.generated.ts`](../../src/en-tatoeba/model.generated.ts), loaded with `loadEnglishModel()` from `@forsee/prediction/english`; the Word prediction plugin uses it by default.

## Licence and credit

**The model and these files are not under the project's MIT licence.** They are derived from the English sentences of [Tatoeba](https://tatoeba.org), a collection of sentences written and translated by its contributors, and are released under the same licence: [Creative Commons Attribution 2.0 France (CC BY 2.0 FR)](https://creativecommons.org/licenses/by/2.0/fr/deed.en).

> Contains sentences from Tatoeba (https://tatoeba.org), licensed under CC BY 2.0 FR. The sentences were de-duplicated and filtered, and the model holds word statistics (n-gram probabilities) computed from them; see "How it was made".

Anything that ships the model must carry that credit. The app shows it in the Word prediction plugin's description (in full under Settings → Plugins → Word prediction → Options).

| File                                      | Contents                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `../../src/en-tatoeba/model.generated.ts` | The model (format: [`../../README.md`](../../README.md#model-file-format-version-1)), 5.9 MB, as 7.9 MB of base64. |
| `heldout.txt`                             | 2,000 Tatoeba sentences that were **not** trained on, for testing the model (unchanged sentences, CC BY 2.0 FR).   |

Tatoeba's audio and its per-user data are not used.

## How it was made

From the export `eng_sentences.tsv.bz2` downloaded on 2026-11-15 (2,041,097 English sentences), by `lm-build tatoeba` ([`tools/lm-build/src/tatoeba.ts`](../../../../tools/lm-build/src/tatoeba.ts)):

1. **De-duplicated** on a loose key (lower case, punctuation other than apostrophes removed): 2,033,607 distinct sentences.
2. **Split**: sentences ordered by a hash of that key; the first 2,000 are `heldout.txt`, the rest are training text.
3. **Stock names down-weighted.** Tatoeba's contributors reuse a few names (Tom, Mary, Sami, Layla, Rima, Skura, Ziri, Yanni, Mennad, Baya); Tom alone is in about one sentence in six. Only one training sentence in ten that names one of them is kept (591,480 left out), so "Tom" is not a top suggestion at the start of every sentence. 1,440,127 sentences (11.2 million words) remain.
4. **Built** as a Kneser–Ney trigram model: 30,000-word vocabulary, bigrams and trigrams seen fewer than 3 times pruned (339,227 bigrams, 559,788 trigrams), and the seed word list ([`../seed/vocabulary.txt`](../seed/vocabulary.txt), MIT) as the unigram prior.

To rebuild (the output is deterministic for a given export; Tatoeba updates its exports every week, so a new download gives a slightly different model):

```sh
curl -O https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2
bunzip2 eng_sentences.tsv.bz2
pnpm --filter @forsee/lm-build build
node tools/lm-build/dist/cli.js tatoeba --sentences eng_sentences.tsv --bin model.bin   # --bin is optional
node tools/lm-build/dist/cli.js check --model model.bin --text packages/prediction/data/en-tatoeba/heldout.txt
```

## Measurements

Keystroke savings from the `lm-build` self-check: a simulated typist picks the intended word as soon as it is among the top candidates (the app shows four). No user learning.

| Test sentences                                      | Seed model, top 3 / top 4 | This model, top 3 / top 4 |
| --------------------------------------------------- | ------------------------- | ------------------------- |
| `heldout.txt` (2,000 Tatoeba sentences)             | 30.9% / 32.9%             | 56.8% / 59.1%             |
| `../seed/heldout.txt` (40 conversational sentences) | 67.8% / 69.2%             | 59.7% / 61.9%             |

Each test set favours the model trained on text like it: the seed held-out sentences were written by the same author as the seed corpus, in the same style, and are only 280 words. `predict` p95 is about 0.7 ms (seed: 0.3 ms); decoding and loading it takes under 0.1 s on a laptop-class container, once at startup.

For example, after "Trevor ate a ba" the seed model suggested _bad, bath, bank, back_; this model suggests _banana, bad, baby, bag_.

**Known limits.** A trigram model sees only the last two words: "Could you turn on the" is predicted from "on the" (_table, floor_) and "turn" is lost. Tatoeba is example sentences for language learners, not conversation, so everyday care vocabulary (the seed corpus's domain) is thinner than it should be, and some topics are over-represented (Boston, Australia, Algeria, Berber).
