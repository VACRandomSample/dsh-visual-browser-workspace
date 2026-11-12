/**
 * Browser session manager: one Playwright Browser (system Chrome via channel), one isolated
 * BrowserContext per session, owner locks, per-session op-lock (mutations exclusive; readers
 * concurrent unless a mutation is in flight -> 409 SESSION_BUSY), idle reaper, graceful
 * shutdown.
 */
import { chromium } from 'playwright';
import { DEFAULTS, log } from './config.mjs';
import { err, notFound, gone, busy } from './errors.mjs';
import { RefBook, INIT_PAGE_SCRIPT } from './safe-dom.mjs';
import { compilePatterns, redactIfMatch } from './perception.mjs';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
// SEC-8: loopback hostnames compared against the NORMALIZED URL hostname (brackets
// stripped, one trailing FQDN dot stripped, IPv4-mapped ::ffff: prefix resolved).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
// HARDEN-1: closed sessions stay listed (spec: status "closed" rows) but are pruned
// from the Map after 1 h.
const CLOSED_SESSION_PRUNE_MS = 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** SEC-8: decode the IPv4 address carried by an IPv4-mapped IPv6 hostname in ANY
 * WHATWG serialization — dotted ("::ffff:127.0.0.1") or compressed hex
 * ("::ffff:7f00:1", the form new URL() actually emits for [::ffff:127.0.0.1]).
 * Returns the dotted quad, or null when `h` is not an IPv4-mapped form. */
