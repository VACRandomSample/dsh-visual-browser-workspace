/**
 * Playwright test runner + ops registry with cancellation.
 *
 * POST /tests/run spawns `node <bundled-node> <pnpm.cjs> exec playwright test …` with
 * cwd=projectDir and VBW_NO_WEBSERVER=1. CORE-2b: the run auto-bootstraps the
 * broker-managed dev server for the SAME projectDir ({devServer:{port}}, default
 * 5173) when nothing answers on the port — reuse-first, and the server is left
 * running after the run (it is shared with the UI); meta.devServerStarted records
 * whether THIS run spawned it. Playwright's list-report summary is parsed into
 * {passed, failed, flaky, skipped, durationMs}; a ring buffer keeps the log tail;
 * the HTML report dir is reported back. Every long op is registered and cancellable
 * via POST /ops/:opId/cancel. SEC-12: extraArgs may not override the config
 * (-c/--config → 400 BAD_TEST_ARG) and runs are capped by VBW_TEST_MAX_MS
 * (default 900000 ms → status "timeout").
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NODE_BIN, PNPM_CJS, WORKSPACE_ROOT, TEST_RUNS_DIR, DEFAULTS, ensureDirs, log } from './config.mjs';
import { err } from './errors.mjs';
import { startDevServer, getDevServerByPort } from './devserver.mjs';

const ops = new Map(); // opId -> { id, kind, status, startedAt, finishedAt, cancel, meta }

// HARDEN-1: terminal ops are pruned from the registry 10 minutes after they finish
// (bounded memory; the registry is unbounded otherwise).
const OPS_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, op] of ops) {
    if (op.status !== 'running' && op.finishedAt && now - op.finishedAt > OPS_TTL_MS) ops.delete(id);
  }
}, 60_000).unref?.();

// SEC-12: optional wall-clock run cap (env VBW_TEST_MAX_MS, default 15 min).
const TEST_MAX_MS = (() => {
  const n = Number(process.env.VBW_TEST_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : 900_000;
})();

export function registerOp({ id, kind, cancel, meta }) {
  const op = {
    id,
    kind,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    cancelRequested: false,
    cancel: typeof cancel === 'function' ? cancel : () => {},
    meta: meta || {},
  };
  ops.set(id, op);
  return op;
}

export function finishOp(id, { status = 'done', exitCode = null } = {}) {
  const op = ops.get(id);
  if (!op) return;
  op.status = status;
  op.exitCode = exitCode;
  op.finishedAt = Date.now();
}

export function getOp(id) {
  return ops.get(String(id)) || null;
}

export function cancelOp(id) {
  const op = ops.get(String(id));
  if (!op) throw err(404, 'OP_NOT_FOUND', `unknown op ${JSON.stringify(String(id))}`);
  if (op.status !== 'running') throw err(409, 'OP_NOT_RUNNING', `op ${String(id)} is ${op.status}, cannot cancel`);
  op.cancelRequested = true;
  try {
    op.cancel();
  } catch (e) {
    log(`cancel of op ${op.id} errored: ${String(e.message || e).split('\n')[0]}`);
  }
  return { ok: true, id: op.id, kind: op.kind };
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      // /T kills the whole tree (vite/playwright spawn children)
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* fall through */ }
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* already gone */ }
}

function inScopeDir(projectDir) {
  // Relative paths resolve against the VBW workspace root (not the broker's
  // cwd), so callers can pass "_vbw\\demo-app" like the UI default does.
  const raw = String(projectDir);
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(WORKSPACE_ROOT, raw);
  const scopeRoots = [WORKSPACE_ROOT];
  if (process.env.VBW_PROJECT_ROOT) scopeRoots.push(path.resolve(process.env.VBW_PROJECT_ROOT));
  const ok = scopeRoots.some((root) => {
    const rel = path.relative(root.toLowerCase(), resolved.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) throw err(403, 'DIR_OUT_OF_SCOPE', 'projectDir must live inside the VBW workspace');
  return resolved;
}

function validateProjectDir(projectDir) {
  const resolved = inScopeDir(projectDir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw err(404, 'PROJECT_DIR_NOT_FOUND', `projectDir does not exist: ${String(projectDir)}`);
  }
  if (!stat.isDirectory()) throw err(400, 'BAD_PROJECT_DIR', 'projectDir must be a directory');
  if (!fs.existsSync(path.join(resolved, 'package.json'))) {
    throw err(400, 'BAD_PROJECT_DIR', 'projectDir must contain package.json');
  }
  return resolved;
}

function parseDurationMs(s) {
  const m = /\((\d+(?:\.\d+)?)(ms|s|m)\)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2] === 'ms') return Math.round(n);
  if (m[2] === 'm') return Math.round(n * 60_000);
  return Math.round(n * 1000);
}

