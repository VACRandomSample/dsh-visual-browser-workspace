/**
 * VBW Broker — HTTP entry point (node:http, ESM, no framework).
 *
 * Security posture (broker-api.md §Security invariants):
 *   1. loopback-only bind + per-request req.socket.remoteAddress check, plus a
 *      Host-header allowlist (SEC-5) and constant-time token compare (SEC-7);
 *   2. bearer-token auth for everything except GET /health (random token persisted with
 *      port+pid to %LOCALAPPDATA%\vbw\state\broker.json — SEC-2, outside OneDrive);
 *   3. CORS: `Access-Control-Allow-Origin: *` for GET; token-guarded origin echo for
 *      mutations; the error shape is always { error: { code, message } }.
 * No response ever includes the broker token.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DEFAULTS, VERSION, PUBLIC_DIR, STATE_FILE,
  ensureDirs, writeState, writeStoppedState, isLoopbackAddress, log, logErr,
} from './config.mjs';
import { HttpError, err } from './errors.mjs';
import { SessionManager } from './sessions.mjs';
import { frame, screenshot, readText, compilePatterns } from './perception.mjs';
import { survey, elementAt, resolveRefs } from './safe-dom.mjs';
import { findProjectRoot, mapSource, heuristicMatch } from './fiber.mjs';
import { highlight } from './overlay.mjs';
import { createGroup, listPending, ackGroups } from './annotations.mjs';
import { startTestRun, getRun, cancelOp, opsRegistry } from './testrunner.mjs';
import { startDevServer, stopDevServer, stopAllDevServers, listDevServers } from './devserver.mjs';

const cfg = DEFAULTS;
const startedAt = Date.now();
const TOKEN = crypto.randomBytes(24).toString('hex');
const manager = new SessionManager(cfg);
const redactions = compilePatterns();

ensureDirs();

// -- discovery state file: port + pid + token (readable only by local processes) --------
writeState({
  version: VERSION,
  port: cfg.port,
  pid: process.pid,
  token: TOKEN,
  channel: cfg.channel,
  startedAt: new Date().toISOString(),
});
log(`state written to ${STATE_FILE} (port=${cfg.port} pid=${process.pid}, token NOT logged)`);

// -- helpers ---------------------------------------------------------------------------

function sendJson(res, status, obj, { allowOrigin } = {}) {
  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, { allowOrigin } = {}) {
  sendJson(res, status, { error: { code, message } }, { allowOrigin });
}

function bearerToken(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** SEC-7: length-guarded constant-time compare (never leaks the token via timing). */
function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function authorized(req) {
  const tok = bearerToken(req);
  return typeof tok === 'string' && tok.length > 0 && tokensEqual(tok, TOKEN);
}

/**
 * SEC-5: the broker only answers loopback Host headers for its own port. A mismatched
 * Host (DNS-rebinding style) is rejected with 400 BAD_HOST before any other check.
 */
function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  const h = hostHeader.trim().toLowerCase();
  const p = String(cfg.port);
  return h === `127.0.0.1:${p}` || h === `localhost:${p}` || h === `[::1]:${p}`;
}

