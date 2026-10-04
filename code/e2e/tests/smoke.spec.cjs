'use strict';

const { test, expect } = require('@playwright/test');

test('projects hub heading renders', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Active local projects/i })).toBeVisible();
});
