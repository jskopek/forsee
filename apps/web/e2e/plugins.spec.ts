import type { Locator, Page } from '@playwright/test';
import { expect, installFakeSpeech, openApp, test } from './fixtures';

async function openPlugins(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Plugins' }).click();
  await expect(sheet.getByText('Core plugins', { exact: true })).toBeVisible();
  return sheet;
}

async function close(page: Page, sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
}

const quickReplies = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Quick replies' });

test.beforeEach(async ({ page }) => {
  await installFakeSpeech(page);
});

test('core plugins: turn one off and on, change its options, and they survive a reload', async ({
  page,
}) => {
  await openApp(page);
  await expect(quickReplies(page).getByRole('button', { name: 'Help' })).toBeVisible();

  // Quick-fire replies off: the replies leave the main screen.
  let sheet = await openPlugins(page);
  // The standard keyboards cannot be turned off.
  const keyboards = sheet.getByRole('button', { name: 'Standard keyboards', exact: true });
  await expect(keyboards).toHaveAttribute('aria-disabled', 'true');
  await expect(keyboards).toContainText('Always on');
  const quickfire = sheet.getByRole('button', { name: 'Quick-fire replies', exact: true });
  await expect(quickfire).toHaveAttribute('aria-pressed', 'true');
  await quickfire.click();
  await expect(quickfire).toHaveAttribute('aria-pressed', 'false');
  // Its options are offered only while it is on.
  await expect(sheet.getByRole('button', { name: 'Quick-fire replies options' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await close(page, sheet);
  await expect(quickReplies(page)).toHaveCount(0);

  // Back on, and "Help" hidden in its options.
  sheet = await openPlugins(page);
  await sheet.getByRole('button', { name: 'Quick-fire replies', exact: true }).click();
  const options = sheet.getByRole('button', { name: 'Quick-fire replies options' });
  await expect(options).not.toHaveAttribute('aria-disabled', 'true');
  await options.click();
  const help = sheet.getByRole('button', { name: 'Help', exact: true });
  await expect(help).toHaveAttribute('aria-pressed', 'true');
  await help.click();
  await expect(help).toHaveAttribute('aria-pressed', 'false');
  await sheet.getByRole('button', { name: 'Back to plugins' }).click();
  await close(page, sheet);
  await expect(quickReplies(page).getByRole('button', { name: 'Yes' })).toBeVisible();
  await expect(quickReplies(page).getByRole('button', { name: 'Help' })).toHaveCount(0);

  // Word prediction off: no predictions while typing.
  sheet = await openPlugins(page);
  await sheet.getByRole('button', { name: 'Word prediction', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Word prediction', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await close(page, sheet);
  await page.keyboard.type('hel');
  await page.waitForTimeout(300);
  await expect(
    page.getByRole('group', { name: 'Word predictions' }).getByRole('button', { name: /^hel/ }),
  ).toHaveCount(0);

  // Everything comes back the same after a reload.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(quickReplies(page).getByRole('button', { name: 'Yes' })).toBeVisible();
  await expect(quickReplies(page).getByRole('button', { name: 'Help' })).toHaveCount(0);
  sheet = await openPlugins(page);
  await expect(sheet.getByRole('button', { name: 'Word prediction', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(
    sheet.getByRole('button', { name: 'Quick-fire replies', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('keyboards: hidden in the plugin options, they leave the keyboard list', async ({ page }) => {
  await openApp(page);
  const sheet = await openPlugins(page);
  await sheet.getByRole('button', { name: 'Standard keyboards options' }).click();
  await sheet.getByRole('button', { name: 'Deutsch QWERTZ', exact: true }).click();
  await sheet.getByRole('button', { name: 'Back to plugins' }).click();
  await sheet.getByRole('button', { name: 'Keyboard', exact: true }).click();
  const list = sheet.getByRole('group', { name: 'Keyboard', exact: true });
  await expect(list.getByRole('button', { name: 'English alphabetical, en' })).toBeVisible();
  await expect(list.getByRole('button', { name: /QWERTZ/ })).toHaveCount(0);

  await list.getByRole('button', { name: 'English alphabetical, en' }).click();
  await close(page, sheet);
  await expect(page.locator('[data-layout-id="forsee.keyboards/en-alphabetical"]')).toBeVisible();
});
