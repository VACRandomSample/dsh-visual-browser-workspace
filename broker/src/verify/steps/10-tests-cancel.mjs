/** 10 — tests/run: cancel proof on a first run, then a full run with parsed summary. */
import { call, show } from './lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = await call('POST', '/tests/run', { projectDir: process.argv[2] });
show('POST /tests/run (cancel proof):', { status: c.status, data: c.data });
await sleep(6_000);
const k = await call('POST', `/ops/${c.data.runId}/cancel`);
show(`POST /ops/${c.data.runId}/cancel:`, { status: k.status, data: k.data });
await sleep(3_000);
const g = await call('GET', `/tests/runs/${c.data.runId}`);
show(`GET /tests/runs/${c.data.runId} (after cancel):`, {
  status: g.status,
  runId: g.data.runId,
  runStatus: g.data.status,
  exitCode: g.data.exitCode,
  logTailHead: String(g.data.logTail || '').split('\n').slice(-3),
});

const r = await call('POST', '/tests/run', { projectDir: process.argv[2] });
show('POST /tests/run (full):', { status: r.status, data: r.data });
const runId = r.data.runId;
let last = null;
const t0 = Date.now();
for (;;) {
  await sleep(3_000);
  last = await call('GET', `/tests/runs/${runId}`);
  if (last.data.status !== 'running') break;
  if (Date.now() - t0 > 420_000) break;
}
show(`GET /tests/runs/${runId} (final):`, {
  httpStatus: last.status,
  runId: last.data.runId,
  status: last.data.status,
  exitCode: last.data.exitCode,
  summary: last.data.summary,
  reportDir: last.data.reportDir,
  traceDir: last.data.traceDir,
  logTailLastLines: String(last.data.logTail || '').split('\n').slice(-6),
});
