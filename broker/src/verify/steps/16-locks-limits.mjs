/** 16 — locks (steal requires takeOver), 410 for closed sessions, SESSION_LIMIT cap. */
import { call, show } from './lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: node 16-locks-limits.mjs <sessionId>');
  process.exit(2);
}

const l1 = await call('POST', `/sessions/${id}/lock`, { owner: 'user' });
show('lock {owner:"user"} (steal from agent without takeOver -> expect 409):', { status: l1.status, error: l1.data.error });
const l2 = await call('POST', `/sessions/${id}/lock`, { owner: 'user', takeOver: true });
show('lock {owner:"user", takeOver:true} (steal -> expect takeover:true):', { status: l2.status, data: l2.data });
const l3 = await call('POST', `/sessions/${id}/unlock`, { owner: 'user' });
show('unlock {owner:"user"}:', { status: l3.status, data: l3.data });
const l4 = await call('POST', `/sessions/${id}/lock`, { owner: 'agent' });
show('lock {owner:"agent"} (back to agent):', { status: l4.status, data: l4.data });

// DELETE by non-owner -> 409; force=1 as agent -> closes
const del = await call('DELETE', `/sessions/${id}?`, undefined, { headers: { 'x-vbw-owner': 'user' } });
show('DELETE as owner "user" (session owned by agent -> expect 409):', { status: del.status, error: del.data.error });
const delf = await call('DELETE', `/sessions/${id}?force=1`, undefined, { headers: { 'x-vbw-owner': 'agent' } });
show('DELETE ?force=1 as owner "agent":', { status: delf.status, data: delf.data });
const g404 = await call('GET', `/sessions/${id}`);
show(`GET /sessions/${id} (closed -> expect 410):`, { status: g404.status, error: g404.data.error });

// SESSION_LIMIT: open sessions until the cap refuses
const made = [];
for (let i = 0; i < 5; i++) {
  const r = await call('POST', '/sessions', { owner: 'limit-probe' });
  if (r.status === 201) {
    made.push(r.data.session.id);
    show(`  session ${i + 1}:`, { id: r.data.session.id });
  } else {
    show(`  session ${i + 1}:`, { status: r.status, error: r.data.error });
    break;
  }
}
for (const sid of made) await call('DELETE', `/sessions/${sid}`);
show('cleaned up limit-probe sessions:', made.length);
