/** 14 — coordinates probe: bounding box of [data-testid="price-current"] on /catalog,
 *  measured with the SAME viewport the broker session uses (1440x900). Uses the demo-app's
 *  own playwright install (read-only import of its node_modules). */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_APP } from './lib.mjs';

const { chromium } = await import(pathToFileURL(path.join(DEMO_APP, 'node_modules', 'playwright', 'index.mjs')).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:5173/catalog', { waitUntil: 'networkidle' });
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="price-current"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          resolve({ x: r.x, y: r.y, width: r.width, height: r.height });
        });
      });
    });
  });
  const center = box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
  console.log(JSON.stringify({ box, center }));
} finally {
  await browser.close();
}
