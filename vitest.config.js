import { defineConfig } from 'vitest/config';

// One config for the whole workspace. Workspace packages resolve through their
// `exports` field, which points at `src/index.ts`, so no build step is needed.
// DOM-dependent tests can opt in per file with `// @vitest-environment jsdom`
// once a package adds jsdom as a devDependency.
export default defineConfig({
  test: {
    include: ['{apps,packages,plugins,tools,sidecars}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
