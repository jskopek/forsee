import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const ENGINE_PACKAGES = [
  'plugin-api',
  'core',
  'gaze',
  'prediction',
  'speech',
  'storage',
  'layouts',
  'inference',
];

const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'location',
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
].map((name) => ({
  name,
  message: 'Engine packages must not touch the DOM or Node. Go through HostBridge instead.',
}));

export default tseslint.config(
  {
    ignores: [
      // legacy code, left untouched
      'keyboard-ui/**',
      'app/**',
      'conversations/**',
      'templates/**',
      // generated
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/desktop/out/**',
      'apps/desktop/release/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Engine packages: no DOM, no Node, no React, no Electron.
    files: ENGINE_PACKAGES.map((p) => `packages/${p}/**/*.{ts,tsx}`),
    rules: {
      'no-restricted-globals': ['error', ...DOM_GLOBALS],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'react', 'react/*', 'react-dom', 'react-dom/*', 'electron'],
              message: 'Engine packages must not import node:*, react or electron.',
            },
            {
              group: ['fs', 'path', 'os', 'child_process', 'crypto', 'url', 'stream', 'http'],
              message: 'Engine packages must not import Node built-ins.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
