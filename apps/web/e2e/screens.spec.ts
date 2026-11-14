import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import {
  centreOf,
  dwellType,
  dwellUntil,
  expect,
  installFakeSpeech,
  key,
  keyboard,
  message,
  openApp,
  rest,
  test,
} from './fixtures';

/**
 * Screenshots of the main screens at the sizes the app is built for, and the
 * smallest target of every layout. Screenshots go to the test output folder;
 * with `FORSEE_SCREENSHOTS=1` they replace the committed ones in
 * `apps/web/docs/`.
 */
const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
  { width: 1180, height: 820 }, // iPad Air landscape
  { width: 820, height: 1180 }, // iPad Air portrait
];

function shotPath(name: string, outputPath: (name: string) => string): string {
  return process.env.FORSEE_SCREENSHOTS === '1' ? path.join(DOCS, name) : outputPath(name);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Settings/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function chooseLayout(page: Page, name: string): Promise<void> {
  const sheet = await openSettings(page);
  await sheet.getByRole('button', { name }).click();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
}

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`at ${size}`, () => {
    test.use({ viewport });

    test('main screen, settings, coarse layout, pause', async ({ page }, testInfo) => {
      await installFakeSpeech(page);
      await openApp(page);
      // Mid-dwell, with text and predictions.
      await page.keyboard.type('I would like a cup of te');
      await expect(message(page)).toHaveText('I would like a cup of te');
      await expect(
        page.getByRole('group', { name: 'Word predictions' }).getByRole('button').first(),
      ).toBeVisible();
      const target = key(page, 'a');
      const { x, y } = await centreOf(target);
      await page.mouse.move(x, y, { steps: 3 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: shotPath(`main-${size}.png`, (n) => testInfo.outputPath(n)) });
      await rest(page);

      // Everything fits: no scrolling, the keyboard keeps most of the height.
      const fits = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        scrollH: document.documentElement.scrollHeight,
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(fits.scrollW).toBeLessThanOrEqual(fits.width);
      expect(fits.scrollH).toBeLessThanOrEqual(fits.height);
      const board = await keyboard(page).boundingBox();
      expect(board?.height ?? 0).toBeGreaterThanOrEqual(0.55 * viewport.height);

      const sheet = await openSettings(page);
      await page.screenshot({
        path: shotPath(`settings-${size}.png`, (n) => testInfo.outputPath(n)),
      });
      await sheet.getByRole('button', { name: 'Close' }).click();

      await chooseLayout(page, 'English large groups, en');
      await expect(key(page, 'ABCDE')).toBeVisible();
      // Let the selection flash of the button that closed the sheet fade.
      await page.waitForTimeout(400);
      await page.screenshot({
        path: shotPath(`coarse-${size}.png`, (n) => testInfo.outputPath(n)),
      });

      await page.getByRole('button', { name: 'Pause gaze' }).click();
      await expect(page.getByRole('dialog', { name: 'Gaze is paused' })).toBeVisible();
      await page.screenshot({ path: shotPath(`pause-${size}.png`, (n) => testInfo.outputPath(n)) });
    });
  });
}

test.describe('notices at 1024x768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('text that could not be spoken (no voices)', async ({ page }, testInfo) => {
    await openApp(page);
    await page.keyboard.type('I would like a cup of tea please, with milk and no sugar');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-notice^="notice/unspoken"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.mouse.move(4, 4);
    await page.screenshot({
      path: shotPath('notice-unspoken-1024x768.png', (n) => testInfo.outputPath(n)),
    });
  });

  test('speech waiting for a first click or tap', async ({ page }, testInfo) => {
    await installFakeSpeech(page, { needsActivation: true });
    await openApp(page);
    // Mouse movement only: no gesture yet.
    await dwellType(page, key(page, 'h'));
    await dwellType(page, key(page, 'i'));
    const prompt = page.getByRole('button', { name: 'Turn on speech' });
    await dwellUntil(page, key(page, 'Speak'), () => prompt.isVisible(), 4000);
    await page.screenshot({
      path: shotPath('prompt-speech-1024x768.png', (n) => testInfo.outputPath(n)),
    });
  });
});

interface Smallest {
  readonly width: number;
  readonly height: number;
}

async function smallestTarget(scope: Locator): Promise<Smallest> {
  const boxes = await scope.getByRole('button').evaluateAll((buttons) =>
    buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { width: r.width, height: r.height };
    }),
  );
  return {
    width: Math.round(Math.min(...boxes.map((b) => b.width))),
    height: Math.round(Math.min(...boxes.map((b) => b.height))),
  };
}

test.describe('target sizes at 1024x768', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('no target under 48 CSS px in the precise layouts, much larger in the coarse one', async ({
    page,
  }) => {
    await installFakeSpeech(page);
    await openApp(page);
    const report: Record<string, Smallest> = {};
    for (const [name, label] of [
      ['QWERTY', 'English QWERTY, en'],
      ['alphabetical', 'English alphabetical, en'],
      ['QWERTZ', 'Deutsch QWERTZ, de-DE'],
    ] as const) {
      await chooseLayout(page, label);
      report[`${name} letters`] = await smallestTarget(keyboard(page));
      await key(page, '?123').click();
      await expect(key(page, '1')).toBeVisible();
      report[`${name} numbers`] = await smallestTarget(keyboard(page));
      await key(page, 'ABC').click();
    }
    // The rest of the screen around the precise keyboard.
    report['quick replies'] = await smallestTarget(
      page.getByRole('navigation', { name: 'Quick replies' }),
    );
    await page.keyboard.type('hel');
    await expect(
      page.getByRole('group', { name: 'Word predictions' }).getByRole('button').first(),
    ).toBeVisible();
    report.predictions = await smallestTarget(
      page.getByRole('group', { name: 'Word predictions' }),
    );
    report['action bar'] = await smallestTarget(
      page.getByRole('complementary', { name: 'Actions' }),
    );

    await chooseLayout(page, 'English large groups, en');
    report['coarse groups'] = await smallestTarget(keyboard(page));
    await key(page, '0-9').click();
    await expect(key(page, '7')).toBeVisible();
    report['coarse group 0-9 opened'] = await smallestTarget(keyboard(page));

    console.log(`Smallest targets at 1024x768 (CSS px):\n${JSON.stringify(report, null, 2)}`);
    await testInfo().attach('smallest-targets.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    for (const [where, smallest] of Object.entries(report)) {
      expect(Math.min(smallest.width, smallest.height), where).toBeGreaterThanOrEqual(48);
    }
    for (const where of ['coarse groups', 'coarse group 0-9 opened']) {
      const smallest = report[where]!;
      expect(Math.min(smallest.width, smallest.height), where).toBeGreaterThanOrEqual(110);
    }
  });
});

function testInfo() {
  return test.info();
}
