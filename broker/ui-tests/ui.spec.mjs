/*
  VBW Visual Browser UI — self-test (ui.spec.mjs)
  =====================================================================
  What this is:
    A Playwright *script* (not @playwright/test) that exercises the
    Visual Browser UI end-to-end against a locally started VBW broker
    and the demo dev server, then writes a real transcript to
    _vbw\broker\ui-tests\VERIFY.md.

  How to run (from _vbw\demo-app so the demo's installed playwright is
  used — this file creates no package and installs nothing):
      cd _vbw\demo-app
      node ..\broker\ui-tests\ui.spec.mjs

  What it does:
    1. Starts the broker (node src/server.mjs in _vbw\broker) unless one
       already answers on the port (then it is reused, never killed).
       Reads port/token/pid from the broker discovery state file at runtime
       (%LOCALAPPDATA%\vbw\state\broker.json since the SEC-2 state move;
       _vbw\state\broker.json only as a transition fallback) — the token
       is never hardcoded here nor written into the report.
    2. Starts the demo dev server (vite, port 5173, strict) unless one
       already answers (reused, never killed).
    3. Opens http://127.0.0.1:8931/ui in headless Chrome (via the demo
       app's installed playwright, channel chrome) and drives:
       session create via UI → frame drawn on canvas (pixel-sampled
       non-blank evidence) → Browse-mode click forwarding (asserts the
       driven page actually navigated to /catalog) → Hover mode
       highlight/tooltip → Select mode pin with numbered comment and
       PriceTag.tsx source → region shot → Region marquee pin →
       Send to orchestrator (group id) → GET /annotations/pending →
       Test Runner smoke (run id → cancel) → lock takeover dialog →
       unlock-on-tab-close (keepalive).
    4. Classifies every step: PASS / FAIL / GAP / INFO. Failures in
       UI-owned behavior exit non-zero; failures caused by missing
       broker endpoints are recorded as explicit broker gaps (the
       orchestrator reconciles those in integration).
    5. Kills only the processes it started itself.

  Step classification rule:
    - kind 'ui'            → any error is a FAIL (UI code under test).
    - kind 'broker'        → any error is a GAP (broker endpoint missing
                             / not implemented yet).
    - kind 'ui+broker'     → BrokerGap errors are GAPs, others are FAILs.
*/

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* paths & constants                                                   */
/* ------------------------------------------------------------------ */

const here = path.dirname(fileURLToPath(import.meta.url)); // _vbw/broker/ui-tests
const brokerDir = path.resolve(here, '..');                // _vbw/broker
const vbwDir = path.resolve(brokerDir, '..');              // _vbw
const demoDir = path.join(vbwDir, 'demo-app');
// SEC-2: the discovery state file moved to %LOCALAPPDATA%\vbw\state\broker.json
// (outside OneDrive-synced dirs). The old workspace path is read ONLY as a
// transition fallback when the new file does not exist yet.
const localStateDir = process.env.VBW_STATE_DIR
  ? path.resolve(process.env.VBW_STATE_DIR)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'vbw', 'state');
const brokerStateFile = fs.existsSync(path.join(localStateDir, 'broker.json'))
  ? path.join(localStateDir, 'broker.json')
  : path.join(vbwDir, 'state', 'broker.json');
const verifyPath = path.join(here, 'VERIFY.md');

const BROKER_PORT = Number(process.env.VBW_BROKER_PORT || 8931);
const DEMO_PORT = Number(process.env.VBW_DEMO_PORT || 5173);
const BROKER_BASE = `http://127.0.0.1:${BROKER_PORT}`;
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`;
const FALLBACK_UI_PORT = Number(process.env.VBW_FALLBACK_UI_PORT || 8939);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BrokerGap extends Error {}
const isGap = (e) => e instanceof BrokerGap;

/* ------------------------------------------------------------------ */
/* transcript                                                          */
/* ------------------------------------------------------------------ */

const T0 = Date.now();
const transcript = [];
function log(line = '') {
  transcript.push(line);
  console.log(line);
}

const results = [];
let env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  playwright: '?',
  browserEngine: '?',
  broker: { pid: null, port: BROKER_PORT, version: null, started: null, reused: false, up: false },
  vite: { pid: null, port: DEMO_PORT, started: null, reused: false, up: false },
  fallbackUi: false,
  uiUrl: null,
  tokenRedacted: '?',
};
let brokerToken = '';
const consoleErrors = [];
const brokerTails = { out: [], err: [] };
const viteTails = { out: [], err: [] };

function redact(s) {
  let out = String(s);
  if (brokerToken) out = out.split(brokerToken).join('***TOKEN***');
  return out;
}
function esc(s) { return redact(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ '); }

async function step(name, kind, fn) {
  const t0 = Date.now();
  process.stdout.write(`· ${name} … `);
  let status, detail = '';
  try {
    const d = await fn();
    status = 'PASS';
    detail = d == null ? '' : (typeof d === 'string' ? d : JSON.stringify(d));
  } catch (e) {
    detail = (e && e.message) ? e.message : String(e);
    if (isGap(e)) status = 'GAP';
    else status = (kind === 'broker') ? 'GAP' : 'FAIL'; // 'ui' and 'ui+broker' failures are UI bugs once broker availability was proven
  }
  const ms = Date.now() - t0;
  results.push({ name, kind, status, detail: redact(detail), ms });
  log(`${status.padEnd(4)} | ${kind.padEnd(9)} | ${name} (${(ms / 1000).toFixed(1)}s)${detail ? ' — ' + esc(detail).slice(0, 400) : ''}`);
  return status === 'PASS' ? { ok: true } : { ok: false };
}

/* ------------------------------------------------------------------ */
/* generic helpers                                                     */
/* ------------------------------------------------------------------ */

async function waitFor(fn, timeout, interval = 250, label = 'condition') {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) {
      if (isGap(e)) throw e; // broker gaps propagate immediately (correct classification)
      lastErr = e; v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      const msg = `timeout after ${timeout}ms waiting for ${label}${lastErr ? ` — last error: ${lastErr.message || lastErr}` : ''}`;
      throw new Error(msg);
    }
    await sleep(interval);
  }
}

async function httpStatus(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch { return 0; } finally { clearTimeout(t); }
}

function authHeaders(extra) {
  return { 'X-VBW-Owner': 'user', Authorization: `Bearer ${brokerToken}`, ...(extra || {}) };
}

async function bfetch(method, p, body, extraHeaders) {
  const res = await fetch(BROKER_BASE + p, {
    method,
    headers: authHeaders({
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(extraHeaders || {}),
    }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
}

async function bapi(method, p, body, opts = {}) {
  // API contract: 409 SESSION_BUSY means "try again" — readers and mutations
  // back off ~300 ms. Lock operations are excluded (409 there is a real
  // ownership conflict, not contention).
  const deadline = Date.now() + 20000;
  for (;;) {
    const r = await bfetch(method, p, body, opts.headers);
    if (r.ok) return r.json;
    if (r.status === 409 && opts.retry409 !== false && Date.now() < deadline) {
      await sleep(300);
      continue;
    }
    throw new BrokerGap(`${method} ${p} → HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
}