/** Parse Playwright's list report tail lines into {passed, failed, flaky, skipped, durationMs}. */
export function parsePlaywrightSummary(lines) {
  const summary = { passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: null };
  let durationLine = null;
  for (const line of lines) {
    const countRe = /\b(\d+)\s+(passed|failed|flaky|skipped|interrupted|did not run)\b/g;
    let m;
    let hit = false;
    while ((m = countRe.exec(line)) !== null) {
      const n = Number(m[1]);
      const word = m[2];
      hit = true;
      if (word === 'passed') summary.passed += n;
      else if (word === 'failed') summary.failed += n;
      else if (word === 'flaky') summary.flaky += n;
      else if (word === 'interrupted') summary.failed += n;
      else summary.skipped += n; // skipped | did not run
    }
    if (hit || /\(\d+(?:\.\d+)?(ms|s|m)\)/.test(line)) durationLine = line;
  }
  summary.durationMs = durationLine ? parseDurationMs(durationLine) : null;
  if (summary.passed + summary.failed + summary.flaky + summary.skipped === 0) return null;
  return summary;
}

function findReportDirs(projectDir) {
  const candidates = ['test-results/html-report', 'playwright-report', 'html-report'];
  let reportDir;
  let traceDir;
  for (const c of candidates) {
    const p = path.join(projectDir, c);
    if (fs.existsSync(p)) {
      reportDir = p;
      break;
    }
  }
  const tr = path.join(projectDir, 'test-results');
  if (fs.existsSync(tr)) traceDir = tr;
  return { reportDir, traceDir };
}

function makeRing(limit = DEFAULTS.logTailLines) {
  const buf = [];
  return {
    push(line) {
      buf.push(String(line).slice(0, 500));
      if (buf.length > limit) buf.splice(0, buf.length - limit);
    },
    tail() {
      return buf.join('\n');
    },
    lines: buf,
  };
}

