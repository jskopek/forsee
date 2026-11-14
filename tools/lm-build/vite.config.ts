import { defineConfig } from 'vite';

// Bundles the CLI (and the workspace TypeScript it imports) into one Node ES module.
export default defineConfig({
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'cli.js', format: 'es' },
    },
  },
  ssr: {
    noExternal: [/^@forsee\//],
  },
});
