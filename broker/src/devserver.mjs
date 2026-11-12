/**
 * Broker-managed dev servers so the test runner and the UI hit the same dev instance.
 * POST /devserver spawns the FIXED vite command (CORE-2a: no caller-supplied command —
 * the old shell:true exec tier is removed) in a project dir, waits until the URL
 * answers, registers a cancellable op during startup and keeps the handle for DELETE.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import { NODE_BIN, log } from './config.mjs';
import { err } from './errors.mjs';
import { registerOp, finishOp, killTree, validateProjectDir, makeRing, getOp } from './testrunner.mjs';

const servers = new Map(); // devServerId -> { id, projectDir, port, url, child, startedAt, ring }

export function listDevServers() {
  return [...servers.values()].map((s) => ({
    devServerId: s.id,
    projectDir: s.projectDir,
    port: s.port,
    url: s.url,
    startedAt: new Date(s.startedAt).toISOString(),
  }));
}

export function getDevServer(id) {
  return servers.get(String(id)) || null;
}

/** Broker-managed dev server already registered for a port (CORE-2b reuse check). */
export function getDevServerByPort(port) {
  for (const s of servers.values()) if (s.port === Number(port)) return s;
  return null;
}

function waitReady(port, child, ring, timeoutMs = 60_000, opId = null) {
  const url = `http://127.0.0.1:${port}/`;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const op = opId ? getOp(opId) : null;
      if (op && op.status !== 'running') {
        reject(err(502, 'DEVSERVER_EXITED', `dev server failed before answering: ${ring.tail().slice(-800) || 'no output'}`));
        return;
      }
      if (child.exitCode !== null) {
        reject(err(502, 'DEVSERVER_EXITED', `dev server exited (code=${child.exitCode}) before answering: ${ring.tail().slice(-800) || 'no output'}`));
        return;
      }
      const req = http.get(url, { timeout: 2_000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve(url);
          return;
        }
        retry();
      });
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - t0 > timeoutMs) {
        reject(err(504, 'DEVSERVER_TIMEOUT', `dev server did not answer ${url} within ${timeoutMs}ms: ${ring.tail().slice(-800) || 'no output'}`));
        return;
      }
      setTimeout(attempt, 300);
    };
    attempt();
  });
}

/** POST /devserver { projectDir, port } -> { devServerId, url }
 * CORE-2a (R2 H1): the `command` parameter is REMOVED — there is no caller-controlled
 * exec tier. The spawned argv is fixed: `<NODE_BIN> node_modules/vite/bin/vite.js
 * --port <port> --strictPort` (array spawn, cwd=projectDir, shell:false). */
export async function startDevServer(body = {}) {
  if (body.projectDir == null) throw err(400, 'BAD_PROJECT_DIR', 'projectDir is required');
  if (body.command !== undefined) {
    throw err(400, 'BAD_COMMAND', 'POST /devserver no longer accepts a custom command; the broker always runs the fixed vite argv');
  }
  const projectDir = validateProjectDir(body.projectDir);
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw err(400, 'BAD_PORT', 'port must be an integer in [1..65535]');
  if (getDevServerByPort(port)) throw err(409, 'PORT_IN_USE', `a broker-managed dev server already runs on port ${port}`);

  const devServerId = `dev-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const ring = makeRing(120);

  const child = spawn(NODE_BIN, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], {
    cwd: projectDir,
    windowsHide: true,
  });
  const collect = (src) => (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) ring.push(`[${src}] ${line}`);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', collect('out'));
  child.stderr.on('data', collect('err'));
  child.on('error', (e) => {
    // R1 NOTE-d: spawn failures (ENOENT etc.) must surface in the ring and fail the op
    // instead of hanging waitReady until its timeout.
    ring.push(`[spawn-error] ${String(e && e.message ? e.message : e)}`);
    const op = getOp(devServerId);
    if (op && op.status === 'running') finishOp(devServerId, { status: 'failed', exitCode: -1 });
  });
  child.on('exit', (code, signal) => {
    ring.push(`[exit] code=${code} signal=${signal || '-'}`);
    const op = getOp(devServerId);
    if (op && op.status === 'running') finishOp(devServerId, { status: 'failed', exitCode: code });
    if (servers.has(devServerId)) {
      log(`dev server ${devServerId} (port ${port}) exited (code=${code} signal=${signal || '-'})`);
      servers.delete(devServerId);
    }
  });

  const op = registerOp({
    id: devServerId,
    kind: 'devserver-start',
    meta: { projectDir, port, command: `vite --port ${port} --strictPort` },
    cancel() {
      killTree(child.pid);
    },
  });
  log(`dev server ${devServerId}: starting in ${projectDir} on port ${port} (fixed argv: node node_modules/vite/bin/vite.js --port ${port} --strictPort)`);

  try {
    const url = await waitReady(port, child, ring, 60_000, devServerId);
    finishOp(devServerId, { status: 'done' });
    servers.set(devServerId, { id: devServerId, projectDir, port, url, child, startedAt: Date.now(), ring });
    log(`dev server ${devServerId} ready at ${url}`);
    return { devServerId, url };
  } catch (e) {
    finishOp(devServerId, { status: 'failed' });
    killTree(child.pid);
    throw e;
  }
}

/** DELETE /devserver/:id -> { ok: true } */
export function stopDevServer(id) {
  const s = servers.get(String(id));
  if (!s) throw err(404, 'DEVSERVER_NOT_FOUND', `unknown dev server ${JSON.stringify(String(id))}`);
  killTree(s.child.pid);
  servers.delete(String(id));
  log(`dev server ${s.id} stopped (port ${s.port})`);
  return { ok: true, devServerId: s.id, url: s.url };
}

/** SIGINT/SIGTERM: stop every broker-managed dev server. */
export function stopAllDevServers() {
  for (const s of [...servers.values()]) {
    try {
      stopDevServer(s.id);
    } catch { /* already gone */ }
  }
}