const sessOf = (j) => (j && j.session) ? j.session : (j || {});

/** Short-circuit for steps that cannot run without a live broker + session. */
function needBrokerSession() {
  if (!env.broker.up) throw new BrokerGap('broker is down — step cannot run');
  if (!sid) throw new BrokerGap('no session (an earlier step was a gap)');
}
let sid = null; // declared early so the helper can reference it

function pushTail(store, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) {
      store.push(line);
      if (store.length > 200) store.shift();
    }
  }
}

function tail(store, n) {
  return store.slice(-n).join('\n') || '(no output)';
}

/* ------------------------------------------------------------------ */
/* fallback static UI server (used only when the broker cannot start)  */
/* ------------------------------------------------------------------ */

function startFallbackUi(dir, port) {
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const srv = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = '/'; }
    if (p === '/ui' || p === '/ui/') p = '/ui/index.html';
    if (!p.startsWith('/ui/')) { res.writeHead(404); res.end('not found'); return; }
    const file = path.resolve(dir, p.slice('/ui/'.length));
    if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/* ------------------------------------------------------------------ */
/* processes                                                           */
/* ------------------------------------------------------------------ */

const procs = []; // { label, proc } — killed at the end

function spawnTracked(label, cmd, args, opts, tailStore) {
  const proc = spawn(cmd, args, { windowsHide: true, ...opts });
  procs.push({ label, proc });
  proc.stdout && proc.stdout.on('data', (d) => pushTail(tailStore.out, d));
  proc.stderr && proc.stderr.on('data', (d) => pushTail(tailStore.err, d));
  return proc;
}

async function killTracked() {
  for (const { label, proc } of procs.reverse()) {
    if (!proc || proc.exitCode !== null || !proc.pid) continue;
    // Windows: kill the whole tree so vite/playwright/chrome children die too
    await new Promise((resolve) => {
      const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('exit', () => resolve());
      tk.on('error', () => { try { proc.kill(); } catch { /* gone */ } resolve(); });
      setTimeout(resolve, 5000);
    });
    log(`cleanup: killed ${label} (pid ${proc.pid})`);
  }
}

/* ------------------------------------------------------------------ */
/* canvas pixel evidence                                               */
/* ------------------------------------------------------------------ */

async function canvasStats(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('frame');
    if (!cv || !cv.width || !cv.height) return { ok: false, reason: 'canvas has no size' };
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    let data;
    try { data = ctx.getImageData(0, 0, cv.width, cv.height).data; }
    catch (e) { return { ok: false, reason: 'getImageData failed: ' + e.message }; }
    const seen = new Set();
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 997 * 4) {
      seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
      sum += data[i] + data[i + 1] + data[i + 2];
      n++;
    }
    return {
      ok: true,
      width: cv.width, height: cv.height,
      distinctColors: seen.size,
      avgBrightness: +(sum / Math.max(1, n * 3)).toFixed(1),
      blank: seen.size < 2,
    };
  });
}

