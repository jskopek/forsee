import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { readonly version: string };

/**
 * The public path the app is served from. `/` by default; set `FORSEE_BASE`
 * to serve it from a sub-path, for example `FORSEE_BASE=/forsee/` for a
 * GitHub Pages project site at `https://<owner>.github.io/forsee/`.
 */
function basePath(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '/';
  const trimmed = value.trim();
  const leading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return leading.endsWith('/') ? leading : `${leading}/`;
}

export default defineConfig({
  base: basePath(process.env.FORSEE_BASE),
  plugins: [react()],
  define: {
    __FORSEE_VERSION__: JSON.stringify(packageJson.version),
  },
  build: {
    // The app is one bundle on purpose (it must work offline once loaded);
    // most of it is the built-in word-prediction model.
    chunkSizeWarningLimit: 1200,
  },
  preview: {
    // LAN IP addresses are always allowed. This name is what the end-to-end
    // test uses to open the app the way a tablet on the LAN does (plain
    // HTTP, not a secure context); it resolves only inside that test.
    allowedHosts: ['forsee-lan.test'],
  },
});
