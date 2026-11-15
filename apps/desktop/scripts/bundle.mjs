// Bundles the main process (and electron-updater) into one file, so the
// packaged app carries no node_modules and pnpm's layout never matters.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'out/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'info',
});
