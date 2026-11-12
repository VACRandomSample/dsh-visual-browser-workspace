/** 07 — annotations: create group (element + region), pending queue, ack, empty queue after. */
import { call, show } from './lib.mjs';

const id = process.argv[2];
if (!id) {
  console.error('usage: node 07-annotations.mjs <sessionId>');
  process.exit(2);
}

const mk = await call('POST', `/sessions/${id}/annotations`, {
  context: { url: 'http://127.0.0.1:5173/catalog', viewport: { width: 1440, height: 900 }, note: 'verify transcript' },
  items: [
    { kind: 'element', selector: '[data-testid="price-current"]', comment: 'sale price too low contrast (#c9c9c9 on white)' },
    { kind: 'region', box: { x: 40, y: 200, width: 420, height: 260 }, comment: 'grid area check' },
  ],
});
show('POST /sessions/:id/annotations (no screenshots supplied -> broker captures):', {
  status: mk.status,
  groupId: mk.data.groupId,
  items: mk.data.items,
});

const pending1 = await call('GET', '/annotations/pending');
show('GET /annotations/pending (before ack):', {
  status: pending1.status,
  groups: pending1.data.groups?.map((g) => ({
    groupId: g.groupId,
    status: g.status,
    session: g.session,
    items: g.items?.map((it) => ({
      number: it.number,
      kind: it.kind,
      comment: it.comment,
      screenshotFile: it.screenshotFile,
      screenshotDataUrlLen: it.screenshot ? it.screenshot.length : null,
      meta: it.meta || undefined,
    })),
  })),
});

const ack = await call('POST', '/annotations/ack', { groupIds: [mk.data.groupId] });
show('POST /annotations/ack:', { status: ack.status, data: ack.data });

const pending2 = await call('GET', '/annotations/pending');
show('GET /annotations/pending (after ack):', { status: pending2.status, groups: pending2.data.groups });
console.log(`GROUP_ID=${mk.data.groupId}`);
