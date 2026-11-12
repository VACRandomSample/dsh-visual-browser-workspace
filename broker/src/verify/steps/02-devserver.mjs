/** 02 — broker-managed dev server on a FREE port (5173 is owned by another worker's vite):
 *  POST /devserver (spawn + readiness wait), GET /devserver, DELETE /devserver/:id (port freed). */
import { call, show, DEMO_APP } from './lib.mjs';

const t0 = Date.now();
const ds = await call('POST', '/devserver', { projectDir: DEMO_APP, port: 5273 });
show(`POST /devserver {projectDir: _vbw/demo-app, port: 5273} (${Date.now() - t0}ms):`, { status: ds.status, data: ds.data });
const id = ds.data.devServerId;

show('GET /devserver:', (await call('GET', '/devserver')).data);

const probe = await fetch('http://127.0.0.1:5273/@vite/client');
show('GET http://127.0.0.1:5273/@vite/client (direct probe):', { status: probe.status });

const del = await call('DELETE', `/devserver/${id}`);
show(`DELETE /devserver/${id}:`, { status: del.status, data: del.data });
await new Promise((r) => setTimeout(r, 1500));
let freed;
try {
  const r2 = await fetch('http://127.0.0.1:5273/');
  freed = `still answering (${r2.status})`;
} catch {
  freed = 'connection refused (port freed)';
}
show('port 5273 after DELETE:', freed);
