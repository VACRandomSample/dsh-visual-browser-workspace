/**
 * 13 — graceful shutdown logic, exercised in-process (the exact functions the SIGINT/SIGTERM
 * handlers in server.mjs call): SessionManager.shutdown() closes contexts + browser, and
 * writeStoppedState() clears pid/token from the state file (using a temp state file so the
 * live broker's discovery state is untouched).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.VBW_STATE_FILE = path.join(fileURLToPath(new URL('.', import.meta.url)), 'tmp-shutdown-state.json');
const { SessionManager } = await import('../../sessions.mjs');
const { writeState, writeStoppedState, STATE_FILE, DEFAULTS } = await import('../../config.mjs');

const mgr = new SessionManager({ ...DEFAULTS, port: 0, blockedOrigins: [], headless: true });
writeState({ version: '0.1.0', port: 8933, pid: process.pid, token: 'not-a-real-token-for-verify', channel: 'chrome', startedAt: new Date().toISOString() });
console.log('state before shutdown:', { ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')), token: '<hidden>' });

const s = await mgr.createSession({ url: 'http://127.0.0.1:5173/', owner: 'verify' });
console.log('session created:', { id: s.id, hasContext: !!s.context, hasPage: !!s.page });

await mgr.shutdown();
console.log('after manager.shutdown():', { context: s.context, page: s.page, browser: mgr.browser, status: s.status });

writeStoppedState({ port: 8933, channel: 'chrome' });
const after = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
console.log('state after writeStoppedState():', after);

try { fs.unlinkSync(STATE_FILE); console.log('temp state file removed:', true); } catch { console.log('temp state file removed:', false); }
process.exit(0);
