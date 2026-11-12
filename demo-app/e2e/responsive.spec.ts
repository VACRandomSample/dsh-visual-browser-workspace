import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Responsive checks. Mobile project (Pixel 7) intentionally catches the
 * nav-bar clipping issue: .nav-bar { overflow: hidden; height: 48px } clips
 * wrapped links on narrow viewports.
 */
async function collectConsole(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test.describe('responsive layout', () => {
  test('mobile: nav links all visible (no clipping)', async ({ page }) => {
    const errors = await collectConsole(page);
    await page.goto('/');
    const bar = page.getByTestId('nav-bar');
    await expect(bar).toBeVisible();
    const links = ['nav-home', 'nav-catalog', 'nav-about'];
    for (const id of links) {
      const link = page.getByTestId(id);
      const box = await link.boundingBox();
      expect(box, `${id} has a bounding box`).not.toBeNull();
      const barBox = await bar.boundingBox();
      expect(
        box!.y + box!.height,
        `${id} bottom must not extend below the nav bar`,
      ).toBeLessThanOrEqual(barBox!.y + barBox!.height + 1);
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('mobile: Add button has at least a 24x24px tap target', async ({ page }) => {
    await page.goto('/catalog');
    const add = page.getByTestId('product-add-p-001');
    await expect(add).toBeVisible();
    const box = await add.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });
});
