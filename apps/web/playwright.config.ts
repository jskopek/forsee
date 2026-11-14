import { defineConfig } from '@playwright/test';

// In sandboxes with a preinstalled browser, set PW_CHROMIUM_PATH to its executable.
const executablePath = process.env.PW_CHROMIUM_PATH;
// The preview server's port; change it when 4173 is taken by another checkout.
const port = Number(process.env.FORSEE_E2E_PORT ?? 4173);
const baseURL = `http://localhost:${port}/`;

export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  // Dwell tests wait in real time; a few run side by side.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL,
    viewport: { width: 1366, height: 768 },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    // `--host` listens on every address. Without it Vite binds `localhost`, which on some
    // machines (GitHub's runners) is IPv6 only, so the LAN test's 127.0.0.1 is refused.
    command: `pnpm exec vite preview --host --port ${port} --strictPort`,
    url: baseURL,
    // Never test another checkout's server that happens to hold the port.
    reuseExistingServer: false,
  },
});