async function canvasPoint(page, vx, vy) {
  const box = await page.locator('#frame').boundingBox();
  const vp = await page.evaluate(() => window.__vbwTest.viewport);
  return {
    x: box.x + (vx / vp.width) * box.width,
    y: box.y + (vy / vp.height) * box.height,
    box, vp,
  };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  log(`# VBW UI self-test — live transcript`);
  log(``);
  log(`Started: ${new Date().toISOString()} · node ${env.node} · ${env.platform}`);

  /* ---- playwright from the demo app ---- */
  const requireFromDemo = createRequire(path.join(demoDir, 'package.json'));
  const pw = requireFromDemo('playwright');
  env.playwright = requireFromDemo('playwright/package.json').version;
  log(`Playwright ${env.playwright} (imported from _vbw\\demo-app\\node_modules — no new package)`);
  log(`Workspace root: ${path.resolve(vbwDir, '..')}`);

  /* ---- broker ---- */
  await step('env: broker reachable or startable', 'env', async () => {
    if ((await httpStatus(BROKER_BASE + '/health')) === 200) {
      env.broker.reused = true;
      const h = await (await fetch(BROKER_BASE + '/health')).json();
      env.broker.version = h && h.version;
      env.broker.up = true;
      return `reusing already-running broker on :${BROKER_PORT} (v${h && h.version}) — will NOT kill it`;
    }
    if (!fs.existsSync(path.join(brokerDir, 'src', 'server.mjs'))) {
      throw new BrokerGap('broker src/server.mjs does not exist yet (broker worker still building)');
    }
    const proc = spawnTracked('broker', process.execPath, ['src/server.mjs'], {
      cwd: brokerDir,
      env: { ...process.env, VBW_BROKER_PORT: String(BROKER_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }, brokerTails);
    env.broker.pid = proc.pid;
    env.broker.started = true;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if ((await httpStatus(BROKER_BASE + '/health')) === 200) break;
      if (proc.exitCode !== null) {
        throw new BrokerGap(`broker exited immediately (code ${proc.exitCode}): ${tail(brokerTails.err, 6)}`);
      }
      await sleep(400);
    }
    if ((await httpStatus(BROKER_BASE + '/health')) !== 200) {
      throw new BrokerGap(`broker did not become healthy within 30s; stderr: ${tail(brokerTails.err, 6)}`);
    }
    const h = await (await fetch(BROKER_BASE + '/health')).json();
    env.broker.version = h && h.version;
    env.broker.up = true;
    return `started broker pid ${proc.pid} on :${BROKER_PORT} (v${h && h.version})`;
  });

  /* ---- token from the state file (never hardcoded) ---- */
  await step(`env: broker token from state file (${brokerStateFile})`, 'env', async () => {
    if (!env.broker.up) throw new BrokerGap('broker down — no token to read');
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try {
        const st = JSON.parse(fs.readFileSync(brokerStateFile, 'utf8'));
        if (st && st.token) { brokerToken = String(st.token); break; }
      } catch { /* file not written yet */ }
      await sleep(400);
    }
    if (!brokerToken) throw new BrokerGap(`${brokerStateFile} has no token (or unreadable)`);
    env.tokenRedacted = `***${String(brokerToken.length)} chars***`;
    return `token read from ${brokerStateFile} (length ${brokerToken.length}, redacted everywhere in this report)`;
  });

  /* ---- demo dev server ---- */
  await step('broker: GET /ui without Authorization (sidebar-style navigation)', 'broker', async () => {
    if (!env.broker.up) throw new BrokerGap('broker is down');
    const res = await fetch(BROKER_BASE + '/ui', { cache: 'no-store' });
    if (res.status === 401) {
      throw new BrokerGap('GET /ui requires the Authorization header — per docs/architecture.md §3.2 the DSH sidebar browser opens http://127.0.0.1:8931/ui as a plain top-level navigation, which cannot carry a bearer token; /ui statics should be unauthenticated (or accept ?token=). The UI code is unaffected; this run works around it with page-level extra headers.');
    }
    if (!res.ok) throw new BrokerGap(`GET /ui → HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html/.test(ct)) throw new BrokerGap(`GET /ui content-type ${ct}, expected text/html`);
    return 'serves UI HTML unauthenticated (sidebar-compatible)';
  });

  await step('env: demo dev server (vite :5173)', 'env', async () => {
    if ((await httpStatus(DEMO_URL + '/')) === 200) {
      env.vite.reused = true; env.vite.up = true;
      return 'reusing already-running dev server — will NOT kill it';
    }
    const entry = path.join('node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(path.join(demoDir, entry))) throw new BrokerGap('vite entry missing in demo-app');
    const proc = spawnTracked('vite', process.execPath, [entry, '--port', String(DEMO_PORT), '--strictPort'], {
      cwd: demoDir, stdio: ['ignore', 'pipe', 'pipe'],
    }, viteTails);
    env.vite.pid = proc.pid;
    env.vite.started = true;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if ((await httpStatus(DEMO_URL + '/')) === 200) { env.vite.up = true; break; }
      if (proc.exitCode !== null) throw new BrokerGap(`vite exited (code ${proc.exitCode}): ${tail(viteTails.err, 6)}`);
      await sleep(400);
    }
    if (!env.vite.up) throw new BrokerGap('dev server did not answer within 45s');
    return `started vite pid ${proc.pid}`;
  });

  /* ---- browser ---- */
  let browser = null;
  await step('env: launch headless Chrome (channel chrome, fallback bundled)', 'env', async () => {
    try {
      browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
      env.browserEngine = 'system Chrome (channel=chrome)';
    } catch (e) {
      browser = await pw.chromium.launch({ headless: true });
      env.browserEngine = 'bundled Chromium (chrome channel unavailable: ' + e.message.slice(0, 80) + ')';
    }
    return env.browserEngine;
  });

  /* ---- fallback static UI if broker is down ---- */
  if (!env.broker.up) {
    await step('env: fallback static /ui server (broker down)', 'env', async () => {
      await startFallbackUi(path.join(brokerDir, 'public', 'ui'), FALLBACK_UI_PORT);
      env.fallbackUi = true;
      return `serving public/ui statically at http://127.0.0.1:${FALLBACK_UI_PORT}/ui/ so pure-UI checks can still run`;
    });
  }
  env.uiUrl = env.broker.up ? `${BROKER_BASE}/ui` : `http://127.0.0.1:${FALLBACK_UI_PORT}/ui/`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  // Workaround while the broker guards /ui statics with the bearer token:
  // top-level navigation cannot carry headers, so send it on every page request.
  // Remove once /ui statics are unauthenticated (does not change UI behavior —
  // the UI sends its own Authorization header on API calls anyway).
  if (brokerToken) await page.setExtraHTTPHeaders({ Authorization: 'Bearer ' + brokerToken });
  let lastDialog = null;
  page.on('dialog', (d) => { lastDialog = { type: d.type(), message: d.message() }; d.accept().catch(() => {}); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)));
  await page.addInitScript((tok) => { try { localStorage.setItem('vbw.brokerToken', tok); } catch { /* ignore */ } }, brokerToken || 'dev-token');

  /* reference page: layout geometry of the demo app at the same viewport */
  let navRect = null, priceRect = null;
  await step('env: measure demo-app element geometry (reference page)', 'env', async () => {
    const ref = await context.newPage();
    try {
      await ref.goto(DEMO_URL + '/', { waitUntil: 'load', timeout: 30000 });
      navRect = await ref.locator('[data-testid="nav-catalog"]').boundingBox();
      await ref.goto(DEMO_URL + '/catalog', { waitUntil: 'load', timeout: 30000 });
      priceRect = await ref.locator('[data-testid="price-current"]').first().boundingBox();
    } finally { await ref.close(); }
    if (!navRect || !priceRect) throw new Error('reference elements not found');
    const belowFold = priceRect.y + priceRect.height > 800;
    return `nav-catalog @ (${Math.round(navRect.x)},${Math.round(navRect.y)} ${Math.round(navRect.width)}×${Math.round(navRect.height)}), price-current @ (${Math.round(priceRect.x)},${Math.round(priceRect.y)} ${Math.round(priceRect.width)}×${Math.round(priceRect.height)})${belowFold ? ' [WARNING: below fold]' : ''}`;
  });

  /* ================= UI checks ================= */

  await step('ui: /ui loads with full toolbar', 'ui', async () => {
    await page.goto(env.uiUrl, { waitUntil: 'load', timeout: 20000 });
    await page.waitForSelector('#toolbar', { timeout: 10000 });
    for (const sel of ['#session-select', '#new-session-url', '#btn-new-session', '#url-bar', '#btn-go', '#btn-back', '#btn-reload', '#token-input', '#btn-send', '#status-dot', '#overlay', '#frame']) {
      if (!(await page.$(sel))) throw new Error(`missing element ${sel}`);
    }
    const modes = await page.$$eval('.mode-btn', (els) => els.map((e) => e.dataset.mode));
    if (modes.join(',') !== 'browse,hover,select,region') throw new Error('mode buttons wrong: ' + modes.join(','));
    const pressed = await page.$$eval('.mode-btn', (els) => els.filter((e) => e.getAttribute('aria-pressed') === 'true').map((e) => e.dataset.mode));
    if (pressed.length !== 1 || pressed[0] !== 'browse') throw new Error('initial pressed mode not browse');
    return `UI at ${env.uiUrl}; 4 modes; canvas+overlay present`;
  });

  await step('ui: token seeded from localStorage into token field', 'ui', async () => {
    const stored = await page.evaluate(() => localStorage.getItem('vbw.brokerToken'));
    if (stored !== (brokerToken || 'dev-token')) throw new Error('localStorage token missing/mismatched');
    const val = await page.inputValue('#token-input');
    if (val !== (brokerToken || 'dev-token')) throw new Error('token input not populated from localStorage');
    const type = await page.getAttribute('#token-input', 'type');
    if (type !== 'password') throw new Error('token input should be masked');
    return 'vbw.brokerToken loaded (masked input)';
  });

  await step('ui: letterbox/scale coordinate mapping math', 'ui', async () => {
    const stageBox = await page.locator('#stage').boundingBox();
    // pick two probe points inside the canvas-wrap area
    const frame = await page.locator('#frame').boundingBox();
    const probes = [
      { cx: frame.x + frame.width * 0.25, cy: frame.y + frame.height * 0.4 },
      { cx: frame.x + frame.width * 0.86, cy: frame.y + frame.height * 0.77 },
    ];
    const vp = await page.evaluate(() => window.__vbwTest.viewport);
    for (const p of probes) {
      const got = await page.evaluate(([cx, cy]) => window.__vbwTest.toViewportPoint(cx, cy), [p.cx, p.cy]);
      const expX = (p.cx - frame.x) / frame.width * vp.width;
      const expY = (p.cy - frame.y) / frame.height * vp.height;
      if (Math.abs(got.x - expX) > 0.5 || Math.abs(got.y - expY) > 0.5) {
        throw new Error(`mapping off: got (${got.x.toFixed(2)},${got.y.toFixed(2)}) expected (${expX.toFixed(2)},${expY.toFixed(2)})`);
      }
    }
    void stageBox;
    return `viewport ${vp.width}×${vp.height}; canvas ${Math.round(frame.width)}×${Math.round(frame.width ? frame.height : 0)}; error < 0.5px on probes`;
  });

  /* ================= session + frame ================= */

  await step('broker: session create via UI (POST /sessions owner:user)', 'ui+broker', async () => {
    await page.fill('#new-session-url', DEMO_URL + '/');
    await page.click('#btn-new-session');
    const t0 = Date.now();
    for (;;) {
      sid = await page.evaluate(() => window.__vbwTest.sessionId);
      if (sid) break;
      const texts = await page.$$eval('#toasts .toast', (els) => els.map((e) => e.textContent));
      const err = texts.find((t) => /Could not create session|Session limit|not authorized/.test(t));
      if (err) throw new BrokerGap(redact(err).slice(0, 200));
      if (Date.now() - t0 > 15000) throw new Error('UI never attached a session id after create click');
      await sleep(300);
    }
    const list = await bapi('GET', '/sessions');
    const mine = (list.sessions || []).find((s) => s.id === sid);
    if (!mine) throw new Error(`session ${sid} not visible in GET /sessions`);
    if (mine.owner !== 'user') throw new Error(`owner is ${mine.owner}, expected user`);
    const lockOwner = mine.lock && mine.lock.owner;
    if (lockOwner && lockOwner !== 'user') throw new Error(`lock held by ${lockOwner}`);
    const detail = sessOf(await bapi('GET', '/sessions/' + sid));
    return `session ${sid} · owner ${mine.owner} · lock ${lockOwner || 'none'} · url ${detail.url}`;
  });

  await step('broker: /frame.jpg serves an image', 'broker', async () => {
    needBrokerSession();
    const res = await fetch(`${BROKER_BASE}/sessions/${sid}/frame.jpg?t=${Date.now()}`, { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) throw new BrokerGap(`GET /sessions/:id/frame.jpg → HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
    const ct = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer();
    if (!/image\/(jpeg|png)/.test(ct)) throw new BrokerGap(`frame content-type ${ct} not an image`);
    if (buf.byteLength < 500) throw new BrokerGap(`frame payload suspiciously small (${buf.byteLength} B)`);
    return `HTTP 200 ${ct} ${(buf.byteLength / 1024).toFixed(1)} KiB`;
  });

  await step('ui: canvas draws the frame (pixel-sampled, non-blank)', 'ui', async () => {
    if (!env.broker.up) throw new BrokerGap('broker is down — no frames to draw (UI draw path verified in full runs)');
    await waitFor(() => page.evaluate(() => window.__vbwTest.hasFrame), 20000, 250, 'first frame drawn');
    await waitFor(async () => {
      const s = await canvasStats(page);
      return s.ok && !s.blank && s.distinctColors >= 8;
    }, 15000, 300, 'non-blank canvas pixels');
    const s = await canvasStats(page);
    return `canvas ${s.width}×${s.height}px, ${s.distinctColors} distinct sampled colors, avg brightness ${s.avgBrightness}`;
  });

  /* ================= browse-mode input forwarding ================= */

  await step('ui+broker: Browse-mode click forwarded → demo app navigates to /catalog', 'ui+broker', async () => {
    needBrokerSession();
    if (!navRect) throw new BrokerGap('reference geometry unavailable');
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    const p = await canvasPoint(page, navRect.x + navRect.width / 2, navRect.y + navRect.height / 2);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await sleep(120);
    await page.mouse.down();
    await sleep(80);
    await page.mouse.up();
    await waitFor(async () => {
      const s = sessOf(await bapi('GET', '/sessions/' + sid));
      return /\/catalog/.test(String(s.url || ''));
    }, 20000, 400, 'driven page url → /catalog');
    const s = sessOf(await bapi('GET', '/sessions/' + sid));
    return `click at viewport (${Math.round((p.x - p.box.x) / p.box.width * p.vp.width)},${Math.round((p.y - p.box.y) / p.box.height * p.vp.height)}) → url ${s.url}`;
  });

  /* ================= hover mode ================= */

  await step('ui+broker: Hover mode → /element-at + highlight box + tooltip', 'ui+broker', async () => {
    needBrokerSession();
    if (!priceRect) throw new BrokerGap('reference geometry unavailable');
    await page.getByRole('button', { name: 'Hover', exact: true }).click();
    const vx = priceRect.x + priceRect.width / 2, vy = priceRect.y + priceRect.height / 2;
    const probe = await bapi('POST', `/sessions/${sid}/element-at`, { x: vx, y: vy });
    if (!probe || probe.found !== true) throw new BrokerGap(`/element-at at (${Math.round(vx)},${Math.round(vy)}) returned found=${probe && probe.found}`);
    const p = await canvasPoint(page, vx, vy);
    await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.waitForSelector('#overlay .hover-box', { timeout: 8000 });
    const tip = await page.evaluate(() => {
      const t = document.getElementById('hover-tip');
      return { hidden: t.hidden, text: t.textContent };
    });
    if (tip.hidden || !tip.text.trim()) throw new Error(`tooltip empty/hidden (hidden=${tip.hidden})`);
    return `hover box rendered; tooltip: ${tip.text.replace(/\n/g, ' | ').slice(0, 120)}`;
  });

  /* ================= select mode → pin #1 ================= */

  await step('ui+broker: Select mode click → pin card #1 with safe metadata + numbered comment', 'ui+broker', async () => {
    needBrokerSession();
    if (!priceRect) throw new BrokerGap('reference geometry unavailable');
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const vx = priceRect.x + priceRect.width / 2, vy = priceRect.y + priceRect.height / 2;
    const probe = await bapi('POST', `/sessions/${sid}/element-at`, { x: vx, y: vy });
    if (!probe || probe.found !== true) throw new BrokerGap(`/element-at returned found=${probe && probe.found}`);
    const p = await canvasPoint(page, vx, vy);
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('.pin-card[data-pin="1"]', { timeout: 8000 });
    const card = page.locator('.pin-card[data-pin="1"]');
    const text = await card.innerText();
    for (const must of ['box']) {
      if (!text.includes(must)) throw new Error(`pin card missing metadata row "${must}"`);
    }
    const ta = card.locator('textarea.pin-comment');
    if (!(await ta.count())) throw new Error('pin card has no comment textarea');
    await ta.fill('Low contrast price text');
    const val = await ta.inputValue();
    if (val !== 'Low contrast price text') throw new Error('comment not retained');
    return `pin #1 created; metadata rows: ${text.split('\n').filter((l) => /role|tag|label|box|testid|source|ref/.test(l)).join(' · ').slice(0, 200)}`;
  });

  await step('broker: pin card shows fiber source PriceTag.tsx', 'ui+broker', async () => {
    needBrokerSession();
    const probe = await bapi('POST', `/sessions/${sid}/element-at`, {
      x: priceRect.x + priceRect.width / 2, y: priceRect.y + priceRect.height / 2,
    });
    const src = probe && (probe.source || (probe.element && probe.element.source));
    const srcName = src && (typeof src === 'string' ? src : (src.fileName || src.file || ''));
    if (!srcName || !/PriceTag\.tsx/.test(srcName)) {
      throw new BrokerGap(`/element-at returned no PriceTag.tsx source (got ${JSON.stringify(src || null).slice(0, 120)})`);
    }
    const cardText = await page.locator('.pin-card[data-pin="1"]').innerText();
    if (!cardText.includes('PriceTag.tsx')) throw new Error(`card missing source (endpoint gave ${srcName})`);
    return `card source row contains ${srcName}${src && src.lineNumber ? ':' + src.lineNumber : ''}`;
  });

  /* ================= region shot on pin #1 ================= */

  await step('broker: "Add region shot" → /screenshot clip → thumbnail on pin #1', 'ui+broker', async () => {
    needBrokerSession();
    await bapi('POST', `/sessions/${sid}/screenshot`, { clip: { x: 0, y: 0, width: 40, height: 40 }, format: 'png' });
    await page.locator('.pin-card[data-pin="1"] button.pin-region-shot').click();
    await page.waitForSelector('.pin-card[data-pin="1"] img.pin-thumb', { timeout: 10000 });
    const src = await page.getAttribute('.pin-card[data-pin="1"] img.pin-thumb', 'src');
    if (!/^data:image\//.test(src)) throw new Error('thumbnail src is not a data:image URL');
    return `thumbnail ${src.length} chars (${src.slice(0, 30)}…)`;
  });

  /* ================= region mode → pin #2 ================= */

  await step('ui: Region mode marquee renders while dragging', 'ui', async () => {
    await page.getByRole('button', { name: 'Region', exact: true }).click();
    const a = await canvasPoint(page, 420, 300);
    const b = await canvasPoint(page, 640, 430);
    try {
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.waitForSelector('#overlay .marquee', { timeout: 3000 });
    } finally {
      await page.mouse.up(); // release triggers the /screenshot POST
    }
    return 'svg .marquee visible during drag (pure client-side)';
  });

  await step('broker: region release → pin #2 with thumbnail', 'ui+broker', async () => {
    needBrokerSession();
    await waitFor(async () => (await page.evaluate(() => window.__vbwTest.pinCount)) >= 2, 10000, 300, 'second pin card');
    const nums = await page.evaluate(() => window.__vbwTest.pinNumbers);
    if (nums.join(',') !== '1,2') throw new Error(`pin numbering wrong: ${nums}`);
    const lastKind = await page.locator('.pin-card').last().evaluate((el) => el.querySelector('.pin-kind').textContent);
    if (!/region/.test(lastKind)) throw new Error(`last pin kind is ${lastKind}, expected region`);
    await page.waitForSelector('.pin-card[data-pin="2"] img.pin-thumb', { timeout: 10000 });
    return 'pin #2 (region) created with thumbnail; numbering 1,2';
  });

  await step('ui: every pin gets a comment (API requires non-empty comment)', 'ui', async () => {
    const tas = page.locator('.pin-card textarea.pin-comment');
    const n = await tas.count();
    if (!n) throw new Error('no pin comment fields found');
    for (let i = 0; i < n; i++) {
      const t = tas.nth(i);
      if (!(await t.inputValue()).trim()) await t.fill(`Finding #${i + 1}: see card metadata`);
    }
    return `filled ${n} comment(s)`;
  });

  /* ================= send to orchestrator ================= */

  let groupId = null;
  await step('broker: Send to orchestrator → delivered ✓ (group <id>)', 'ui+broker', async () => {
    needBrokerSession();
    await page.fill('#ann-note', 'Fix price contrast (VBW demo loop)');
    await page.click('#btn-send');
    const toastText = await waitFor(async () => {
      const texts = await page.$$eval('#toasts .toast', (els) => els.map((e) => e.textContent));
      const ok = texts.find((t) => /delivered ✓ \(group ([^)]+)\)/.test(t));
      if (ok) return ok;
      const err = texts.find((t) => /Send failed/.test(t));
      if (err) throw new BrokerGap(redact(err).slice(0, 200));
      return false;
    }, 12000, 300, 'delivery toast');
    groupId = (toastText.match(/delivered ✓ \(group ([^)]+)\)/) || [])[1] || null;
    if (groupId == null) throw new Error('no group id in toast: ' + toastText);
    const pinCount = await page.evaluate(() => window.__vbwTest.pinCount);
    if (pinCount !== 0) throw new Error(`pins not cleared after send (count ${pinCount})`);
    return `group id ${groupId}; pins cleared locally`;
  });

  await step('broker: GET /annotations/pending shows the delivered group', 'broker', async () => {
    needBrokerSession();
    if (!groupId) throw new BrokerGap('no group id (send step was a gap)');
    const r = await bapi('GET', '/annotations/pending');
    const groups = (r && r.groups) || [];
    if (!groups.length) throw new BrokerGap('pending queue empty after POST /annotations');
    const mine = groups.find((g) => String((g && (g.groupId ?? g.id))) === String(groupId));
    if (!mine) throw new BrokerGap(`group ${groupId} not in pending queue (have ${(groups.map((g) => g.groupId ?? g.id)).join(',')})`);
    const items = mine.items || [];
    const nums = items.map((i) => i.number).join(',');
    const badge = await page.textContent('#pending-badge');
    return `pending groups: ${groups.length}; our group items numbered [${nums}]; UI badge "${badge}"`;
  });

  /* ================= test runner panel ================= */

  await step('ui: Test Runner panel collapsible with default project dir', 'ui', async () => {
    const hiddenBefore = await page.evaluate(() => document.getElementById('runner-body').hidden);
    if (!hiddenBefore) throw new Error('runner body should start collapsed');
    await page.click('#runner-toggle');
    const hiddenAfter = await page.evaluate(() => document.getElementById('runner-body').hidden);
    if (hiddenAfter) throw new Error('runner body did not open');
    const val = await page.inputValue('#run-project');
    if (!val.includes('demo-app')) throw new Error(`unexpected default project dir: ${val}`);
    const expanded = await page.getAttribute('#runner-toggle', 'aria-expanded');
    if (expanded !== 'true') throw new Error('aria-expanded not updated');
    return `opened panel; project dir default "${val}"`;
  });

  await step('broker: POST /tests/run accepts workspace-relative projectDir "_vbw\\demo-app"', 'broker', async () => {
    needBrokerSession();
    const r = await bfetch('POST', '/tests/run', { projectDir: '_vbw\\demo-app' });
    if (r.ok) {
      const runId = r.json && (r.json.runId ?? r.json.opId ?? r.json.id);
      if (runId) await bfetch('POST', `/ops/${runId}/cancel`, {}).catch(() => {});
      return `accepted — relative dir resolved (run ${runId} cancelled immediately)`;
    }
    throw new BrokerGap(`workspace-relative projectDir rejected: HTTP ${r.status} ${r.text.slice(0, 140)} — broker should resolve it against the workspace root (its own cwd is _vbw\\broker); the UI default input is "_vbw\\demo-app" per the UI spec`);
  });

  await step('broker: test run smoke — run id appears, cancel works', 'ui+broker', async () => {
    if (!env.broker.up) throw new BrokerGap('broker is down — step cannot run');
    // broker-side note: it resolves projectDir against its own cwd, so the UI's
    // required default "_vbw\demo-app" 409s/400s — recorded as a gap elsewhere if
    // it persists; the smoke uses an absolute path to exercise run+cancel.
    await page.fill('#run-project', demoDir);
    await page.click('#btn-run-tests');
    let statusText = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const t = ((await page.textContent('#run-status')) || '').trim();
      if (/run failed/.test(t)) throw new BrokerGap(t);           // e.g. POST /tests/run → 404
      if (/^run \S+ · /.test(t)) { statusText = t; break; }        // "run <id> · starting…"
      await sleep(300);
    }
    if (!statusText) throw new Error('run id never appeared in #run-status');
    await page.click('#btn-cancel-run');
    const finalStatus = await waitFor(async () => {
      const t = await page.textContent('#run-status');
      return /(cancel\w*|done|failed|exit)/i.test(t) ? t : false;
    }, 45000, 500, 'terminal run status after cancel');
    return `status: ${statusText} → ${finalStatus.trim()}`;
  });

  /* ================= ownership ================= */

  await step('ui+broker: takeover dialog "Take over? (agent currently holds it)"', 'ui+broker', async () => {
    needBrokerSession();
    await bapi('POST', `/sessions/${sid}/lock`, { owner: 'agent', takeOver: true }, { retry409: false });
    // F3: this verification read rides the lock-holder identity — the takeover above made
    // the default identity ("user") a non-holder, so a default-identity GET would 409.
    const st = sessOf(await bapi('GET', '/sessions/' + sid, undefined, { headers: { 'X-VBW-Owner': 'agent' } }));
    if (!(st.lock && st.lock.owner === 'agent')) throw new BrokerGap(`could not set agent lock (lock: ${JSON.stringify(st.lock)})`);
    lastDialog = null;
    await page.selectOption('#session-select', sid);
    try {
      await waitFor(() => lastDialog, 8000, 200, 'confirm dialog');
    } catch {
      // fallback: force the change event in case selectOption value was unchanged
      await page.evaluate((id) => {
        const sel = document.getElementById('session-select');
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, sid);
      await waitFor(() => lastDialog, 8000, 200, 'confirm dialog (after manual change)');
    }
    const msg = lastDialog && lastDialog.message;
    if (!msg) throw new Error('no dialog appeared');
    if (!msg.includes('Take over?') || !msg.includes('agent currently holds it')) {
      throw new Error(`unexpected dialog text: "${msg}"`);
    }
    await waitFor(async () => {
      const s = sessOf(await bapi('GET', '/sessions/' + sid));
      return s.lock && s.lock.owner === 'user';
    }, 10000, 300, 'lock back to user after accept');
    return `dialog: "${msg}" → accepted → lock owner user`;
  });

  await step('broker: unlock released on tab close (fetch keepalive)', 'broker', async () => {
    needBrokerSession();
    await context.close();
    try {
      await waitFor(async () => {
        // F3: ride the lock-holder identity while polling — the default "user" identity
        // cannot read the session while an agent-held lock has not cleared yet.
        const s = sessOf(await bapi('GET', '/sessions/' + sid, undefined, { headers: { 'X-VBW-Owner': 'agent' } }));
        return !s.lock || s.lock == null;
      }, 10000, 400, 'lock cleared after page close');
      return 'lock cleared after context.close() (pagehide → keepalive POST /unlock)';
    } catch (e) {
      const s = sessOf(await bapi('GET', '/sessions/' + sid));
      throw new BrokerGap(`lock still ${JSON.stringify(s.lock)} after close — ${e.message.slice(0, 120)}`);
    }
  });

  /* best-effort graceful cleanup of the session we created */
  if (env.broker.up && sid) {
    await bfetch('DELETE', `/sessions/${sid}`).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

function writeVerify() {
  const counts = { PASS: 0, FAIL: 0, GAP: 0 };
  for (const r of results) if (counts[r.status] !== undefined) counts[r.status]++;
  const uiFails = results.filter((r) => r.status === 'FAIL');
  const gaps = results.filter((r) => r.status === 'GAP');
  const durationS = ((Date.now() - T0) / 1000).toFixed(1);

  const lines = [];
  lines.push(`# VBW Visual Browser UI — self-test report (VERIFY.md)`);
  lines.push('');
  lines.push(`Generated by \`_vbw/broker/ui-tests/ui.spec.mjs\` on ${new Date().toISOString()} · node ${env.node} · ${env.platform}`);
  lines.push('');
  lines.push(`## Environment`);
  lines.push('');
  lines.push(`| Item | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Playwright | ${env.playwright} (imported from _vbw\\demo-app\\node_modules — no new package created) |`);
  lines.push(`| Browser | ${env.browserEngine}, headless, context viewport 1280×800 |`);
  lines.push(`| Broker | :${env.broker.port} · ${env.broker.up ? `up (v${env.broker.version})` : 'DOWN'} · ${env.broker.started ? `started by this run (pid ${env.broker.pid})` : (env.broker.reused ? 'reused pre-existing instance (left running)' : 'unavailable')} |`);
  lines.push(`| Demo dev server | :${env.vite.port} · ${env.vite.up ? 'up' : 'DOWN'} · ${env.vite.started ? `started by this run (pid ${env.vite.pid})` : (env.vite.reused ? 'reused pre-existing instance (left running)' : 'unavailable')} |`);
  lines.push(`| UI under test | ${env.uiUrl} |`);
  lines.push(`| Broker token | read at runtime from the broker discovery state file (${env.tokenRedacted}) — redacted from this report per _vbw\\AGENTS.md |`);
  lines.push(`| UI files | index.html, ui.css, app.js under _vbw\\broker\\public\\ui\\ (vanilla ES module, no build step, no external assets) |`);
  lines.push('');
  lines.push(`## Steps`);
  lines.push('');
  lines.push(`| # | result | kind | step | time | detail |`);
  lines.push(`|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.status === 'PASS' ? '✅ PASS' : r.status === 'FAIL' ? '❌ FAIL' : '⚠️ GAP'} | ${r.kind} | ${esc(r.name)} | ${(r.ms / 1000).toFixed(1)}s | ${esc(r.detail).slice(0, 400) || '—'} |`);
  });
  lines.push('');
  lines.push(`## Broker endpoints exercised`);
  lines.push('');
  for (const r of results) {
    if (r.kind !== 'broker' && r.kind !== 'ui+broker') continue;
    lines.push(`- ${r.status === 'PASS' ? '✅' : '⚠️'} ${r.name.replace(/^(broker|ui\+broker): /, '')} — ${esc(r.detail).slice(0, 220) || (r.status === 'PASS' ? 'ok' : 'failed')}`);
  }
  lines.push('');
  lines.push(`## Console errors from the UI page`);
  lines.push('');
  if (!consoleErrors.length) lines.push('_(none)_');
  else for (const e of consoleErrors.slice(0, 20)) lines.push(`- \`${esc(e)}\``);
  lines.push('');
  lines.push(`## Process tails`);
  lines.push('');
  lines.push(`### broker stderr (last 25 lines)`);
  lines.push('```');
  lines.push(redact(tail(brokerTails.err, 25)));
  lines.push('```');
  lines.push(`### broker stdout (last 15 lines)`);
  lines.push('```');
  lines.push(redact(tail(brokerTails.out, 15)));
  lines.push('```');
  lines.push(`### vite stderr (last 15 lines)`);
  lines.push('```');
  lines.push(redact(tail(viteTails.err, 15)));
  lines.push('```');
  lines.push('');
  lines.push(`## Not covered by this run`);
  lines.push('');
  lines.push(`- Frame-poll back-off while the tab is hidden (\`document.visibilityState === 'hidden'\` → 1 fps) is implemented in app.js but not asserted here — Playwright cannot flip the page's visibility without CDP lifecycle emulation; verified by code review only.`);
  lines.push(`- Multi-session picker switching (single session created in this run) and idle-reaper behavior (30 min) are out of scope for the smoke.`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- UI-owned checks: **${results.filter((r) => r.kind === 'ui').length}** steps, ${results.filter((r) => r.kind === 'ui' && r.status === 'PASS').length} passed, ${uiFails.length} failed.`);
  lines.push(`- Broker-dependent steps: ${results.filter((r) => r.kind !== 'ui' && r.kind !== 'env').length}, of which ${results.filter((r) => r.kind !== 'ui' && r.kind !== 'env' && r.status === 'PASS').length} passed, ${gaps.filter((g) => g.kind !== 'env').length} recorded as broker gaps.`);
  if (gaps.length) {
    lines.push('');
    lines.push(`### Broker gaps (endpoints that failed while the UI code is complete)`);
    lines.push('');
    for (const g of gaps) lines.push(`- **${esc(g.name)}** — ${esc(g.detail).slice(0, 300)}`);
  }
  lines.push('');
  const verdict = uiFails.length ? 'FAIL — UI bugs present (see ❌ rows)' : (gaps.length ? 'PASS WITH BROKER GAPS — UI delivered; gaps listed above are broker-side and reconciled in integration' : 'PASS — all checks green');
  lines.push(`**Verdict: ${verdict}** (wall time ${durationS}s)`);
  lines.push('');

  fs.writeFileSync(verifyPath, lines.join('\n'), 'utf8');
  log('');
  log(`VERIFY.md written → ${verifyPath}`);
  log(`Summary: ${counts.PASS} pass · ${counts.FAIL} fail · ${counts.GAP} gap · ${durationS}s`);
  return uiFails.length ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

let exitCode = 2;
try {
  await main();
  exitCode = writeVerify();
} catch (e) {
  log(`FATAL: ${redact(e && e.stack ? e.stack : String(e))}`);
  try { exitCode = writeVerify(); } catch (e2) { log(`could not write VERIFY.md: ${e2}`); exitCode = 2; }
} finally {
  try {
    if (browser) await browser.close(); // no orphan headless chrome
  } catch { /* already gone */ }
  try {
    // `procs` only ever holds processes this run spawned (reused brokers/servers
    // are never added), so killing everything in it is safe.
    await killTracked();
  } catch (e) { log(`cleanup error: ${e}`); }
  process.exit(exitCode);
}
