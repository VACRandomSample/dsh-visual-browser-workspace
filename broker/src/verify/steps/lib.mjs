/** Shared helper for the verify step scripts: reads token from state, never prints it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// this file: _vbw/broker/src/verify/steps/lib.mjs
export const VBW_DIR = fileURLToPath(new URL('../../../../', import.meta.url)); // _vbw/
// SEC-2: discovery state file default moved to %LOCALAPPDATA%\vbw\state\broker.json
// (VBW_STATE_DIR moves it); the old workspace path is a transition fallback ONLY.
const localStateDir = process.env.VBW_STATE_DIR
  ? path.resolve(process.env.VBW_STATE_DIR)
  : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'vbw', 'state');
const stateFile = fs.existsSync(path.join(localStateDir, 'broker.json'))
  ? path.join(localStateDir, 'broker.json')
  : path.join(VBW_DIR, 'state', 'broker.json');
export const ST = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
export const BASE = `http://127.0.0.1:${ST.port}`;
export const DEMO_APP = fileURLToPath(new URL('../../../../demo-app/', import.meta.url)).replace(/\\$/, '');

export async function call(method, path, body, opts = {}) {
  const headers = {
    ...(opts.noAuth ? {} : { authorization: `Bearer ${ST.token}` }),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers || {}), // last: lets a step deliberately override (e.g. wrong token)
  };
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = `${text.slice(0, 120)}…(${text.length} bytes)`;
  }
  return { status: res.status, cors: res.headers.get('access-control-allow-origin') || '-', opId: res.headers.get('x-vbw-op-id') || '-', data };
}

export function show(label, value) {
  console.log(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}
