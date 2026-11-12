import { test, expect } from '@playwright/test';

/**
 * Route smoke tests with console-error and failed-request monitoring.
 * Any console error or 4xx/5xx request fails the test.
 */
test.describe('smoke: routing & health', () => {
  let consoleErrors: string[];
  let failedRequests: string[];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    failedRequests = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
    });
  });

  test('home page renders hero and features', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('hero-title')).toContainText('Everything you need');
    await expect(page.getByTestId('feature-grid')).toBeVisible();
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    expect(failedRequests, failedRequests.join('\n')).toEqual([]);
  });

  test('catalog renders products and search filters them', async ({ page }) => {
    await page.goto('/catalog');
    await expect(page.getByTestId('catalog-count')).toHaveText(/^[2-9]\d* items$/);
    await page.getByTestId('catalog-search').fill('mug');
    await expect(page.getByTestId('catalog-count')).toHaveText('1 item');
    await expect(page.getByTestId('product-p-003')).toBeVisible();
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    expect(failedRequests, failedRequests.join('\n')).toEqual([]);
  });

  test('unknown route shows 404 page', async ({ page }) => {
    await page.goto('/definitely-missing');
    await expect(page.getByTestId('notfound-page')).toBeVisible();
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    // TESTS-1a: align with the file header — this assertion pair promises failed-request
    // monitoring too (any 4xx/5xx or aborted request fails the test).
    expect(failedRequests, failedRequests.join('\n')).toEqual([]);
  });

  test('legacy redirect /home-legacy goes home', async ({ page }) => {
    await page.goto('/home-legacy');
    await expect(page.getByTestId('hero-title')).toBeVisible();
    // TESTS-1b: the redirect must actually land on "/" — assert the final URL.
    await expect(page).toHaveURL(/\/$/);
  });
});
