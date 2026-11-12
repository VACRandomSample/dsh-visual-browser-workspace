import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const BROKER_ROOT = path.resolve(here, '..');
// VBW workspaces live under <workspace>/_vbw
export const VBW_ROOT = path.resolve(BROKER_ROOT, '..');
export const WORKSPACE_ROOT = path.resolve(VBW_ROOT, '..');
// Workspace state dir: ARTIFACTS ONLY (screenshots, annotations, test-runs, logs —
// workspace evidence). The discovery state file lives outside it (SEC-2).
export const STATE_DIR = path.join(VBW_ROOT, 'state');
export const SHOTS_DIR = path.join(STATE_DIR, 'screenshots');
export const ANN_DIR = path.join(STATE_DIR, 'annotations');
export const ANN_FILES_DIR = path.join(ANN_DIR, 'files');
export const LOGS_DIR = path.join(STATE_DIR, 'logs');
export const TEST_RUNS_DIR = path.join(STATE_DIR, 'test-runs');
export const PUBLIC_DIR = path.join(BROKER_ROOT, 'public');
// Discovery state file (port/pid/token): NEVER in a OneDrive-synced workspace
// (SEC-2) — default `%LOCALAPPDATA%\vbw\state\broker.json`. `VBW_STATE_DIR`
// moves the whole directory; `VBW_STATE_FILE` (test instances) still wins.
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const STATE_DIR_LOCAL = process.env.VBW_STATE_DIR
  ? path.resolve(process.env.VBW_STATE_DIR)
  : path.join(LOCAL_APP_DATA, 'vbw', 'state');
export const STATE_FILE = process.env.VBW_STATE_FILE
  ? path.resolve(process.env.VBW_STATE_FILE)
  : path.join(STATE_DIR_LOCAL, 'broker.json');

export const VERSION = '0.1.0';

// Bundled toolchain used to spawn children (Playwright test runner, vite dev servers).
// The broker itself is expected to run under the bundled node, so process.execPath is
// the bundled node unless VBW_NODE_BIN says otherwise.
export const NODE_BIN = process.env.VBW_NODE_BIN || process.execPath;

function findPnpmCjs() {
  if (process.env.VBW_PNPM_CJS) return process.env.VBW_PNPM_CJS;
  // <nodeDir> = .../dependencies/node/bin -> .../dependencies/pnpm/bin/pnpm.cjs
  const candidate = path.resolve(path.dirname(process.execPath), '../../pnpm/bin/pnpm.cjs');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* fall through */
  }
  return 'pnpm.cjs'; // last resort: resolve from PATH
}

export const PNPM_CJS = findPnpmCjs();

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const DEFAULTS = {
  host: '127.0.0.1', // never exposed beyond loopback (also enforced per-request)
  port: numEnv('VBW_BROKER_PORT', 8931),
  maxSessions: numEnv('VBW_MAX_SESSIONS', 4),
  sessionIdleTimeoutMs: numEnv('VBW_SESSION_IDLE_MS', 30 * 60 * 1000),
  reaperIntervalMs: numEnv('VBW_REAPER_INTERVAL_MS', 5_000),
  headless: process.env.VBW_HEADLESS !== '0',
  frameQuality: numEnv('VBW_FRAME_QUALITY', 70),
  channel: process.env.VBW_BROWSER_CHANNEL || 'chrome',
  inventoryCap: 120, // spec: agent inventory cap (Hermes act-in-page cap)
  overlayCap: 600, // spec: overlay marks cap (on-screen field)
  bodyLimitBytes: 32 * 1024 * 1024, // screenshot dataUrls can be large
  logTailLines: 400,
  // origins the driven browser may never navigate to (broker self-origin is always
  // refused separately, computed from the actual port). Default: the live DSH GUI.
  blockedOrigins: (process.env.VBW_BLOCKED_ORIGINS
    ? process.env.VBW_BLOCKED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://127.0.0.1:31184', 'http://localhost:31184']),
  // project root override for the source mapper; otherwise inferred from the dev server
  projectRoot: process.env.VBW_PROJECT_ROOT || null,
};

export function ensureDirs() {
  // STATE_DIR_LOCAL holds the discovery state file; STATE_DIR keeps the artifacts.
  for (const d of [STATE_DIR_LOCAL, STATE_DIR, SHOTS_DIR, ANN_DIR, ANN_FILES_DIR, LOGS_DIR, TEST_RUNS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function writeState(obj) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

/** Exact state rewrite the SIGINT/SIGTERM handler performs: pid + token cleared (stale lock). */
export function writeStoppedState({ port, channel }) {
  writeState({
    version: VERSION,
    port,
    pid: null,
    token: null,
    channel,
    stoppedAt: new Date().toISOString(),
  });
}

export function log(...args) {
  console.log(`[vbw-broker ${new Date().toISOString()}]`, ...args);
}

export function logErr(...args) {
  console.error(`[vbw-broker ${new Date().toISOString()}]`, ...args);
}

/**
 * Strict loopback check for req.socket.remoteAddress. Only 127.0.0.0/8, ::1 and the
 * IPv4-mapped ::ffff:127.x forms count. A hostname is never a remoteAddress, so it
 * cannot qualify.
 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string' || addr === '') return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  if (a === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}
