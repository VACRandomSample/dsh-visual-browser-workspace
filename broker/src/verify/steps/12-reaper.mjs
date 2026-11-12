/**
 * 12 — idle reaper evidence: spawns a SECOND broker instance on 8932 with
 * VBW_SESSION_IDLE_MS=3000 and its own temp state file (main broker state untouched),
 * creates a session, waits for the reaper to close it, then shuts the instance down.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brokerRoot = fileURLToPath(new URL('../../..', import.meta.url)); // _vbw/broker
const tmpState = path.join(brokerRoot, 'src', 'verify', 'steps', 'tmp-reaper-state.json');
try { fs.unlinkSync(tmpState); } catch { /* not there */ }

const nodeBin = process.execPath;
const child = spawn(nodeBin, ['src/server.mjs'], {
  cwd: brokerRoot,
  env: {
    ...process.env,
    VBW_BROKER_PORT: '8932',
    VBW_SESSION_IDLE_MS: '3000',
    VBW_REAPER_INTERVAL_MS: '1000',
    VBW_STATE_FILE: tmpState,
  },
  windowsHide: true,
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
const logs = [];
child.stdout.on('data', (d) => logs.push(...String(d).split('\n').filter((l) => l.trim())));
child.stderr.on('data', (d) => logs.push(...String(d).split('\n').filter((l) => l.trim()).map((l) => `[stderr] ${l}`)));

try {
  // wait for the instance to write its state file
  let st = null;
  for (let i = 0; i < 50 && !st; i++) {
    await sleep(200);
    try { st = JSON.parse(fs.readFileSync(tmpState, 'utf8')); } catch { /* retry */ }
  }
  if (!st) throw new Error('reaper-test broker did not write its state file');
  console.log('reaper-test instance state:', { port: st.port, pid: st.pid, tokenHidden: true, channel: st.channel });

  const base = `http://127.0.0.1:${st.port}`;
  const auth = { authorization: `Bearer ${st.token}`, 'content-type': 'application/json' };
  const res = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ url: 'http://127.0.0.1:5173/', owner: 'verify' }),
  });
  const created = await res.json();
  console.log('created session response:', { status: res.status, body: created });

  const t0 = Date.now();
  let observed = null;
  for (;;) {
    await sleep(500);
    const list = await (await fetch(`${base}/sessions`, { headers: auth })).json();
    const s = list.sessions.find((x) => x.id === created.session.id);
    if (s && s.status === 'closed') { observed = { afterMs: Date.now() - t0, session: s }; break; }
    if (Date.now() - t0 > 20_000) { observed = { timeout: true, session: s }; break; }
  }
  console.log('observation of session lifecycle:', observed);
  console.log('instance log (idle reaper lines):', logs.filter((l) => l.includes('reaper')).slice(0, 4));
} finally {
  // NOTE: on Windows, process.kill(pid, 'SIGTERM') from another process is TerminateProcess —
  // Node cannot deliver a graceful signal cross-platform here. The graceful SIGINT/SIGTERM
  // path itself (close contexts + writeStoppedState) is exercised in 13-shutdown.mjs
  // in-process; this instance is therefore just terminated and its state file removed.
  child.kill('SIGTERM');
  await sleep(2_000);
  let afterKill = null;
  try { afterKill = JSON.parse(fs.readFileSync(tmpState, 'utf8')); } catch { /* gone */ }
  console.log('after TerminateProcess, temp state file pid field (expected stale, unmanaged):', afterKill?.pid);
  try { fs.unlinkSync(tmpState); console.log('temp state file removed:', true); } catch { console.log('temp state file removed:', false); }
}
