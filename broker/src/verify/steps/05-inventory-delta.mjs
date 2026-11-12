/** 05 — navigate to /catalog, read-text paging, inventory delta (2nd call must be empty delta). */
import { call, show } from './lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: node 05-inventory-delta.mjs <sessionId>');
  process.exit(2);
}

const nav = await call('POST', `/sessions/${id}/navigate`, { url: 'http://127.0.0.1:5173/catalog', waitUntil: 'networkidle' });
show('POST navigate /catalog (networkidle):', { status: nav.status, data: nav.data, opId: nav.opId });
if (nav.status !== 200) process.exit(3);

const rt = await call('POST', `/sessions/${id}/read-text`, { start: 0, count: 400 });
show('POST read-text {start:0,count:400}:', {
  status: rt.status,
  url: rt.data.url,
  start: rt.data.start,
  end: rt.data.end,
  totalChars: rt.data.totalChars,
  redactions: rt.data.redactions,
  textHead: String(rt.data.text || '').slice(0, 160).replace(/\s+/g, ' '),
});

const inv1 = await call('POST', `/sessions/${id}/inventory`, {});
const first = inv1.data;
show('POST inventory #1:', {
  status: inv1.status,
  url: first.url,
  elementCount: first.elements?.length,
  retired: first.retired,
  delta: first.delta,
  redactions: first.redactions,
  firstThreeElements: first.elements?.slice(0, 3),
});

const inv2 = await call('POST', `/sessions/${id}/inventory`, {});
const second = inv2.data;
show('POST inventory #2 (expect delta empty, same=N):', {
  status: inv2.status,
  elementCount: second.elements?.length,
  delta: second.delta,
});

const inv3 = await call('POST', `/sessions/${id}/inventory`, { max: 300 });
show('POST inventory {max:300} (cap clamp 120):', { elementCount: inv3.data.elements?.length });
console.log(`FIRST_INV_REFS=${first.elements?.slice(0, 6).map((e) => e.ref).join(',')}`);
