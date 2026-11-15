/**
 * @forsee/lm-build — Node wrapper around the pure model builder in
 * `@forsee/prediction`: input file streaming, the seed model, and a small
 * keystroke-savings self-check. The CLI is `src/cli.ts` (bundled to
 * `dist/cli.js` by `pnpm build`).
 */
export * from './evaluate';
export * from './files';
export * from './seed';
export * from './tatoeba';
