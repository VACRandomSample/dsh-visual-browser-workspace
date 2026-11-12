/** 09 — URL allowlist: file:/ftp:/data:, credentials, broker self-origin, DSH GUI origin. */
import { call, show } from './lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: node 09-url-guard.mjs <sessionId>');
  process.exit(2);
}

const cases = [
  ['file:///C:/Windows/win.ini', 'file: scheme'],
  ['ftp://127.0.0.1/pub', 'ftp: scheme'],
  ['data:text/html,<h1>hi</h1>', 'data: scheme'],
  ['http://user:pass@127.0.0.1:5173/', 'embedded credentials'],
  ['http://127.0.0.1:8931/ui', 'broker own origin'],
  ['http://localhost:8931/health', 'broker own origin (localhost)'],
  ['http://127.0.0.1:31184/', 'DSH GUI origin (blocked list)'],
];
for (const [url, why] of cases) {
  const r = await call('POST', `/sessions/${id}/navigate`, { url });
  show(`navigate ${why}:`, { status: r.status, error: r.data.error });
}

const ok = await call('POST', `/sessions/${id}/navigate`, { url: 'http://127.0.0.1:5173/' });
show('navigate https target still allowed:', { status: ok.status, url: ok.data.url, title: ok.data.title });
