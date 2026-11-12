/** 04 — element-at on given coordinates; expects fiber source match (PriceTag.tsx). */
import { call, show } from './lib.mjs';

const id = process.argv[2];
const x = Number(process.argv[3]);
const y = Number(process.argv[4]);
if (!id || !Number.isFinite(x) || !Number.isFinite(y)) {
  console.error('usage: node 04-element-at.mjs <sessionId> <x> <y>');
  process.exit(2);
}
const r = await call('POST', `/sessions/${id}/element-at`, { x, y });
show(`POST /sessions/${id}/element-at {x:${x}, y:${y}}:`, { status: r.status, data: r.data });
