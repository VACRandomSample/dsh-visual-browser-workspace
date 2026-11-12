// VBW host plugin — broker discovery, spawn, and thin HTTP proxy helpers.
//
// Broker contract: _vbw\specs\broker-api.md — base http://127.0.0.1:8931
// (env VBW_BROKER_PORT), `Authorization: Bearer <token>` on everything except
// GET /health, errors `{ error: { code, message } }`. Connection facts
// (port/token/pid) live in _vbw\state\broker.json, written by the broker at
// startup.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundled Harness node on this machine (desktop runtime layout, win32). */
const BUNDLED_NODE_WIN32 = 'D:\\Programs\\Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';
const DEFAULT_BROKER_PORT = 8931;
const BUNDLE_PACKAGE_NAME = '@local/vbw-bundle';

/** Structured broker/tool error surfaced through the tool pipeline. */
export class BrokerError extends Error {
	constructor(message, { status, code, body } = {}) {
		super(message);
		this.name = 'BrokerError';
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

function isAbortError(error) {
	return error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Rethrow cancellation as an AbortError-shaped failure the pipeline expects. */
export function abortError() {
	const error = new Error('This operation was aborted');
	error.name = 'AbortError';
	return error;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw signal.reason ?? abortError();
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(signal.reason ?? abortError());
		}, { once: true });
	});
}

/**
 * Locate the bundle root (@local/vbw-bundle) by walking up from this module
 * file; used to resolve the default relative brokerRoot / stateFile paths.
 */
export function bundleRootFor(moduleUrl) {
	let dir = path.dirname(fileURLToPath(moduleUrl));
	for (let depth = 0; depth < 8; depth += 1) {
		const manifest = path.join(dir, 'package.json');
		if (existsSync(manifest)) {
			try {
				const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
				if (pkg?.name === BUNDLE_PACKAGE_NAME) return dir;
			} catch {
				// unreadable manifest — keep walking
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback: …/packages/vbw-host/lib → three levels up is the bundle root.
	return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
}

function resolveAbsolute(base, candidate) {
	return path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);
}

/**
 * SEC-2: the discovery state file lives OUTSIDE any OneDrive-synced workspace —
 * default `%LOCALAPPDATA%\vbw\state\broker.json` (env VBW_STATE_DIR moves the
 * directory; an explicit `stateFile` config wins). Must match the broker's
 * `config.mjs` default exactly.
 */
function defaultLocalStateFile() {
	const localAppData = process.env.VBW_STATE_DIR
		? path.resolve(process.env.VBW_STATE_DIR)
		: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'vbw', 'state');
	return path.join(localAppData, 'broker.json');
}

/** Materialize effective config with defaults resolved against the bundle root. */
export function resolveConfig(config, moduleUrl) {
	const bundleRoot = bundleRootFor(moduleUrl);
	const merged = {
		brokerRoot: '..\\broker',
		autoSpawn: true,
		...config
	};
	return {
		bundleRoot,
		brokerRoot: resolveAbsolute(bundleRoot, merged.brokerRoot),
		autoSpawn: merged.autoSpawn !== false,
		stateFile: merged.stateFile ? resolveAbsolute(bundleRoot, merged.stateFile) : defaultLocalStateFile(),
		nodePath: merged.nodePath
			? resolveAbsolute(bundleRoot, merged.nodePath)
			: (process.platform === 'win32' && existsSync(BUNDLED_NODE_WIN32) ? BUNDLED_NODE_WIN32 : process.execPath),
		requestTimeoutMs: merged.requestTimeoutMs ?? 30000,
		spawnWaitMs: merged.spawnWaitMs ?? 20000,
		testPollIntervalMs: merged.testPollIntervalMs ?? 2000,
		testMaxWaitMs: merged.testMaxWaitMs ?? 600000
	};
}

/** Read _vbw\state\broker.json → { port, token, pid } | null. */
export async function readState(stateFile) {
	try {
		const raw = await fs.readFile(stateFile, 'utf8');
		const state = JSON.parse(raw);
		if (state && typeof state.port === 'number') return state;
		return null;
	} catch {
		return null;
	}
}

/** pid liveness probe (signal 0). */
export function pidAlive(pid) {
	if (typeof pid !== 'number' || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** GET /health probe; resolves the health body or null. */
export async function probeHealth(port, timeoutMs = 1500, signal) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason ?? abortError());
	signal?.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException('health probe timed out', 'TimeoutError')), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
		if (!response.ok) return null;
		return await response.json();
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? abortError();
		return null;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * Ensure the broker is up: reuse the state file's broker when healthy, wait
 * out a still-starting pid, or (autoSpawn) launch `node src/server.mjs` in
 * brokerRoot with the bundled node and wait for /health. Never kills a broker
 * it did not spawn; the broker stays a standalone service (rollback = remove
 * the profile lines + kill by the pid recorded in the state file).
 */
export async function ensureBroker(cfg, signal) {
	throwIfAborted(signal);
	let state = await readState(cfg.stateFile);
	if (state?.port !== undefined) {
		const healthy = await probeHealth(state.port, 1500, signal);
		if (healthy) return { port: state.port, token: typeof state.token === 'string' ? state.token : '', baseUrl: `http://127.0.0.1:${state.port}`, spawned: false };
	}
	if (state?.pid !== undefined && pidAlive(state.pid)) {
		// Process alive but not answering yet — still starting up.
		const port = state.port ?? DEFAULT_BROKER_PORT;
		const healthy = await waitForHealth(port, cfg.spawnWaitMs, cfg, signal);
		if (healthy) return { port, token: typeof state.token === 'string' ? state.token : '', baseUrl: `http://127.0.0.1:${port}`, spawned: false };
	}
	if (!cfg.autoSpawn) {
		throw new BrokerError(`VBW broker is not reachable (state file: ${cfg.stateFile}) and autoSpawn is false. Start it: node src/server.mjs in ${cfg.brokerRoot}.`);
	}
	const entryExists = existsSync(path.join(cfg.brokerRoot, 'src', 'server.mjs'));
	if (!entryExists) {
		throw new BrokerError(`VBW broker entry is missing: ${path.join(cfg.brokerRoot, 'src', 'server.mjs')} cannot be found; the broker component is not built/installed yet.`);
	}
	const child = spawn(cfg.nodePath, ['src/server.mjs'], {
		cwd: cfg.brokerRoot,
		stdio: 'ignore',
		env: { ...process.env },
		windowsHide: true
	});
	child.on('error', () => { /* surfaced via the health wait below */ });
	let exitFailure = null;
	child.on('exit', (code) => {
		if (code !== 0 && code !== null) exitFailure = code;
	});
	const deadline = Date.now() + cfg.spawnWaitMs;
	let port = state?.port ?? DEFAULT_BROKER_PORT;
	try {
		while (Date.now() < deadline) {
			throwIfAborted(signal);
			const latest = await readState(cfg.stateFile);
			if (latest?.port !== undefined) port = latest.port;
			const healthy = await probeHealth(port, 1000, signal);
			if (healthy) {
				const final = await readState(cfg.stateFile);
				return {
					port,
					token: typeof final?.token === 'string' ? final.token : '',
					baseUrl: `http://127.0.0.1:${port}`,
					spawned: true
				};
			}
			if (exitFailure !== null) break;
			await sleep(500, signal);
		}
	} finally {
		child.removeAllListeners('exit');
		child.removeAllListeners('error');
	}
	throw new BrokerError(`VBW broker did not become healthy within ${cfg.spawnWaitMs} ms${exitFailure !== null ? ` (spawned node exited with code ${exitFailure})` : ''}. Check: node src/server.mjs in ${cfg.brokerRoot}.`);
}

async function waitForHealth(port, waitMs, cfg, signal) {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const healthy = await probeHealth(port, 1000, signal);
		if (healthy) return healthy;
		await sleep(500, signal);
	}
	return null;
}

