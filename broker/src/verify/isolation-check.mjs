/**
 * Verification helper: proves true per-session cookie/storage isolation through the
 * broker's own session code path (SessionManager creates one BrowserContext per session).
 *
 * Run while the demo dev server answers on 5173:
 *   node src/verify/isolation-check.mjs http://127.0.0.1:5173/
 *
 * Prints JSON: cookie set in session A, shown present in A's context and absent in B's.
 */
import { SessionManager } from '../sessions.mjs';
import { DEFAULTS } from '../config.mjs';

const url = process.argv[2] || 'http://127.0.0.1:5173/';

const mgr = new SessionManager({ ...DEFAULTS, port: 0, blockedOrigins: [], headless: true });
const a = await mgr.createSession({ url, owner: 'verify' });
const b = await mgr.createSession({ url, owner: 'verify' });

try {
  // set a cookie INSIDE session A's page (normal page script, like a login would)
  await a.page.evaluate(() => {
    document.cookie = 'vbw-iso=fromSessionA; path=/';
  });
  const cookiesA = await a.context.cookies(url);
  const cookiesB = await b.context.cookies(url);
  await b.page.reload({ waitUntil: 'load' });
  const cookieInBPage = await b.page.evaluate(() => document.cookie);

  const result = {
    url,
    sessionA: { id: a.id, contextId: a.context.guid ?? undefined, cookies: cookiesA.map((c) => `${c.name}=${c.value}`) },
    sessionB: { id: b.id, contextId: b.context.guid ?? undefined, cookies: cookiesB.map((c) => `${c.name}=${c.value}`) },
    cookieVisibleInSessionBPage: cookieInBPage,
    isolated: cookiesA.some((c) => c.name === 'vbw-iso') && !cookiesB.some((c) => c.name === 'vbw-iso') && !cookieInBPage.includes('vbw-iso'),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.isolated ? 0 : 1;
} finally {
  await mgr.shutdown();
}
