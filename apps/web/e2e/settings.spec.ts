import { expect, openApp, test } from './fixtures';
import type { Page } from '@playwright/test';

async function openAllSettings(page: Page) {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'All settings' }).click();
  return sheet;
}

test.describe('all settings', () => {
  test('a risky change asks to be kept, and Undo restores it', async ({ page }) => {
    const sheet = await openAllSettings(page);
    await sheet.getByRole('button', { name: /^Dwell timing/ }).click();
    const letter = sheet.locator('[data-setting="app.gaze/dwell.letterMs"]');
    await expect(letter.getByRole('status')).toHaveText('800 ms');

    await letter.getByRole('button', { name: 'Shorter' }).click();
    await expect(letter.getByRole('status')).toHaveText('700 ms');
    const keep = sheet.getByRole('alertdialog', { name: 'Keep these settings?' });
    await expect(keep).toBeVisible();
    await keep.getByRole('button', { name: 'Undo these settings' }).click();
    await expect(keep).toHaveCount(0);
    await expect(letter.getByRole('status')).toHaveText('800 ms');

    await letter.getByRole('button', { name: 'Shorter' }).click();
    await keep.getByRole('button', { name: 'Keep these settings' }).click();
    await expect(keep).toHaveCount(0);
    await expect(letter.getByRole('status')).toHaveText('700 ms');

    // Listed under "Changed from default", and back to the default from there.
    await sheet.getByRole('button', { name: 'Back to categories' }).click();
    await sheet.getByRole('button', { name: /^Changed from default, 1 setting/ }).click();
    await expect(letter).toBeVisible();
    await letter.getByRole('button', { name: /^Reset Letter dwell/ }).click();
    await sheet.getByRole('button', { name: 'Keep these settings' }).click();
    await expect(sheet.getByText('Every setting here is at its default.')).toBeVisible();
  });

  test('advanced settings are hidden until asked for; safe changes apply at once', async ({
    page,
  }) => {
    const sheet = await openAllSettings(page);
    await expect(sheet.getByRole('button', { name: /^Targets and tracking/ })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Show advanced' }).click();
    await expect(sheet.getByRole('button', { name: /^Targets and tracking/ })).toBeVisible();

    await sheet.getByRole('button', { name: /^Speech/ }).click();
    const pitch = sheet.locator('[data-setting="app.speech/pitch"]');
    await pitch.getByRole('button', { name: 'More' }).click();
    await expect(pitch.getByRole('status')).toHaveText('1.1');
    await expect(sheet.getByRole('alertdialog')).toHaveCount(0);
  });
});
