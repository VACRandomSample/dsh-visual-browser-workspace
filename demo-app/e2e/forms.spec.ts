import { test, expect } from '@playwright/test';

test.describe('contact form', () => {
  test('blocks invalid submission and shows field errors', async ({ page }) => {
    await page.goto('/about');
    await page.getByTestId('contact-name').fill('A');
    await page.getByTestId('contact-email').fill('not-an-email');
    await page.getByTestId('contact-message').fill('short');
    await page.getByTestId('submit-contact').click();
    await expect(page.getByTestId('contact-name-error')).toContainText('at least 2');
    await expect(page.getByTestId('contact-email-error')).toContainText('valid email');
    await expect(page.getByTestId('contact-message-error')).toContainText('at least 10');
    await expect(page.getByTestId('contact-success')).toHaveCount(0);
  });

  test('accepts a valid submission and confirms', async ({ page }) => {
    await page.goto('/about');
    await page.getByTestId('contact-name').fill('Ada Lovelace');
    await page.getByTestId('contact-email').fill('ada@example.com');
    await page.getByTestId('contact-message').fill('Please add support for bulk orders.');
    await page.getByTestId('submit-contact').click();
    await expect(page.getByTestId('contact-success')).toBeVisible();
    await expect(page.getByTestId('contact-name')).toHaveValue('');
  });
});
