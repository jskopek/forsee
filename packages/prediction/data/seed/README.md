# Seed data

Development data for the prediction engine, used until a corpus with a suitable licence is chosen (see `docs/V1_PLAN.md`, section 7, "Data").

All files in this folder are **original to the Forsee project**: they were written for it and are not taken or derived from any external word list, frequency list or corpus (in particular not from SUBTLEX, wordfreq, DailyDialog or the legacy prototype's lists). They are released under the project's **MIT licence**.

| File             | Contents                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vocabulary.txt` | About 2,700 common conversational English words, one per line, in approximate frequency order (most frequent first). Casing marks display forms (`I`, `I'm`). The order is a judgement, not a measurement. |
| `corpus.txt`     | About 950 everyday conversational sentences (greetings, needs, care, feelings, questions, small talk), one per line. Training text for the seed model.                                                     |
| `heldout.txt`    | 40 further sentences in the same style, not in `corpus.txt`, for the keystroke-savings self-check. Never train on them.                                                                                    |
| `seed-model.bin` | The model built from `corpus.txt` and `vocabulary.txt`. Also embedded as base64 in `src/seed/seed-model.generated.ts`, which is what `loadSeedModel()` loads.                                              |

Rebuild the model after editing the text (from the repository root):

```sh
pnpm --filter @forsee/lm-build seed
```

A test in `tools/lm-build` fails if the checked-in model is not what the current text builds.

The model is tiny. Figures measured with it (keystroke savings, latency) say little about a model built from a real corpus.
