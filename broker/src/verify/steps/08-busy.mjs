/** 08 — op-lock: parallel mutations on one session -> 409 SESSION_BUSY; reader during mutation -> 409. */
import { call, show } from './lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: node 08-busy.mjs <sessionId>');
  process.exit(2);
}

// fire the long mutation first, wait until it holds the lock, then race a reader and
// another mutation against it -> both must get 409 SESSION_BUSY
const first = call('POST', `/sessions/${id}/navigate`, { url: 'http://127.0.0.1:5173/catalog', waitUntil: 'networkidle' });
await new Promise((r) => setTimeout(r, 150));
const rest = await Promise.all([
  call('POST', `/sessions/${id}/navigate`, { url: 'http://127.0.0.1:5173/', waitUntil: 'networkidle' }),
  call('POST', `/sessions/${id}/input`, { op: 'click', x: 100, y: 100 }),
  call('GET', `/sessions/${id}/frame.jpg`),
]);
const f = await first;
show('  navigate#1 (networkidle):', { status: f.status, url: f.data.url, title: f.data.title });
const labels = ['navigate#2 (networkidle)', 'input click', 'GET frame.jpg (reader, fired mid-mutation)'];
rest.forEach((r, i) => show(`  ${labels[i]}:`, { status: r.status, data: r.data.error || (r.status === 200 ? '(bytes ok)' : r.data) }));
