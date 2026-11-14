import { expect, test } from '@playwright/test';

test('renders the Forsee heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Forsee' })).toBeVisible();
  await expect(page.getByText('@forsee/core')).toBeVisible();
});
