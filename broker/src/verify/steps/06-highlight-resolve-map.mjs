/** 06 — highlight (held + box + clear), elements/resolve, map-source via ref. */
import { call, show } from './lib.mjs';

const id = process.argv[2];
const ref = process.argv[3];
if (!id || !ref) {
  console.error('usage: node 06-highlight-resolve-map.mjs <sessionId> <ref>');
  process.exit(2);
}

const hl = await call('POST', `/sessions/${id}/highlight`, { refs: [ref], label: 'verify', style: 'held' });
show(`POST highlight {refs:["${ref}"], style:"held"}:`, { status: hl.status, data: hl.data });

const hlBox = await call('POST', `/sessions/${id}/highlight`, { boxes: [{ x: 40, y: 40, width: 220, height: 60 }], style: 'hit', label: 'region' });
show('POST highlight {boxes:[…], style:"hit"}:', { status: hlBox.status, data: hlBox.data });

const hlClear = await call('POST', `/sessions/${id}/highlight`, { clear: true });
show('POST highlight {clear:true}:', { status: hlClear.status, data: hlClear.data });

const res = await call('POST', `/sessions/${id}/elements/resolve`, { refs: [ref, 'no-such-ref'] });
show('POST elements/resolve {refs:[ref, "no-such-ref"]}:', { status: res.status, data: res.data });

const map = await call('POST', `/sessions/${id}/map-source`, { ref });
show(`POST map-source {ref:"${ref}"}:`, { status: map.status, data: map.data });
