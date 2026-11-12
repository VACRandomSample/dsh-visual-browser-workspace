/** 01 — health (auth-exempt), CORS on GET, 401 shapes for missing/invalid token. */
import { call, show } from './lib.mjs';

show('health(noAuth):', await call('GET', '/health', undefined, { noAuth: true }));
show('health(noAuth, Origin header) CORS:', await call('GET', '/health', undefined, { noAuth: true, headers: { origin: 'http://127.0.0.1:31184' } }));
show('POST /sessions no token:', await call('POST', '/sessions', { url: 'http://127.0.0.1:5173/' }, { noAuth: true }));
show('POST /sessions wrong token:', await call('POST', '/sessions', { url: 'http://127.0.0.1:5173/' }, { headers: { authorization: 'Bearer wrong-token-value' } }));
show('GET /sessions no token:', await call('GET', '/sessions', undefined, { noAuth: true }));