/**
 * Authenticated broker request with cooperative cancellation (exec.signal) and
 * a per-request timeout. Parses JSON; non-2xx becomes a BrokerError carrying
 * the broker's `{ error: { code, message } }` shape.
 */
export async function brokerRequest(cfg, route, { method = 'GET', body, signal, timeoutMs } = {}) {
	const { baseUrl, token } = await ensureBroker(cfg, signal);
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason ?? abortError());
	if (signal) {
		if (signal.aborted) throw signal.reason ?? abortError();
		signal.addEventListener('abort', onAbort, { once: true });
	}
	const limit = timeoutMs ?? cfg.requestTimeoutMs;
	const timer = setTimeout(() => controller.abort(new DOMException(`broker request timed out after ${limit} ms`, 'TimeoutError')), limit);
	try {
		const response = await fetch(`${baseUrl}${route}`, {
			method,
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {})
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal
		});
		const text = await response.text();
		let payload = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			payload = { raw: text };
		}
		if (!response.ok) {
			throw new BrokerError(`${method} ${route} failed (${response.status}): ${payload?.error?.message ?? payload?.raw ?? response.statusText}`, {
				status: response.status,
				code: payload?.error?.code,
				body: payload
			});
		}
		return payload;
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? abortError();
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}
}

/**
 * Resolve the target session: the explicit id, else the most recently used
 * agent-owned session (SEC-1: the fallback NEVER targets a user-owned session —
 * those are behind the ownership gates). No sessionId + no agent session is a
 * clear error telling the caller to open one.
 */
export async function resolveSessionId(cfg, sessionId, signal) {
	if (sessionId) return sessionId;
	const listing = await brokerRequest(cfg, '/sessions', { signal });
	const sessions = Array.isArray(listing?.sessions) ? listing.sessions.filter((session) => session.status !== 'closed') : [];
	const byRecency = (a, b) => String(b.lastOpAt ?? b.createdAt ?? '').localeCompare(String(a.lastOpAt ?? a.createdAt ?? ''));
	const agentSessions = sessions.filter((session) => session.owner === 'agent').sort(byRecency);
	if (agentSessions.length === 0) {
		throw new BrokerError('no agent-owned browser session — call vbw_session_open first (or pass the sessionId of a session you own; user-owned sessions are never auto-targeted)');
	}
	return agentSessions[0].id;
}
