import { test, expect } from '@playwright/test';

/**
 * WCAG contrast check for price text (desktop project only).
 * Fixed 2026-11-12: .price-current now uses var(--ink) (#1e2530) on white — 15.41:1.
 */
function luminance(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function parseRgb(color: string): [number, number, number] {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) throw new Error(`Unparsable color: ${color}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test('price text meets WCAG AA contrast (>= 4.5:1)', async ({ page }) => {
  await page.goto('/catalog');
  const price = page.getByTestId('product-p-001').getByTestId('price-current');
  await expect(price).toBeVisible();
  const fg = parseRgb(await price.evaluate((el) => getComputedStyle(el).color));
  const bg = parseRgb(
    await price.evaluate((el) => {
      let node: Element | null = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (c && !c.startsWith('rgba(0, 0, 0, 0)')) return c;
        node = node.parentElement;
      }
      return 'rgb(255, 255, 255)';
    }),
  );
  const l1 = luminance(...fg);
  const l2 = luminance(...bg);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  expect(
    ratio,
    `contrast ratio ${ratio.toFixed(2)}:1 for color rgb(${fg}) on rgb(${bg})`,
  ).toBeGreaterThanOrEqual(4.5);
});