/** TCP probe: does something answer on this URL (CORE-2b reuse-first check)? */
function httpReachable(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/**
 * CORE-2b: ensure a dev server answers before the Playwright spawn.
 * `option` is body.devServer: {port?} (default port 5173) or false/null to opt out.
 * Reachable port → reuse whatever serves it; otherwise reuse a broker-managed server
 * already registered on the port, else start one for the SAME projectDir and LEAVE it
 * running after the run (shared with the UI).
 */
async function ensureRunDevServer(projectDir, option) {
  if (option === false || option === null) return { skipped: true, started: false, reused: false, port: null };
  const portRaw = option && typeof option === 'object' ? option.port : undefined;
  const port = Number.isInteger(Number(portRaw)) && Number(portRaw) > 0 ? Number(portRaw) : 5173;
  const url = `http://127.0.0.1:${port}/`;
  if (await httpReachable(url)) return { skipped: false, started: false, reused: true, port };
  if (getDevServerByPort(port)) return { skipped: false, started: false, reused: true, port };
  await startDevServer({ projectDir, port });
  log(`test run dev server bootstrap: broker-managed vite started on port ${port} for ${projectDir}`);
  return { skipped: false, started: true, reused: false, port };
}

/** POST /tests/run { projectDir, filter?, extraArgs?, devServer? } -> 202 { runId }. */
export async function startTestRun(body = {}) {
  if (body.projectDir == null) throw err(400, 'BAD_PROJECT_DIR', 'projectDir is required');
  const projectDir = validateProjectDir(body.projectDir);
  const filter = body.filter != null ? String(body.filter) : null;
  const extraArgs = Array.isArray(body.extraArgs)
    ? body.extraArgs.map(String).slice(0, 20)
    : [];
  // SEC-12: the Playwright config stays broker-controlled — no -c/--config through extraArgs.
  for (const a of extraArgs) {
    if (a === '-c' || a === '--config') {
      throw err(400, 'BAD_TEST_ARG', 'extraArgs must not contain -c/--config (the Playwright config is broker-controlled)');
    }
  }
  ensureDirs();

  // CORE-2b: bootstrap (or reuse) the dev server for the SAME projectDir before spawning.
  const dev = await ensureRunDevServer(projectDir, body.devServer === undefined ? { port: 5173 } : body.devServer);

  const runId = `run-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const ring = makeRing();
  const op = registerOp({
    id: runId,
    kind: 'test-run',
    meta: {
      projectDir,
      filter,
      devServerStarted: dev.started,
      devServerPort: dev.port,
      devServerReused: dev.skipped ? undefined : dev.reused,
    },
    cancel() {
      killTree(child.pid);
    },
  });

  const args = [PNPM_CJS, 'exec', 'playwright', 'test', ...(filter ? [filter] : []), ...extraArgs];
  log(`test run ${runId}: spawning ${path.basename(NODE_BIN)} ${args.map((a) => JSON.stringify(a)).join(' ')} (cwd=${projectDir}, VBW_NO_WEBSERVER=1, devServerStarted=${dev.started})`);
  const child = spawn(NODE_BIN, args, {
    cwd: projectDir,
    env: { ...process.env, VBW_NO_WEBSERVER: '1' },
    windowsHide: true,
  });

  // SEC-12: wall-clock cap — auto-cancel with status "timeout" when exceeded.
  let timedOut = false;
  const capTimer = setTimeout(() => {
    if (op.status === 'running') {
      timedOut = true;
      ring.push(`[cap] run exceeded VBW_TEST_MAX_MS=${TEST_MAX_MS}ms — auto-cancelled`);
      log(`test run ${runId}: cap ${TEST_MAX_MS}ms exceeded — killing runner`);
      killTree(child.pid);
    }
  }, TEST_MAX_MS);
  capTimer.unref?.();

  const onLine = (line) => {
    ring.push(line);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutRemainder = '';
  const feed = (chunk, src) => {
    stdoutRemainder += chunk;
    let idx;
    while ((idx = stdoutRemainder.indexOf('\n')) >= 0) {
      onLine(`[${src}] ${stdoutRemainder.slice(0, idx)}`);
      stdoutRemainder = stdoutRemainder.slice(idx + 1);
    }
  };
  child.stdout.on('data', (c) => feed(c, 'out'));
  child.stderr.on('data', (c) => feed(c, 'err'));
  child.on('error', (e) => {
    clearTimeout(capTimer);
    ring.push(`[spawn-error] ${e.message}`);
    finishOp(runId, { status: 'failed', exitCode: -1 });
  });
  child.on('exit', (code, signal) => {
    clearTimeout(capTimer);
    if (stdoutRemainder) onLine(`[out] ${stdoutRemainder}`);
    const cancelled = op.cancelRequested;
    const status = timedOut ? 'timeout' : cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed';
    finishOp(runId, { status, exitCode: code === null ? (signal ? -1 : null) : code });
    const summary = parsePlaywrightSummary(ring.lines);
    const { reportDir, traceDir } = findReportDirs(projectDir);
    Object.assign(op.meta, {
      summary,
      reportDir,
      traceDir,
      logTail: ring.tail(),
      signal: signal || undefined,
    });
    log(`test run ${runId} ${status} (exit=${code} signal=${signal || '-'}) summary=${summary ? JSON.stringify(summary) : 'unparsed'}${timedOut ? ` (VBW_TEST_MAX_MS=${TEST_MAX_MS}ms cap hit)` : ''}`);
  });

  return { runId };
}

/** GET /tests/runs/:runId */
export function getRun(runId) {
  const op = ops.get(String(runId));
  if (!op || op.kind !== 'test-run') {
    throw err(404, 'RUN_NOT_FOUND', `unknown test run ${JSON.stringify(String(runId))}`);
  }
  const m = op.meta;
  return {
    runId: op.id,
    status: op.status,
    ...(op.status !== 'running' && op.exitCode !== null ? { exitCode: op.exitCode } : {}),
    ...(m.summary ? { summary: m.summary } : {}),
    logTail: m.logTail || '',
    ...(m.reportDir ? { reportDir: m.reportDir } : {}),
    ...(m.traceDir ? { traceDir: m.traceDir } : {}),
    ...(m.filter ? { filter: m.filter } : {}),
    // CORE-2b: dev-server bootstrap provenance of this run
    ...(m.devServerStarted !== undefined ? { devServerStarted: m.devServerStarted } : {}),
    ...(m.devServerPort ? { devServerPort: m.devServerPort } : {}),
    ...(m.devServerReused !== undefined ? { devServerReused: m.devServerReused } : {}),
    startedAt: new Date(op.startedAt).toISOString(),
    ...(op.finishedAt ? { finishedAt: new Date(op.finishedAt).toISOString() } : {}),
  };
}

export { ops as opsRegistry, makeRing, killTree, validateProjectDir };
