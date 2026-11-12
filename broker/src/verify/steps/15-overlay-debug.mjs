/** 15 — debug/verify the overlay page-side function in isolation (uses demo-app playwright). */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_APP } from './lib.mjs';
import { highlight } from '../../overlay.mjs';
import { INIT_PAGE_SCRIPT } from '../../safe-dom.mjs';

const { chromium } = await import(pathToFileURL(path.join(DEMO_APP, 'node_modules', 'playwright', 'index.mjs')).href);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(INIT_PAGE_SCRIPT);
  await page.goto('http://127.0.0.1:5173/catalog', { waitUntil: 'networkidle' });
  const fakeSession = { page };
  const resolveVid = () => null; // no broker registry here; use boxes
  const r1 = await highlight(fakeSession, { boxes: [{ x: 40, y: 40, width: 220, height: 60 }], style: 'hit', label: 'region' }, resolveVid);
  console.log('highlight box result:', JSON.stringify(r1));
  const r2 = await highlight(fakeSession, { clear: true }, resolveVid);
  console.log('highlight clear result:', JSON.stringify(r2));
  // element-targeted highlight via a vid minted by the page registry itself
  const vid = await page.evaluate(() => window.__vbw.vidFor(document.querySelector('[data-testid="price-current"]')));
  console.log('minted vid:', vid);
  const r3 = await highlight(fakeSession, { refs: ['span-price-current'], style: 'held' }, (ref) => (ref === 'span-price-current' ? vid : null));
  console.log('highlight ref result:', JSON.stringify(r3));
  const r4 = await highlight(fakeSession, {}, resolveVid).catch((e) => `threw: ${e.message}`);
  console.log('r4 (no targets -> expect 400 NO_TARGETS):', r4);
  const r5 = await highlight(fakeSession, { clear: true }, resolveVid);
  console.log('highlight clear result:', JSON.stringify(r5));
} finally {
  await browser.close();
}
