/** 02b — start the broker-managed dev server on 5173 and KEEP it for the remaining steps
 *  (the /tests/run flow expects the server there with VBW_NO_WEBSERVER=1). */
import { call, show, DEMO_APP } from './lib.mjs';

const t0 = Date.now();
const ds = await call('POST', '/devserver', { projectDir: DEMO_APP, port: 5173 });
show(`POST /devserver {projectDir: _vbw/demo-app, port: 5173} (${Date.now() - t0}ms):`, { status: ds.status, data: ds.data });
const probe = await fetch('http://127.0.0.1:5173/');
show('GET http://127.0.0.1:5173/ (direct probe):', { status: probe.status });
console.log(`DEVSERVER_ID=${ds.data.devServerId}`);
