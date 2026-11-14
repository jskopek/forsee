import { expect, key, message, openApp, test } from './fixtures';

/**
 * Opening the app from another device on the LAN means plain HTTP on a
 * non-local address: not a secure context. Chromium resolves the made-up
 * name `forsee-lan.test` to this machine, so the page is served exactly as
 * a tablet would get it from `vite preview --host`.
 */
const port = Number(process.env.FORSEE_E2E_PORT ?? 4173);
const lanURL = `http://forsee-lan.test:${port}/`;
const executablePath = process.env.PW_CHROMIUM_PATH;

test.use({
  baseURL: lanURL,
  launchOptions: {
    args: ['--host-resolver-rules=MAP forsee-lan.test 127.0.0.1'],
    ...(executablePath ? { executablePath } : {}),
  },
});

test('over plain HTTP on a LAN address: IndexedDB keeps the profile, speech still exists', async ({
  page,
}) => {
  await openApp(page);
  const environment = await page.evaluate(async () => ({
    secure: window.isSecureContext,
    opfs: typeof navigator.storage?.getDirectory === 'function',
    randomUUID: typeof crypto.randomUUID === 'function',
    speechSynthesis: typeof window.speechSynthesis === 'object' && window.speechSynthesis !== null,
    databases: (await indexedDB.databases()).map((d) => d.name),
  }));
  expect(environment).toEqual({
    secure: false,
    opfs: false,
    randomUUID: false,
    speechSynthesis: true,
    databases: ['forsee-profile'],
  });
  // Storage is persistent (IndexedDB), so there is no "Nothing is being saved" notice ...
  await expect(page.getByText('Nothing is being saved')).toHaveCount(0);
  // ... and the message survives a reload.
  await page.keyboard.type('over the LAN');
  await expect(message(page)).toHaveText('over the LAN');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(key(page, 'h')).toBeVisible();
  await expect(message(page)).toHaveText('over the LAN');
});