function ipv4FromMapped(h) {
  if (!h.startsWith('::ffff:')) return null;
  const tail = h.slice('::ffff:'.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  // hex form: the remaining 1-2 hextets are the last 32 bits (groups 6,7); the
  // "::ffff:" prefix fixes groups 0-5 as 0…0xffff by definition.
  const parts = tail.split(':');
  if (parts.length < 1 || parts.length > 2) return null;
  if (!parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return null;
  const hi = parts.length === 2 ? parseInt(parts[0], 16) : 0;
  const lo = parseInt(parts[parts.length - 1], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** SEC-8: canonical form for hostname comparisons in the URL guard. */
function normalizeHost(hostname) {
  let h = String(hostname).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // bracketed IPv6 literal
  if (h.length > 1 && h.endsWith('.')) h = h.slice(0, -1); // strip ONE trailing dot ("localhost." FQDN form)
  const mapped = ipv4FromMapped(h);
  if (mapped) h = mapped; // IPv4-mapped IPv6 (either serialization) → the IPv4 address
  return h;
}

/**
 * URL allowlist (security invariant 4): http/https only; file:/data:/ftp: refused;
 * credentials-in-URL refused; the broker's own origin and configured origins refused.
 */
export function assertAllowedUrl(raw, { brokerPort, blockedOrigins = [] } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw err(400, 'BAD_URL', 'url must be a non-empty string');
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw err(400, 'BAD_URL', `not a valid absolute URL: ${JSON.stringify(raw.trim().slice(0, 200))}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw err(403, 'URL_SCHEME_FORBIDDEN', `only http: and https: URLs are allowed (got ${u.protocol})`);
  }
  if (u.username || u.password) {
    throw err(403, 'URL_CREDENTIALS_FORBIDDEN', 'URLs with embedded credentials are refused');
  }
  const host = normalizeHost(u.hostname);
  const explicitPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (LOOPBACK_HOSTS.has(host) && explicitPort === brokerPort) {
    throw err(403, 'URL_SELF_REFERENCE', 'navigation to the broker origin is refused');
  }
  // compare blocked origins against BOTH the WHATWG origin and the normalized-host
  // origin so "localhost." (FQDN form) cannot sneak past the blocklist (SEC-8)
  const normOrigin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`;
  if (blockedOrigins.includes(u.origin) || blockedOrigins.includes(normOrigin)) {
    throw err(403, 'URL_BLOCKED_ORIGIN', `navigation to ${u.origin} is refused (blocked origin)`);
  }
  return u.toString();
}

export class SessionManager {
  // HARDEN-2: session creation is serialized through this promise chain so two
  // concurrent POST /sessions cannot both pass the cap check during the slow
  // context creation.
  #createLock = Promise.resolve();

  constructor(cfg = DEFAULTS) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.counter = 0;
    this.browser = null;
    this.browserPromise = null;
    this.reaperTimer = null;
    this.shuttingDown = false;
    this.titleRedactions = compilePatterns();
  }

  // -- browser lifecycle ----------------------------------------------------------

  async browserInstance() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({ channel: this.cfg.channel, headless: this.cfg.headless })
        .then((b) => {
          this.browser = b;
          b.on('disconnected', () => {
            // browser process died (crash / external kill): allow a clean relaunch
            log('browser disconnected — will relaunch on next session');
            this.browser = null;
            this.browserPromise = null;
            for (const s of this.sessions.values()) {
              if (s.status !== 'closed') {
                s.status = 'closed';
                s.context = null;
                s.page = null;
              }
            }
          });
          log(`browser launched: channel=${this.cfg.channel} headless=${this.cfg.headless}`);
          return b;
        })
        .catch((e) => {
          this.browserPromise = null;
          throw err(500, 'BROWSER_LAUNCH_FAILED', `cannot launch ${this.cfg.channel}: ${String(e.message || e).split('\n')[0]}`);
        });
    }
    return this.browserPromise;
  }

  // -- session records ------------------------------------------------------------

  activeCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status !== 'closed') n += 1;
    return n;
  }

  summary(s) {
    return {
      id: s.id,
      owner: s.owner,
      label: s.label,
      url: s.page ? s.page.url() : s.url,
      // SEC-3: session summaries redact the title ONLY when it matches a secret pattern.
      title: redactIfMatch(s.title, this.titleRedactions),
      status: s.status,
      lock: s.lock ? { ...s.lock } : null,
      createdAt: s.createdAt,
      lastOpAt: s.lastOpAt,
    };
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map((s) => this.summary(s));
  }

  get(id, { allowClosed = false } = {}) {
    const s = this.sessions.get(String(id));
    if (!s) throw notFound(`unknown session ${JSON.stringify(String(id))}`, 'SESSION_NOT_FOUND');
    if (s.status === 'closed' && !allowClosed) throw gone();
    return s;
  }

  /** HARDEN-2: serialize creations; the cap is re-checked after the context exists. */
  createSession(body = {}) {
    const run = this.#createLock.then(() => this.#createSessionImpl(body));
    this.#createLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async #createSessionImpl(body = {}) {
    if (this.shuttingDown) throw err(503, 'SHUTTING_DOWN', 'broker is shutting down');
    if (this.activeCount() >= this.cfg.maxSessions) {
      throw err(409, 'SESSION_LIMIT', `session limit reached (${this.cfg.maxSessions}); close one first`);
    }
    const owner = body.owner != null ? String(body.owner).slice(0, 64) : 'agent';
    const label = body.label != null ? String(body.label).slice(0, 120) : null;
    let viewport = DEFAULT_VIEWPORT;
    if (body.viewport) {
      const w = Number(body.viewport.width);
      const h = Number(body.viewport.height);
      if (!Number.isInteger(w) || !Number.isInteger(h) || w < 200 || w > 4096 || h < 200 || h > 4096) {
        throw err(400, 'BAD_VIEWPORT', 'viewport must be {width, height} integers in [200..4096]');
      }
      viewport = { width: w, height: h };
    }

    const browser = await this.browserInstance();
    // SEC-6: invalid TLS certificates are refused by default (ignoreHTTPSErrors used
    // to be hard-coded true). A session may opt in per-session with the documented
    // body flag `allowInsecureTLS: true` — default false.
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: body.allowInsecureTLS === true });
    await context.addInitScript(INIT_PAGE_SCRIPT);
    const page = await context.newPage();

    this.counter += 1;
    const id = `s${this.counter}-${Math.random().toString(16).slice(2, 6)}`;
    const session = {
      id,
      owner,
      label,
      status: 'idle',
      lock: { owner, acquiredAt: Date.now() }, // per-owner lock applied at creation
      context,
      page,
      book: new RefBook('about:blank'),
      title: '',
      url: page.url(),
      createdAt: Date.now(),
      lastOpAt: Date.now(),
      mutationInFlight: false,
      activeReads: 0,
    };
    // HARDEN-2: the cap was checked before context creation; re-check now that we
    // hold a real context and close the excess immediately if we somehow exceeded.
    if (this.activeCount() >= this.cfg.maxSessions) {
      await this.#closeContext(session);
      throw err(409, 'SESSION_LIMIT', `session limit reached (${this.cfg.maxSessions}); close one first`);
    }
    this.sessions.set(id, session);

    if (body.url != null && body.url !== '') {
      try {
        const url = assertAllowedUrl(body.url, { brokerPort: this.cfg.port, blockedOrigins: this.cfg.blockedOrigins });
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
        await this.#postNavGuard(session); // SEC-10: initial goto gets the same final-URL guard
        session.url = page.url();
        session.title = await page.title();
        session.book = new RefBook(session.url);
      } catch (e) {
        await this.#closeContext(session);
        this.sessions.delete(id);
        if (e && e.name === 'HttpError') throw e;
        throw err(502, 'NAVIGATION_FAILED', `initial navigation failed: ${String(e.message || e).split('\n')[0]}`);
      }
    }
    log(`session ${id} created (owner=${owner} viewport=${viewport.width}x${viewport.height})`);
    return session;
  }

  async #closeContext(s) {
    try {
      if (s.context) await s.context.close();
    } catch (e) {
      log(`context close for ${s.id} errored: ${String(e.message || e).split('\n')[0]}`);
    }
    s.context = null;
    s.page = null;
  }

  async closeSession(id, { callerOwner = 'agent', force = false } = {}) {
    const s = this.get(id, { allowClosed: true });
    if (s.status === 'closed') return { alreadyClosed: true };
    if (s.lock && s.lock.owner !== callerOwner && !(force === true && callerOwner === 'agent')) {
      throw err(409, 'SESSION_LOCKED', `session is locked by owner "${s.lock.owner}"; pass owner=${s.lock.owner} or ?force=1 as owner "agent"`);
    }
    if (s.mutationInFlight || s.activeReads > 0) {
      // wait briefly for in-flight work, then close anyway
      const t0 = Date.now();
      while ((s.mutationInFlight || s.activeReads > 0) && Date.now() - t0 < 10_000) await sleep(20);
    }
    s.status = 'closed';
    s.closedAt = Date.now();
    s.lock = null;
    await this.#closeContext(s);
    log(`session ${s.id} closed by ${callerOwner}${force ? ' (force)' : ''}`);
    return { closed: true };
  }

  // -- op lock: mutations exclusive, readers concurrent unless mutation in flight ----------

  /** SEC-1: every gated call identifies itself (X-VBW-Owner, default "agent") and is
   * refused with 409 SESSION_LOCKED when the session is locked by a different owner.
   * The lock lifecycle itself (POST /lock takeOver / POST /unlock) is unchanged. */
  #assertOwned(s, owner) {
    if (s.lock && s.lock.owner !== owner) {
      throw err(409, 'SESSION_LOCKED', `session is locked by owner "${s.lock.owner}"; your calls identify as owner "${owner}" — pass header X-VBW-Owner: ${s.lock.owner} or take over via POST /lock`);
    }
  }

  /** SEC-10: reads and non-navigation mutations on a blocked session stay 403 until
   * the next successful navigate (navigate passes allowBlockedNavigation). */
  #assertNavigable(s, allowBlockedNavigation) {
    if (s.status === 'blocked-navigation' && !allowBlockedNavigation) {
      throw err(403, 'URL_REDIRECT_BLOCKED', `session ${s.id} is blocked after a navigation landed outside the allowlist; perform a successful navigate to an allowed URL to unblock`);
    }
  }

  gateMutation(s, fn, owner = 'agent', { allowBlockedNavigation = false } = {}) {
    this.#assertOpen(s);
    this.#assertOwned(s, owner);
    this.#assertNavigable(s, allowBlockedNavigation);
    s.lastOpAt = Date.now();
    if (s.mutationInFlight) {
      throw busy(`a mutation is already running on session ${s.id}`);
    }
    s.mutationInFlight = true;
    s.status = 'busy';
    const finish = () => {
      s.mutationInFlight = false;
      // SEC-10: a session blocked by the post-navigation guard stays blocked —
      // only a subsequent successful navigate (guard pass) clears it.
      if (s.status !== 'closed' && s.status !== 'blocked-navigation') s.status = 'idle';
      s.lastOpAt = Date.now();
    };
    return this.#drainReaders(s)
      .then(() => fn())
      .then(
        (v) => {
          finish();
          return v;
        },
        (e) => {
          finish();
          throw translatePlaywrightError(e, s);
        }
      );
  }

  gateRead(s, fn, owner = 'agent') {
    this.#assertOpen(s);
    this.#assertOwned(s, owner);
    this.#assertNavigable(s, false);
    s.lastOpAt = Date.now();
    if (s.mutationInFlight) {
      throw busy(`a mutation is in flight on session ${s.id}; readers back off ~300ms`);
    }
    s.activeReads += 1;
    return Promise.resolve()
      .then(() => fn())
      .finally(() => {
        s.activeReads -= 1;
        s.lastOpAt = Date.now();
      })
      .catch((e) => {
        throw translatePlaywrightError(e, s);
      });
  }

  #assertOpen(s) {
    if (s.status === 'closed') throw gone();
    if (!s.page) throw gone('session page is not available');
  }

  async #drainReaders(s) {
    const t0 = Date.now();
    while (s.activeReads > 0 && Date.now() - t0 < 15_000) await sleep(5);
  }

  // -- locks -----------------------------------------------------------------------

  lockSession(id, { owner, takeOver = false }) {
    const s = this.get(id);
    if (!owner || typeof owner !== 'string') throw err(400, 'BAD_OWNER', 'owner is required');
    if (s.lock && s.lock.owner !== owner) {
      if (takeOver !== true) {
        throw err(409, 'SESSION_LOCKED', `session is locked by owner "${s.lock.owner}"; pass takeOver:true to steal`);
      }
      s.lock = { owner: String(owner).slice(0, 64), acquiredAt: Date.now() };
      log(`session ${s.id} lock taken over by ${owner}`);
      return { takeover: true, lock: { ...s.lock } };
    }
    s.lock = { owner: String(owner).slice(0, 64), acquiredAt: Date.now() };
    return { ok: true, lock: { ...s.lock } };
  }

  unlockSession(id, { owner }) {
    const s = this.get(id);
    if (!s.lock) return { ok: true, lock: null };
    if (s.lock.owner !== owner) {
      throw err(409, 'SESSION_LOCKED', `session is locked by owner "${s.lock.owner}"; only that owner can unlock`);
    }
    s.lock = null;
    return { ok: true, lock: null };
  }

  // -- navigation ------------------------------------------------------------------

  /**
   * SEC-10 (defense-in-depth): after a completed goto/back/forward/reload, re-run the
   * URL guard against the FINAL page.url(). A redirect that lands outside the allowlist
   * bounces the page back to about:blank, marks the session status "blocked-navigation"
   * (reads and non-navigation mutations return 403 until the next successful navigate)
   * and surfaces 403 URL_REDIRECT_BLOCKED from the navigation call.
   */
  async #postNavGuard(s) {
    try {
      assertAllowedUrl(s.page.url(), { brokerPort: this.cfg.port, blockedOrigins: this.cfg.blockedOrigins });
    } catch {
      const violated = s.page.url();
      try {
        await s.page.goto('about:blank', { waitUntil: 'load', timeout: 15_000 });
      } catch { /* page may already be gone — the block still applies */ }
      s.url = s.page ? s.page.url() : 'about:blank';
      s.title = '';
      s.book = new RefBook(s.url);
      s.status = 'blocked-navigation';
      s.lastOpAt = Date.now();
      log(`SEC-10: navigation on session ${s.id} landed outside the allowlist (${violated.slice(0, 200)}) — session blocked until the next successful navigate`);
      throw err(403, 'URL_REDIRECT_BLOCKED', `navigation landed on a disallowed URL (${violated.slice(0, 200)}); the page was reset to about:blank and the session is blocked until the next successful navigate`);
    }
  }

  async navigate(s, body = {}, { onOp } = {}) {
    const url = assertAllowedUrl(body.url, { brokerPort: this.cfg.port, blockedOrigins: this.cfg.blockedOrigins });
    const waitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(body.waitUntil) ? body.waitUntil : 'load';
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.min(120_000, Math.max(1_000, Number(body.timeoutMs))) : waitUntil === 'networkidle' ? 45_000 : 30_000;
    // CORE-1: the route wrapper hands back a promise that resolves when
    // POST /ops/:id/cancel fires for this navigation; race the goto against it so a
    // cancel is observable (the op settles as status "cancelled").
    const cancel = typeof onOp === 'function' ? onOp({ kind: 'navigate', url }) : null;
    try {
      if (cancel) {
        const CANCELLED = Symbol('vbw-navigate-cancelled');
        const cancelPromise = Promise.resolve(cancel).then(() => CANCELLED);
        const result = await Promise.race([
          s.page.goto(url, { waitUntil, timeout: timeoutMs }).then(() => null),
          cancelPromise,
        ]);
        if (result === CANCELLED) {
          // navigation continues in background; the ref book still must retire
          s.book = new RefBook(url);
          s.lastOpAt = Date.now();
          return { cancelled: true, url: s.page.url() };
        }
      } else {
        await s.page.goto(url, { waitUntil, timeout: timeoutMs });
      }
    } catch (e) {
      if (e && e.name === 'HttpError') throw e;
      // SEC-10: even a failed goto may already sit on a disallowed redirect target
      await this.#postNavGuard(s);
      throw err(502, 'NAVIGATION_FAILED', `navigation to ${url} failed: ${String(e.message || e).split('\n')[0]}`);
    }
    await this.#postNavGuard(s);
    s.url = s.page.url();
    s.title = await s.page.title();
    s.book = new RefBook(s.url); // navigation retires ALL element refs (Hermes delta rule)
    s.lastOpAt = Date.now();
    return { url: s.url, title: s.title };
  }

  async #historyNav(s, method) {
    await s.page[method]({ waitUntil: 'load', timeout: 30_000 });
    await this.#postNavGuard(s);
    s.url = s.page.url();
    s.title = await s.page.title();
    s.book = new RefBook(s.url); // realm reset -> refs retire on back/forward/reload too
    s.lastOpAt = Date.now();
    return { url: s.url, title: s.title };
  }

  back(s) {
    return this.#historyNav(s, 'goBack');
  }

  forward(s) {
    return this.#historyNav(s, 'goForward');
  }

  reload(s) {
    return this.#historyNav(s, 'reload');
  }

  // -- input (real input events) ------------------------------------------------------

  async input(s, body = {}) {
    const page = s.page;
    const op = body.op;
    const button = ['left', 'right', 'middle'].includes(body.button) ? body.button : 'left';
    const clickCount = Number.isFinite(Number(body.clickCount)) && Number(body.clickCount) > 0 ? Math.floor(Number(body.clickCount)) : 1;
    const delay = Number.isFinite(Number(body.delay)) && Number(body.delay) >= 0 ? Number(body.delay) : undefined;
    const mods = Array.isArray(body.modifiers) ? body.modifiers.map(String) : [];
    const coord = (name) => {
      const n = Number(body[name]);
      if (!Number.isFinite(n)) throw err(400, 'BAD_COORDS', `mouse op "${op}" requires numeric ${name} (viewport-relative)`);
      return n;
    };
    const pressMods = async () => {
      // HARDEN-4: already-pressed modifiers are released when a later down() fails
      // (e.g. unknown key) — modifiers never stick on a rejected op.
      const pressed = [];
      try {
        for (const m of mods) {
          const key = MODIFIER_KEYS[m] || m;
          await page.keyboard.down(key);
          pressed.push(key);
        }
      } catch (e) {
        for (const key of pressed.reverse()) await page.keyboard.up(key).catch(() => {});
        throw e;
      }
    };
    const releaseMods = async () => {
      for (const m of mods.reverse()) {
        const key = MODIFIER_KEYS[m] || m;
        await page.keyboard.up(key).catch(() => {});
      }
    };
    switch (op) {
      case 'move':
        await page.mouse.move(coord('x'), coord('y'));
        break;
      case 'down':
        await page.mouse.down({ button });
        break;
      case 'up':
        await page.mouse.up({ button });
        break;
      case 'click':
      case 'dblclick': {
        const x = coord('x');
        const y = coord('y');
        const count = op === 'dblclick' ? 2 : clickCount;
        if (mods.length) {
          await pressMods();
          try {
            await page.mouse.click(x, y, { button, clickCount: count, delay });
          } finally {
            await releaseMods();
          }
        } else {
          await page.mouse.click(x, y, { button, clickCount: count, delay });
        }
        break;
      }
      case 'wheel': {
        const dx = Number.isFinite(Number(body.deltaX)) ? Number(body.deltaX) : 0;
        const dy = Number.isFinite(Number(body.deltaY)) ? Number(body.deltaY) : 0;
        if (!Number.isFinite(Number(body.deltaX)) && !Number.isFinite(Number(body.deltaY))) {
          throw err(400, 'BAD_COORDS', 'wheel requires deltaX and/or deltaY');
        }
        await page.mouse.wheel(dx, dy);
        break;
      }
      case 'key': {
        if (typeof body.key !== 'string' || !body.key) throw err(400, 'BAD_KEY', 'key op requires a key string');
        if (mods.length) {
          await pressMods();
          try {
            await page.keyboard.press(body.key);
          } finally {
            await releaseMods();
          }
        } else {
          await page.keyboard.press(body.key);
        }
        break;
      }
      case 'type': {
        if (typeof body.text !== 'string') throw err(400, 'BAD_TEXT', 'type op requires a text string');
        if (mods.length) {
          await pressMods();
          try {
            await page.keyboard.type(body.text, { delay });
          } finally {
            await releaseMods();
          }
        } else {
          await page.keyboard.type(body.text, { delay });
        }
        break;
      }
      default:
        throw err(400, 'BAD_OP', `unknown input op ${JSON.stringify(op)}; expected move|down|up|click|dblclick|wheel|key|type`);
    }
    s.lastOpAt = Date.now();
    return { ok: true };
  }

  async scrollTo(s, body = {}) {
    const to = body.to;
    if (to !== 'top' && to !== 'bottom') throw err(400, 'BAD_TARGET', 'to must be "top" or "bottom"');
    await s.page.evaluate((t) => {
      const y = t === 'top' ? 0 : document.documentElement.scrollHeight;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }, to);
    s.lastOpAt = Date.now();
    return { ok: true };
  }

  // -- idle reaper -----------------------------------------------------------------

  startReaper() {
    const { reaperIntervalMs, sessionIdleTimeoutMs } = this.cfg;
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.status === 'closed') {
          // HARDEN-1: closed rows stay listed while fresh (spec allows status "closed"),
          // then the Map entry is pruned after 1 h.
          if (now - (s.closedAt || s.lastOpAt) > CLOSED_SESSION_PRUNE_MS) this.sessions.delete(id);
          continue;
        }
        const idleFor = now - s.lastOpAt;
        if (idleFor > sessionIdleTimeoutMs) {
          log(`idle reaper: closing session ${s.id} (idle ${Math.round(idleFor / 1000)}s > ${Math.round(sessionIdleTimeoutMs / 1000)}s)`);
          this.closeSession(s.id, { callerOwner: s.lock ? s.lock.owner : 'agent', force: true }).catch((e) => {
            log(`idle reaper: close of ${s.id} failed: ${String(e.message || e).split('\n')[0]}`);
          });
        }
      }
    }, Math.max(500, reaperIntervalMs));
    if (this.reaperTimer.unref) this.reaperTimer.unref();
    log(`idle reaper running: closes sessions idle > ${Math.round(sessionIdleTimeoutMs / 1000)}s, checks every ${Math.max(500, reaperIntervalMs)}ms`);
  }

  stopReaper() {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** SIGINT/SIGTERM: close every context gracefully. */
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopReaper();
    for (const s of this.sessions.values()) {
      if (s.status !== 'closed') {
        s.status = 'closed';
        await this.#closeContext(s);
      }
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch { /* already gone */ }
      this.browser = null;
    }
    log('all browser contexts closed');
  }
}

const MODIFIER_KEYS = { Control: 'Control', Ctrl: 'Control', Shift: 'Shift', Alt: 'Alt', Meta: 'Meta', Command: 'Meta' };

/**
 * Playwright transport errors ("Target page, context or browser has been closed") surface as
 * 500s without this translation; they mean the browser/context died and the caller should
 * get a clean 410 instead.
 */
function translatePlaywrightError(e, s) {
  if (e && e.name === 'HttpError') return e;
  const msg = String(e && e.message ? e.message : e);
  if (/target page, context or browser has been closed|target closed|browser has been closed|session closed|page has been closed/i.test(msg)) {
    return err(410, 'SESSION_BROWSER_LOST', `browser for session ${s ? s.id : '?'} is gone (crash or external kill): ${msg.split('\n')[0].slice(0, 200)}`);
  }
  return e;
}
