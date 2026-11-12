/** 03 — create session, list/get, frame.jpg size + no-store, screenshot save-to-disk. */
import fs from 'node:fs';
import { call, show, ST } from './lib.mjs';

const mk = await call('POST', '/sessions', {
  url: 'http://127.0.0.1:5173/',
  owner: 'agent',
  viewport: { width: 1440, height: 900 },
  label: 'verify',
});
show('POST /sessions:', { status: mk.status, session: mk.data.session });
const id = mk.data.session?.id;
if (!id) process.exit(1);

show('GET /sessions:', (await call('GET', '/sessions')).data);
show(`GET /sessions/${id}:`, (await call('GET', `/sessions/${id}`)).data);

// frame.jpg — measure the raw image bytes (size evidence without dumping base64)
const res = await fetch(`${'http://127.0.0.1:' + ST.port}/sessions/${id}/frame.jpg?quality=70`, {
  headers: { authorization: `Bearer ${ST.token}` },
});
const buf = Buffer.from(await res.arrayBuffer());
show('GET frame.jpg:', {
  status: res.status,
  contentType: res.headers.get('content-type'),
  cacheControl: res.headers.get('cache-control'),
  bytes: buf.length,
});

const png = await fetch(`${'http://127.0.0.1:' + ST.port}/sessions/${id}/frame.png`, {
  headers: { authorization: `Bearer ${ST.token}` },
});
const pngBuf = Buffer.from(await png.arrayBuffer());
show('GET frame.png:', { status: png.status, contentType: png.headers.get('content-type'), bytes: pngBuf.length });

const shot = await call('POST', `/sessions/${id}/screenshot`, {
  elementSelector: '[data-testid="nav-bar"]',
  format: 'png',
  save: true,
});
const savedPath = shot.data.file ? new URL(`../../../../state/screenshots/${shot.data.file}`, import.meta.url) : null;
show('POST screenshot {elementSelector, save:true}:', {
  status: shot.status,
  file: shot.data.file,
  dataUrlPrefix: String(shot.data.dataUrl || '').slice(0, 30),
  savedBytes: savedPath ? fs.statSync(savedPath).size : null,
});

console.log(`SESSION_ID=${id}`);
