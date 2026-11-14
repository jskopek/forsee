import {
  dwell,
  dwellType,
  dwellUntil,
  expect,
  faster,
  hover,
  installFakeSpeech,
  key,
  message,
  openApp,
  rest,
  speakButton,
  spoken,
  spokenTexts,
  test,
} from './fixtures';
import type { Page } from '@playwright/test';

const PLACEHOLDER = 'Look at a letter to start writing';
const EMPTY = new RegExp(`^${PLACEHOLDER}`);

async function expectMessage(page: Page, text: string): Promise<void> {
  await expect(message(page)).toHaveText(text === '' ? EMPTY : text);
}

test.describe('with speech', () => {
  test.beforeEach(async ({ page }) => {
    await installFakeSpeech(page);
  });

  test('dwell typing with a real mouse, a prediction, then Speak', async ({ page }) => {
    await openApp(page);
    const letterMs = await faster(page, 4);
    expect(letterMs).toBe(400);
    // Speak is in the control bar, once.
    await expect(page.getByRole('button', { name: 'Speak', exact: true })).toHaveCount(1);

    // Each letter fires only after resting on it (adaptive dwell: 0.6 to 1.5 times 400 ms).
    expect(await dwellType(page, key(page, 'h'))).toBe('h');
    const tookE = await dwellUntil(
      page,
      key(page, 'e'),
      async () => (await message(page).textContent()) === 'he',
      3000,
    );
    expect(tookE).toBeGreaterThanOrEqual(0.6 * 400 - 50);
    expect(await dwellType(page, key(page, 'l'))).toBe('hel');

    // A completion appears; dwelling on it accepts it (prediction dwell is 500 ms now).
    const strip = page.getByRole('group', { name: 'Word predictions' });
    const first = strip.getByRole('button').first();
    await expect(first).toBeVisible();
    const word = (await first.textContent())?.trim() ?? '';
    expect(word.toLowerCase().startsWith('hel')).toBe(true);
    expect(await dwellType(page, first)).toBe(`${word} `);

    // Speak is in the control bar and turns into "Stop speaking" while speech plays.
    const stop = page.getByRole('button', { name: 'Stop speaking' });
    await expect(stop).toHaveCount(0);
    await dwellUntil(page, speakButton(page), () => stop.isVisible(), 3000);
    await expectMessage(page, '');
    expect(await spokenTexts(page)).toContain(word);
    await expect(page.getByRole('button', { name: 'Stop speaking' })).toHaveCount(0);
  });

  test('leaving a key just before the dwell completes types nothing', async ({ page }) => {
    await openApp(page);
    // "." has a fixed dwell (letters are adaptive): 0.8 s by default. Leave after 0.65 s.
    await hover(page, key(page, '.'), 650);
    await rest(page, 1200);
    await expectMessage(page, '');
    // The same key, held long enough, does type.
    await dwell(page, key(page, '.'), 800);
    await expectMessage(page, '.');
  });

  test('quick-fire: dwelling on "Yes" speaks at once and leaves the message alone', async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.type('abc');
    await expectMessage(page, 'abc');
    const replies = page.getByRole('navigation', { name: 'Quick replies' });
    await expect(replies.getByRole('button')).toHaveText([
      'Yes',
      'No',
      'Thank you',
      'Please wait',
      'Not finished',
      'Repeat that?',
      'Help',
    ]);
    await dwell(page, replies.getByRole('button', { name: 'Yes' }), 1000);
    await expect.poll(() => spokenTexts(page)).toEqual(['Yes']);
    await expectMessage(page, 'abc');
  });

  test('pause: keys do nothing until the wake target is dwelt on', async ({ page }) => {
    await openApp(page);
    await dwell(page, page.getByRole('button', { name: 'Pause gaze' }), 1000);
    const overlay = page.getByRole('dialog', { name: 'Gaze is paused' });
    await expect(overlay).toBeVisible();

    // Where the "q" key is (beside the wake target), under the overlay: nothing is typed.
    const q = await key(page, 'q').boundingBox();
    if (!q) throw new Error('no q key');
    await page.mouse.move(q.x + q.width / 2, q.y + q.height / 2, { steps: 2 });
    await page.waitForTimeout(1500);
    await expectMessage(page, '');

    // The wake dwell is long (2 s) and deliberate.
    const took = await dwellUntil(
      page,
      page.getByRole('button', { name: 'Resume gaze' }),
      async () => (await overlay.count()) === 0,
      5000,
    );
    expect(took).toBeGreaterThanOrEqual(1900);
    await expectMessage(page, '');
    expect(await dwellType(page, key(page, 'q'))).toBe('q');
  });

  test('settings: coarse layout through its two-step groups, voice and rate', async ({ page }) => {
    await openApp(page);
    await faster(page, 3);
    // Open Settings by dwell (function dwell 0.7 s now).
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await dwellUntil(
      page,
      page.getByRole('button', { name: 'Settings', exact: true }),
      () => sheet.isVisible(),
      3000,
    );
    // The keyboard underneath cannot be selected while the sheet is open.
    await expect(page.locator('[data-region="keyboard"]').locator('..')).toHaveAttribute(
      'inert',
      '',
    );

    await sheet.getByRole('button', { name: 'English large groups, en' }).click();
    await expect(sheet.getByRole('button', { name: 'English large groups, en' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await sheet.getByRole('button', { name: 'Voice' }).click();
    await sheet.getByRole('button', { name: 'Fake Serena, en-GB' }).click();
    await sheet.getByRole('button', { name: 'Speaking' }).click();
    await sheet.getByRole('button', { name: 'Faster' }).click();
    await expect(sheet.getByText('1.1×')).toBeVisible();
    await sheet.getByRole('button', { name: 'Voice' }).click();
    await sheet.getByRole('button', { name: 'Test voice' }).click();
    await expect
      .poll(async () => (await spoken(page)).find((u) => u.text === 'This is how I sound.'))
      .toMatchObject({ voice: 'Fake Serena', rate: 1.1 });

    // Close by dwell.
    await dwellUntil(
      page,
      sheet.getByRole('button', { name: 'Close' }),
      async () => (await sheet.count()) === 0,
      3000,
    );

    // The coarse layout: a group, then a letter in it, then back to the groups.
    await expect(
      page.locator('[data-layout-id="forsee.keyboards/en-coarse-groups"]'),
    ).toBeVisible();
    const group = page.getByRole('group', { name: 'Keyboard: ABCDE' });
    await dwellUntil(page, key(page, 'ABCDE'), () => group.isVisible(), 3000);
    expect(await dwellType(page, key(page, 'C'))).toBe('c');
    await expect(key(page, 'ABCDE')).toBeVisible();
  });

  test('restart: the half sentence, what was said and the settings come back', async ({ page }) => {
    await openApp(page);
    await page.keyboard.type('I would li');
    await expectMessage(page, 'I would li');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(key(page, 'h')).toBeVisible();
    await expectMessage(page, 'I would li');

    await page.keyboard.type('ke tea');
    await page.keyboard.press('Enter');
    await expect.poll(() => spokenTexts(page)).toContain('I would like tea');
    await expectMessage(page, '');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(key(page, 'h')).toBeVisible();
    await expectMessage(page, '');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await sheet.getByRole('button', { name: 'Input' }).click();
    await sheet.getByRole('button', { name: 'Click sound' }).click();
    await expect(sheet.getByRole('button', { name: 'Click sound' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await sheet.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(key(page, 'h')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('button', { name: 'Input' })
      .click();
    await expect(page.getByRole('button', { name: 'Click sound' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

test.describe('offline promise', () => {
  test('once loaded, the app makes no network request at all, not even to its own server', async ({
    page,
  }) => {
    await installFakeSpeech(page);
    await openApp(page);
    await page.waitForLoadState('networkidle');
    // The browser itself may fetch the declared tab and home-screen icons
    // again at any time (resource type "other"); that is not the app.
    const icons = new Set(
      await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel="manifest"]'),
        ].map((link) => link.href),
      ),
    );
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'other' && icons.has(request.url())) return;
      requests.push(`${request.resourceType()} ${request.url()}`);
    });
    await page.keyboard.type('hello there');
    // A prediction (accepted by dwell) and a word typed on.
    await dwellType(
      page,
      page.getByRole('group', { name: 'Word predictions' }).getByRole('button').first(),
    );
    await page.keyboard.press('Enter');
    await expect.poll(() => spokenTexts(page)).not.toEqual([]);
    await page
      .getByRole('navigation', { name: 'Quick replies' })
      .getByRole('button', { name: 'No', exact: true })
      .click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    for (const section of ['Voice', 'Speaking', 'Input', 'Problems', 'Keyboard']) {
      await sheet.getByRole('button', { name: section }).click();
    }
    await sheet.getByRole('button', { name: 'English large groups, en' }).click();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Pause gaze' }).click();
    await page.getByRole('button', { name: 'Resume gaze' }).click();
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);
  });
});

test.describe('speech before any click or tap', () => {
  test('is held, a prompt explains it, and one click on the prompt speaks it', async ({ page }) => {
    await installFakeSpeech(page, { needsActivation: true });
    await openApp(page);
    // Only mouse movement so far (dwell is not a user gesture for the browser).
    expect(await dwellType(page, key(page, 'h'))).toBe('h');
    expect(await dwellType(page, key(page, 'i'))).toBe('hi');
    await dwellUntil(
      page,
      speakButton(page),
      async () => ((await message(page).textContent()) ?? '').startsWith(PLACEHOLDER),
      4000,
    );
    const prompt = page.getByRole('button', { name: 'Turn on speech' });
    await expect(prompt).toBeVisible();
    // The prompt takes the quick replies' row (they could not speak either).
    await expect(page.getByRole('navigation', { name: 'Quick replies' })).toHaveCount(0);
    expect(await spokenTexts(page)).toEqual([]);

    await prompt.click();
    await expect.poll(() => spokenTexts(page)).toEqual(['hi']);
    await expect(prompt).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Quick replies' })).toBeVisible();
  });
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('taps type at once (direct selection) and Speak speaks', async ({ page }) => {
    await installFakeSpeech(page);
    await openApp(page);
    for (const letter of ['h', 'i']) {
      const box = await key(page, letter).boundingBox();
      if (!box) throw new Error(letter);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    }
    // No dwell wait: the letters are there straight away.
    await expect(message(page)).toHaveText('hi', { timeout: 300 });
    const speak = await speakButton(page).boundingBox();
    if (!speak) throw new Error('Speak');
    await page.touchscreen.tap(speak.x + speak.width / 2, speak.y + speak.height / 2);
    await expect.poll(() => spokenTexts(page)).toEqual(['hi']);
    await expectMessage(page, '');
  });
});

test.describe('without any speech voice (headless Chromium as it is)', () => {
  test('Speak keeps the text, shows it in a notice, and it can be put back', async ({ page }) => {
    await openApp(page);
    await page.keyboard.type('hello there');
    await page.keyboard.press('Enter');
    const notice = page.locator('[data-notice^="notice/unspoken"]');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText('Could not speak');
    await expect(notice).toContainText('hello there');
    await expectMessage(page, '');
    await notice.getByRole('button', { name: 'Put text back' }).click();
    await expectMessage(page, 'hello there');
    await expect(notice).toHaveCount(0);
  });
});
