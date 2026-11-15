# @forsee/lm-build

Builds Forsee language-model files (format described in [`packages/prediction/README.md`](../../packages/prediction/README.md)) from plain text. The estimation code lives in `@forsee/prediction` (`ModelBuilder`); this package is a thin Node wrapper that streams files and writes the result.

```sh
pnpm --filter @forsee/lm-build build          # bundles dist/cli.js (also part of `pnpm build`)
node tools/lm-build/dist/cli.js --input corpus/ --out model.bin --stats
node tools/lm-build/dist/cli.js --input a.txt --input b.txt --out model.bin \
  --max-vocab 50000 --min-count 2 --min-ngram-count 2 --order 3 --word-list words.txt
node tools/lm-build/dist/cli.js check --model model.bin --text heldout.txt   # keystroke savings + latency
pnpm --filter @forsee/lm-build seed           # rebuild the seed model from packages/prediction/data/seed
node tools/lm-build/dist/cli.js tatoeba --sentences eng_sentences.tsv   # rebuild the shipped English model (embedded module)
```

- Inputs are files or directories (all `*.txt`, recursively, in sorted order). Each line is tokenised separately, and a line break ends a sentence.
- The input is read twice (vocabulary pass, then n-gram pass), streaming, so memory grows with the number of distinct n-grams rather than the size of the text.
- Output is deterministic: the same inputs and options give the same bytes.
- `--stats` prints vocabulary size, n-gram counts, discounts and file size.

Only build shipped models from text whose licence allows redistribution (see `docs/V1_PLAN.md`, section 7, "Data"). The shipped English model, its licence (CC BY 2.0 FR) and how `tatoeba` prepares the text are described in [`packages/prediction/data/en-tatoeba/README.md`](../../packages/prediction/data/en-tatoeba/README.md).