function readBody(req, limit = cfg.bodyLimitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(err(413, 'BODY_TOO_LARGE', `body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(err(400, 'BAD_JSON', 'request body must be valid JSON'));
      }
    });
    req.on('error', () => reject(err(400, 'BAD_REQUEST', 'request stream error')));
  });
}

/** Caller identity for lock checks: X-VBW-Owner header, "agent" by default (single token). */
function callerOwner(req, body = {}) {
  const h = req.headers['x-vbw-owner'];
  if (typeof h === 'string' && h.trim()) return h.trim().slice(0, 64);
  if (body && typeof body.owner === 'string' && body.owner.trim()) return body.owner.trim().slice(0, 64);
  return 'agent';
}

function devOriginFor(pageUrl) {
  for (const d of listDevServers()) {
    try {
      if (new URL(d.url).origin === new URL(pageUrl).origin) return d.url;
    } catch { /* next */ }
  }
  return null;
}

function projectRootFor(session) {
  return findProjectRoot({ pageUrl: session.page.url(), devservers: listDevServers() });
}

// -- static /ui (UI assets are owned by another worker; broker only serves them) ----------

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = pathname.replace(/^\/ui\/?/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const base = path.resolve(PUBLIC_DIR, 'ui');
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return sendError(res, 403, 'FORBIDDEN_PATH', 'path traversal refused');
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return sendError(res, 404, 'NOT_FOUND', `no UI asset at ${pathname}`);
  }
  if (!stat.isFile()) return sendError(res, 404, 'NOT_FOUND', `no UI asset at ${pathname}`);
  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(target).pipe(res);
}

// -- routing ---------------------------------------------------------------------------

/**
 * Route wrapper: runs handler, registers long mutations (networkidle navigations) as
 * cancellable ops and exposes the opId via the X-VBW-Op-Id header. CORE-1: the handler
 * receives the cancellation PROMISE (not a resolver) — manager.navigate races the goto
 * against it, and a fired cancel settles the op with status "cancelled" (observable via
 * a second POST /ops/:id/cancel → 409 OP_NOT_RUNNING "is cancelled").
 */
function withNavigateOp(session, body, fn) {
  if (body && body.waitUntil === 'networkidle') {
    const opId = `nav-${session.id}-${Date.now().toString(36)}`;
    let cancelResolve;
    const cancelPromise = new Promise((resolve) => {
      cancelResolve = resolve;
    });
    opsRegistry.set(opId, {
      id: opId,
      kind: 'navigate',
      status: 'running',
      meta: {},
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      cancelRequested: false,
      cancel: () => cancelResolve(),
    });
    setTimeout(() => {
      const o = opsRegistry.get(opId);
      if (o && o.status === 'running') {
        o.status = 'done';
        o.finishedAt = Date.now();
      }
    }, 120_000).unref?.();
    return fn(() => cancelPromise).then(
      (v) => {
        const o = opsRegistry.get(opId);
        if (o && o.status === 'running') {
          o.status = v && v.cancelled ? 'cancelled' : 'done';
          o.finishedAt = Date.now();
        }
        if (v) v.__opId = opId;
        return v;
      },
      (e) => {
        const o = opsRegistry.get(opId);
        if (o && o.status === 'running') {
          o.status = 'done';
          o.finishedAt = Date.now();
        }
        throw e;
      }
    );
  }
  return fn(null);
}

async function route(req, res, u, body) {
  const method = req.method;
  const p = u.pathname;
  const seg = p.split('/').filter(Boolean);

  // ---- sessions ----
  if (p === '/sessions' && method === 'POST') {
    const session = await manager.createSession(body);
    return sendJson(res, 201, { session: manager.summary(session) }, { allowOrigin: req.headers.origin || '*' });
  }
  if (p === '/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: manager.list() }, { allowOrigin: '*' });
  }
  if (seg[0] === 'sessions' && seg.length >= 2) {
    const id = seg[1];
    const rest = seg.slice(2).join('/');
    const owner = callerOwner(req, body); // SEC-1: X-VBW-Owner (default "agent")

    if (rest === '' && method === 'GET') {
      const s = manager.get(id);
      return manager.gateRead(s, async () => {
        s.title = await s.page.title();
        return sendJson(res, 200, { session: manager.summary(s) }, { allowOrigin: '*' });
      }, owner);
    }
    if (rest === '' && method === 'DELETE') {
      const force = u.searchParams.get('force') === '1';
      const result = await manager.closeSession(id, { callerOwner: callerOwner(req, body), force });
      return sendJson(res, 200, { ok: true, id: String(id), ...result }, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'lock' && method === 'POST') {
      const s = manager.get(id);
      const result = manager.lockSession(id, { owner: body.owner, takeOver: body.takeOver === true });
      s.lastOpAt = Date.now();
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'unlock' && method === 'POST') {
      const s = manager.get(id);
      const result = manager.unlockSession(id, { owner: body.owner });
      s.lastOpAt = Date.now();
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'navigate' && method === 'POST') {
      const s = manager.get(id);
      // SEC-10: navigate is the ONLY op allowed to run on a blocked-navigation session —
      // a successful navigate to an allowed URL is the documented unblock path.
      const result = await withNavigateOp(s, body, (onOp) => manager.gateMutation(s, () => manager.navigate(s, body, { onOp }), owner, { allowBlockedNavigation: true }));
      if (result && result.__opId) res.setHeader('X-VBW-Op-Id', result.__opId);
      if (result && result.cancelled) return sendJson(res, 200, { cancelled: true, url: result.url }, { allowOrigin: req.headers.origin || '*' });
      return sendJson(res, 200, { url: result.url, title: result.title }, { allowOrigin: req.headers.origin || '*' });
    }
    if ((rest === 'back' || rest === 'forward' || rest === 'reload') && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () => manager[rest](s), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'input' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () => manager.input(s, body), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'scroll-to' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () => manager.scrollTo(s, body), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest.startsWith('frame.') && method === 'GET') {
      const ext = rest.endsWith('.png') ? 'png' : 'jpg';
      const s = manager.get(id);
      const quality = u.searchParams.get('quality');
      const out = await manager.gateRead(s, () => frame(s, { ext, quality }), owner);
      if (allowOriginForRead(method)) res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200, {
        'Content-Type': out.contentType,
        'Content-Length': out.buffer.length,
        'Cache-Control': 'no-store',
      });
      return res.end(out.buffer);
    }
    if (rest === 'screenshot' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateRead(s, () => screenshot(s, body), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'read-text' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateRead(s, () => readText(s, body), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'inventory' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateRead(s, () => survey(s, { max: body.max, projectRoot: projectRootFor(s) }), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'element-at' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateRead(s, async () => {
        const out = await elementAt(s, { x: body.x, y: body.y }, {
          projectRoot: projectRootFor(s),
          extendSource: async (raw) => {
            const root = projectRootFor(s);
            if (!root) return null;
            const tokens = { testIds: raw.testId ? [raw.testId] : [], ids: raw.id ? [raw.id] : [], classes: raw.classes || [], texts: raw.name ? [raw.name] : [] };
            return heuristicMatch(root, tokens, { devOrigin: devOriginFor(s.page.url()) });
          },
        });
        return out;
      }, owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'elements/resolve' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () => resolveRefs(s, body.refs), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'map-source' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateRead(s, async () => {
        const root = projectRootFor(s);
        return mapSource(s, { ref: body.ref, selector: body.selector, x: body.x, y: body.y }, { projectRoot: root, devOrigin: devOriginFor(s.page.url()) });
      }, owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'highlight' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () =>
        highlight(s, body, (ref) => {
          const e = s.book.byRef.get(String(ref));
          return e ? e.vid : null;
        }), owner);
      return sendJson(res, 200, result, { allowOrigin: req.headers.origin || '*' });
    }
    if (rest === 'annotations' && method === 'POST') {
      const s = manager.get(id);
      const result = await manager.gateMutation(s, () => createGroup(s, body), owner);
      return sendJson(res, 201, result, { allowOrigin: req.headers.origin || '*' });
    }
  }

  // ---- annotations (global) ----
  if (p === '/annotations/pending' && method === 'GET') {
    // HARDEN-3: screenshot dataUrls are stripped by default; ?includeShots=1 opts in.
    const includeShots = u.searchParams.get('includeShots') === '1';
    return sendJson(res, 200, listPending({ includeShots }), { allowOrigin: '*' });
  }
  if (p === '/annotations/ack' && method === 'POST') {
    return sendJson(res, 200, ackGroups(body.groupIds), { allowOrigin: req.headers.origin || '*' });
  }

  // ---- tests / ops / devserver ----
  if (p === '/tests/run' && method === 'POST') {
    // CORE-2b: awaited so the dev-server bootstrap finishes before 202 {runId}.
    const result = await startTestRun(body);
    return sendJson(res, 202, result, { allowOrigin: req.headers.origin || '*' });
  }
  if (seg[0] === 'tests' && seg[1] === 'runs' && seg.length === 3 && method === 'GET') {
    return sendJson(res, 200, getRun(seg[2]), { allowOrigin: '*' });
  }
  if (seg[0] === 'ops' && seg[2] === 'cancel' && method === 'POST') {
    return sendJson(res, 200, cancelOp(seg[1]), { allowOrigin: req.headers.origin || '*' });
  }
  if (p === '/devserver' && method === 'POST') {
    const result = await startDevServer(body);
    return sendJson(res, 201, result, { allowOrigin: req.headers.origin || '*' });
  }
  if (p === '/devserver' && method === 'GET') {
    return sendJson(res, 200, { devServers: listDevServers() }, { allowOrigin: '*' });
  }
  if (seg[0] === 'devserver' && seg.length === 2 && method === 'DELETE') {
    return sendJson(res, 200, stopDevServer(seg[1]), { allowOrigin: req.headers.origin || '*' });
  }

  if (p === '/ui' || p.startsWith('/ui/')) {
    return serveStatic(req, res, p);
  }

  throw err(404, 'NOT_FOUND', `no route for ${method} ${p}`);
}

function allowOriginForRead(method) {
  return method === 'GET' || method === 'HEAD';
}

// -- http server -----------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
  // Invariant 0 (SEC-5): only the broker's own loopback Host headers are accepted —
  // anything else (DNS-rebinding style) is rejected before every other check.
  if (!hostAllowed(req.headers.host)) {
    return sendError(res, 400, 'BAD_HOST', `Host header must be 127.0.0.1:${cfg.port}, localhost:${cfg.port} or [::1]:${cfg.port}`);
  }
  // Invariant 1: every request must arrive over loopback.
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return sendError(res, 403, 'FORBIDDEN_REMOTE', 'broker only accepts loopback connections');
  }

  if (req.method === 'OPTIONS') {
    // CORS preflight: mutation safety is enforced by the token on the real request.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-VBW-Owner',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  const isRead = allowOriginForRead(req.method);

  // Invariant / health: GET /health needs no auth and exposes no data beyond counts.
  if (req.method === 'GET' && u.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      sessions: manager.activeCount(),
      uptimeMs: Date.now() - startedAt,
      channel: cfg.channel,
    }, { allowOrigin: '*' });
  }

  // UI statics are unauthenticated by design: they contain no secrets (the UI
  // collects the bearer token itself to call the API), and embedding contexts
  // (DSH sidebar iframe / managed browser tab) cannot set Authorization headers.
  // Still loopback-only (checked above).
  if ((req.method === 'GET' || req.method === 'HEAD') && (u.pathname === '/ui' || u.pathname.startsWith('/ui/'))) {
    return serveStatic(req, res, u.pathname);
  }

  // Invariant 2: bearer-token auth for everything else.
  if (!authorized(req)) {
    // no CORS header for unauthorized mutations (token-guarded CORS per spec)
    return sendError(res, 401, 'AUTH_REQUIRED', 'missing or invalid Authorization: Bearer token');
  }

  const needsBody = req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT';
  Promise.resolve(needsBody ? readBody(req) : {})
    .then((body) => route(req, res, u, body))
    .catch((e) => {
      if (res.headersSent) {
        try { res.end(); } catch { /* socket gone */ }
        return;
      }
      if (e instanceof HttpError) {
        return sendError(res, e.status, e.code, e.message, { allowOrigin: isRead ? '*' : undefined });
      }
      logErr(`500 on ${req.method} ${u.pathname}:`, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
      return sendError(res, 500, 'INTERNAL', `internal error: ${String(e && e.message ? e.message : e).slice(0, 300)}`, { allowOrigin: isRead ? '*' : undefined });
    });
});

server.on('clientError', (e, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch { /* ignore */ }
});

// -- lifecycle -------------------------------------------------------------------------

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logErr('unhandledRejection:', e && e.stack ? e.stack.split('\n')[0] : e));
// a broker must survive unexpected internals (e.g. a transport throw while Chrome dies):
// log loudly and keep serving; session endpoints translate dead-browser states to 410.
process.on('uncaughtException', (e) => logErr('uncaughtException:', e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : e));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}: closing contexts, dev servers, then exiting`);
  try {
    manager.stopReaper();
    stopAllDevServers();
    await manager.shutdown();
  } catch (e) {
    logErr('graceful shutdown error:', e && e.message);
  }
  // clear the stale pid lock: rewrite state without pid/token so tools see a dead broker
  try {
    writeStoppedState({ port: cfg.port, channel: cfg.channel });
  } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref?.();
}

server.listen(cfg.port, cfg.host, () => {
  manager.startReaper();
  log(`vbw broker v${VERSION} listening on http://${cfg.host}:${cfg.port} (loopback only)`);
  log(`browser channel: ${cfg.channel}; max sessions: ${cfg.maxSessions}`);
});

export { server, manager, TOKEN, cfg };
