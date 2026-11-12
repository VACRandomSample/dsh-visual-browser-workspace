/*
  VBW Visual Browser UI — app.js
  =====================================================================
  What this is:
    All behavior of the Visual Browser single-page app served by the
    VBW broker at /ui. Vanilla JS ES module, no build step, no external
    assets. Consumes the broker REST API (see _vbw\specs\broker-api.md).

  Responsibilities:
    1. Frame view    — poll GET /sessions/:id/frame.jpg (~6 fps, 1 fps
                       when the tab is hidden), draw 1:1 at the broker
                       viewport size, letterbox on resize, and map
                       pointer coordinates back to viewport space.
    2. Sessions      — picker (GET /sessions), creation with start URL
                       (POST /sessions owner:'user'), per-owner locking
                       with explicit takeover confirmation, unlock on
                       tab close (fetch keepalive).
    3. Navigation    — URL bar with Go / Back / Reload.
    4. Input         — Browse mode forwards pointer + keyboard events
                       (move/down/up/dblclick/wheel/key/type) with
                       viewport-relative coordinates; preventDefault
                       only while the canvas is focused.
    5. Annotate      — Hover mode (throttled /element-at + highlight +
                       tooltip), Select mode (click → pinned numbered
                       comment with safe metadata, optional region
                       shot), Region mode (marquee → /screenshot clip).
    6. Delivery      — "Send to orchestrator" groups all pins into
                       POST /sessions/:id/annotations; pending-count
                       badge via GET /annotations/pending.
    7. Test runner   — POST /tests/run + GET /tests/runs/:id polling +
                       POST /ops/:id/cancel.
    8. Health        — status dot via GET /health every 5 s.

  Security notes:
    - The broker token lives only in localStorage (vbw.brokerToken) and
      is sent as a bearer header. Never rendered or logged. The old
      ?token=… URL handoff is REMOVED (legacy URLs are stripped via
      history.replaceState; the query token is never persisted).
    - Every API call identifies as owner "user" (X-VBW-Owner) and is
      subject to the broker's session-ownership gates (SEC-1).
    - Pin cards render only a whitelist of safe metadata fields; an
      element's input value is never displayed even if a future broker
      erroneously included one.
    - All page-derived strings are inserted with textContent (no HTML
      injection from the driven page).

  Test hook:
    window.__vbwTest exposes read-only introspection used by
    _vbw\broker\ui-tests\ui.spec.mjs (no secrets exposed).
*/

/* ------------------------------------------------------------------ */
/* constants & state                                                   */
/* ------------------------------------------------------------------ */

const OWNER = 'user';
const TOKEN_KEY = 'vbw.brokerToken';
const FRAME_INTERVAL_MS = 160;   // ~6 fps while visible
const FRAME_INTERVAL_HIDDEN_MS = 1000; // back-off when tab hidden
const INPUT_MOVE_HZ = 33;        // ms between forwarded pointermove ops
const HOVER_HZ = 33;             // ~30 Hz element-at throttle
const SESSION_POLL_MS = 1500;
const LIST_POLL_MS = 4000;
const HEALTH_POLL_MS = 5000;
const PENDING_POLL_MS = 5000;
const RUN_POLL_MS = 1000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

const $ = (id) => document.getElementById(id);

const state = {
  base: location.origin,
  token: '',
  sessions: [],
  session: null,          // last GET /sessions/:id payload
  sessionId: null,
  lockOwned: false,
  viewport: { ...DEFAULT_VIEWPORT },
  hasFrame: false,
  mode: 'browse',
  pins: [],               // { number, kind, ref, box, meta, source, confidence, comment, thumb, status, card }
  pinSeq: 1,
  hover: null,            // { box, element, source, confidence }
  marquee: null,          // { x0, y0, x1, y1 } viewport coords while dragging
  authFail: false,
  runId: null,
  runTimer: 0,
  lastGroupId: null,
};

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || ('HTTP ' + status));
    this.name = 'ApiError';
    this.status = status;
    this.code = code || ('HTTP_' + status);
  }
}

function authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (state.token) h['Authorization'] = 'Bearer ' + state.token;
  // SEC-1: the UI identifies itself as owner "user" on every call so the broker's
  // session-ownership gates accept it (lock takeover is explicit, see attachToSession).
  h['X-VBW-Owner'] = OWNER;
  return h;
}

async function api(method, path, body, opts = {}) {
  const init = {
    method,
    headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    ...opts,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(state.base + path, init);
  } catch (e) {
    throw new ApiError(0, 'NETWORK', 'network error: ' + (e && e.message ? e.message : e));
  }
  if (res.status === 401) {
    setAuthFail(true);
    throw new ApiError(401, 'UNAUTHORIZED', 'not authorized — check the broker token');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(res.status, err.code, err.message || ('HTTP ' + res.status + (text ? ' ' + text.slice(0, 120) : '')));
  }
  return data;
}

/* op-lock courtesy: on 409 SESSION_BUSY back off ~300 ms and retry (API contract) */
async function apiRetry409(method, path, body, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await api(method, path, body);
    } catch (e) {
      if (e && e.status === 409 && i < tries - 1) {
        await sleep(300);
        continue;
      }
      throw e;
    }
  }
}

function toast(msg, kind = 'info', ttl = 4500) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.dataset.testid = 'toast';
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), ttl);
  return t;
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // other schemes: let the broker validate
  return 'http://' + u;
}

/* ------------------------------------------------------------------ */
/* status dot / auth hint                                              */
/* ------------------------------------------------------------------ */

function setBrokerUp(up, note) {
  const dot = $('status-dot');
  if (state.authFail && up) {
    dot.className = 'dot warn';
    dot.setAttribute('aria-label', 'Broker status: unauthorized');
    $('status-text').textContent = 'unauthorized';
  } else {
    dot.className = 'dot ' + (up ? 'ok' : 'down');
    dot.setAttribute('aria-label', 'Broker status: ' + (up ? 'up' : 'down'));
    $('status-text').textContent = note || (up ? 'broker up' : 'broker down');
  }
}

function setAuthFail(v) {
  state.authFail = v;
  $('auth-hint').classList.toggle('show', v);
  if (!v) return;
  setBrokerUp(true);
}

/* ------------------------------------------------------------------ */
/* health / pending / listings polling                                 */
/* ------------------------------------------------------------------ */

async function pollHealth() {
  try {
    const res = await fetch(state.base + '/health', { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    setBrokerUp(!!(data && data.ok), data ? `v${data.version} · ${data.sessions} session(s)` : 'unhealthy');
    if (!data) state.authFail = state.authFail; /* keep */
  } catch {
    setBrokerUp(false);
  }
}

async function pollPending() {
  try {
    const r = await api('GET', '/annotations/pending');
    const groups = (r && r.groups) || [];
    const badge = $('pending-badge');
    badge.hidden = false;
    badge.textContent = 'pending: ' + groups.length;
    if (state.lastGroupId && groups.some((g) => (g.groupId ?? g.id) === state.lastGroupId)) {
      badge.title = `group ${state.lastGroupId} is awaiting the orchestrator`;
    }
  } catch { /* unreachable broker or auth — health dot covers it */ }
}

async function pollSessions() {
  let r;
  try { r = await api('GET', '/sessions'); }
  catch { return; }
  state.sessions = (r && r.sessions) || [];
  renderSessionSelect();
}

function renderSessionSelect() {
  const sel = $('session-select');
  const prev = sel.value;
  sel.textContent = '';
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = '— no session —';
  sel.appendChild(optNone);
  for (const s of state.sessions) {
    const o = document.createElement('option');
    o.value = s.id;
    const lock = s.lock && s.lock.owner ? ` [${s.lock.owner}]` : '';
    o.textContent = `${s.id} · ${s.owner || '?'}${lock} · ${shortUrl(s.url)}`;
    if (s.id === state.sessionId) o.selected = true;
    sel.appendChild(o);
  }
  if (prev && !state.sessions.some((s) => s.id === prev)) sel.value = prev === state.sessionId ? prev : '';
  else if (state.sessionId) sel.value = state.sessionId;
  else sel.value = prev || '';
}

function shortUrl(u) {
  if (!u) return '(no url)';
  try { const p = new URL(u); return p.host + p.pathname; } catch { return u.slice(0, 32); }
}

/* ------------------------------------------------------------------ */
/* session lifecycle                                                   */
/* ------------------------------------------------------------------ */

async function newSession() {
  const urlInput = $('new-session-url');
  const url = normalizeUrl(urlInput.value);
  const body = {
    owner: OWNER,
    label: 'ui',
    viewport: { ...DEFAULT_VIEWPORT },
  };
  if (url) body.url = url;
  let r;
  try {
    r = await api('POST', '/sessions', body);
  } catch (e) {
    if (e.status === 409) toast('Session limit reached (SESSION_LIMIT). Close one first.', 'err');
    else toast('Could not create session: ' + e.message, 'err');
    return;
  }
  const session = r && (r.session || r);
  if (!session || !session.id) { toast('Broker returned no session id', 'err'); return; }
  urlInput.value = '';
  await pollSessions();
  await attachToSession(session.id);
}

async function attachToSession(id) {
  if (!id) return;
  // SEC-1: acquire ownership BEFORE the gated detail read — every gated call is now
  // checked against the session lock, so the UI must hold (or take over) the lock
  // as owner "user" first. Ownership info comes from the ungated session list.
  const listed = state.sessions.find((s) => s.id === id);
  const holder = listed && listed.lock && listed.lock.owner;
  if (!holder || holder === OWNER) {
    try {
      await api('POST', `/sessions/${encodeURIComponent(id)}/lock`, { owner: OWNER });
      state.lockOwned = true;
    } catch (e) {
      if (e.status === 409) {
        await takeoverFlow(id);
      } else {
        toast('Lock failed: ' + e.message, 'err');
      }
    }
  } else {
    await takeoverFlow(id, holder);
  }

  let detail;
  try {
    detail = await api('GET', '/sessions/' + encodeURIComponent(id));
  } catch (e) {
    toast('Cannot open session: ' + e.message, 'err');
    return;
  }
  const session = detail.session || detail;

  state.sessionId = id;
  state.session = session;
  state.hover = null;
  state.marquee = null;
  state.urlWatch.last = session.url || '';
  if (session.viewport && session.viewport.width && session.viewport.height) {
    setViewport(session.viewport.width, session.viewport.height);
  }
  state.hasFrame = false;
  paintIdle();
  $('stage-msg').hidden = false;
  $('url-bar').value = session.url || '';
  $('frame').setAttribute('aria-label', 'Remote browser viewport' + (session.title ? ': ' + session.title : ''));
  renderSessionSelect();
  renderPins();
  renderOverlay();
  scheduleFrame(60);   // (re)start frame polling for the attached session
  void pollSession();
  toast('Attached to session ' + id + (state.lockOwned ? ` (owner: ${OWNER})` : ''), 'ok', 2500);
}

async function takeoverFlow(id, currentOwner) {
  const holder = currentOwner || 'agent';
  const ok = confirm(`Take over? (${holder} currently holds it)`);
  if (!ok) { state.lockOwned = false; return; }
  try {
    const r = await api('POST', `/sessions/${encodeURIComponent(id)}/lock`, { owner: OWNER, takeOver: true });
    state.lockOwned = true;
    if (r && r.takeover) toast('Took over the session (previous holder was unlocked).', 'ok', 3500);
  } catch (e) {
    state.lockOwned = false;
    toast('Takeover failed: ' + e.message, 'err');
  }
}

function sessionGone() {
  toast('Session closed or expired.', 'err');
  state.sessionId = null;
  state.session = null;
  state.lockOwned = false;
  state.hasFrame = false;
  paintIdle();
  $('stage-msg').hidden = false;
  renderSessionSelect();
  renderPins();
}

async function pollSession() {
  if (!state.sessionId) return;
  let session;
  try {
    const r = await api('GET', '/sessions/' + encodeURIComponent(state.sessionId));
    session = r.session || r;
  } catch (e) {
    if (e.status === 404 || e.status === 410) sessionGone();
    return;
  }
  state.session = session;
  const url = session.url || '';
  // Navigation detection: URL changed between polls → re-resolve pinned refs.
  if (state.urlWatch.last !== null && url !== state.urlWatch.last && state.urlWatch.last !== undefined) {
    void rebindPins();
  }
  state.urlWatch.last = url;
  if (!$('url-bar').matches(':focus')) $('url-bar').value = url;
  $('frame').setAttribute('aria-label', 'Remote browser viewport' + (session.title ? ': ' + session.title : ''));
}

/* ------------------------------------------------------------------ */
/* navigation controls                                                 */
/* ------------------------------------------------------------------ */

async function navigateTo(url) {
  if (!state.sessionId) { toast('No session selected.', 'err'); return; }
  const u = normalizeUrl(url);
  if (!u) return;
  try {
    const r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/navigate`, { url: u, waitUntil: 'load' });
    $('url-bar').value = (r && r.url) || u;
    state.urlWatch.last = (r && r.url) || u;
  } catch (e) {
    if (e.status === 409) toast('Session busy — try again.', 'err');
    else toast('Navigate failed: ' + e.message, 'err');
  }
}

async function goBack() {
  if (!state.sessionId) return;
  try {
    const r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/back`, {});
    state.urlWatch.last = (r && r.url) || state.urlWatch.last;
    if (r && r.url) $('url-bar').value = r.url;
  } catch (e) { toast('Back failed: ' + e.message, 'err'); }
}

async function goReload() {
  if (!state.sessionId) return;
  try {
    const r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/reload`, {});
    state.urlWatch.last = (r && r.url) || state.urlWatch.last;
    if (r && r.url) $('url-bar').value = r.url;
  } catch (e) { toast('Reload failed: ' + e.message, 'err'); }
}

/* ------------------------------------------------------------------ */
/* frame polling & canvas                                              */
/* ------------------------------------------------------------------ */

let frameTimer = 0;
let frameBusy = false;

function scheduleFrame(delay) {
  clearTimeout(frameTimer);
  frameTimer = setTimeout(pollFrame, delay);
}

async function pollFrame() {
  if (!state.sessionId) return;
  if (frameBusy) { scheduleFrame(80); return; }
  frameBusy = true;
  const hidden = document.visibilityState === 'hidden';
  const interval = hidden ? FRAME_INTERVAL_HIDDEN_MS : FRAME_INTERVAL_MS;
  const started = performance.now();
  try {
    const res = await fetch(
      `${state.base}/sessions/${encodeURIComponent(state.sessionId)}/frame.jpg?t=${Date.now()}`,
      { headers: authHeaders(), cache: 'no-store' },
    );
    if (res.status === 401) { setAuthFail(true); }
    else if (res.ok) {
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      drawFrame(bmp.width, bmp.height, bmp);
      state.hasFrame = true;
      $('stage-msg').hidden = true;
    }
  } catch { /* frame fetch failures are transient; keep polling */ }
  finally { frameBusy = false; }
  const spent = performance.now() - started;
  scheduleFrame(Math.max(40, interval - spent));
}

function drawFrame(w, h, bmp) {
  const cv = $('frame');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
    setViewport(w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
}

function setViewport(w, h) {
  if (state.viewport.width === w && state.viewport.height === h) return;
  state.viewport = { width: w, height: h };
  layoutStage();
}

function paintIdle() {
  const cv = $('frame');
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, cv.width || state.viewport.width, cv.height || state.viewport.height);
}

/* Letterbox: fit the viewport-sized canvas into the stage, preserving
   aspect ratio. Pointer mapping divides by the CSS rect, so both the
   letterbox offset and the scale are compensated automatically. */
function layoutStage() {
  const stage = $('stage');
  const wrap = $('canvas-wrap');
  const { width, height } = state.viewport;
  const pad = 28;
  const availW = Math.max(120, stage.clientWidth - pad);
  const availH = Math.max(80, stage.clientHeight - pad - 30 /* hint bar */);
  const scale = Math.min(availW / width, availH / height);
  wrap.style.width = Math.max(60, Math.floor(width * scale)) + 'px';
  wrap.style.height = Math.max(40, Math.floor(height * scale)) + 'px';
  const svg = $('overlay');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  renderOverlay();
}

/* viewport-space pointer mapping (canvas CSS rect → viewport px) */
function toViewportPoint(clientX, clientY) {
  const r = $('frame').getBoundingClientRect();
  const { width, height } = state.viewport;
  return {
    x: clamp(((clientX - r.left) / Math.max(1, r.width)) * width, 0, width),
    y: clamp(((clientY - r.top) / Math.max(1, r.height)) * height, 0, height),
  };
}

/* ------------------------------------------------------------------ */
/* input forwarding (Browse mode)                                      */
/* ------------------------------------------------------------------ */

function btnName(b) {
  return b === 2 ? 'right' : b === 1 ? 'middle' : 'left';
}

async function sendInput(op) {
  if (!state.sessionId || state.mode !== 'browse') return;
  try {
    await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/input`, op);
  } catch (e) {
    if (e.status === 409) {
      // op-lock busy: back off once and retry (spec: UI backs off 300 ms)
      await sleep(300);
      try { await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/input`, op); } catch { /* drop */ }
    } else if (e.status !== 401) {
      // silent for moves; surface failures for discrete ops
      if (op.op !== 'move') toast('Input failed (' + op.op + '): ' + e.message, 'err', 2500);
    }
  }
}

/* trailing-edge throttle for pointermove (~30 Hz) */
let moveQueued = null;
let moveTimer = 0;
let moveLastSent = 0;
function queueMove(x, y) {
  moveQueued = { op: 'move', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  const wait = Math.max(0, INPUT_MOVE_HZ - (performance.now() - moveLastSent));
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!moveQueued) return;
    const m = moveQueued;
    moveQueued = null;
    moveLastSent = performance.now();
    void sendInput(m);
  }, wait);
}

/* ------------------------------------------------------------------ */
/* hover mode (element-at + highlight + tooltip)                       */
/* ------------------------------------------------------------------ */

let hoverQueued = null;
let hoverTimer = 0;
let hoverBusy = false;

function queueHover(p) {
  hoverQueued = p;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(pumpHover, HOVER_HZ);
}

async function pumpHover() {
  if (!hoverQueued || hoverBusy || state.mode !== 'hover' || !state.sessionId) return;
  const p = hoverQueued;
  hoverQueued = null;
  hoverBusy = true;
  try {
    const r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/element-at`, { x: p.x, y: p.y });
    if (r && r.found && r.element) {
      state.hover = {
        box: r.element.box || null,
        element: r.element,
        source: r.source || r.element.source || null,
        confidence: typeof r.confidence === 'number' ? r.confidence : null,
      };
    } else {
      state.hover = null;
    }
    renderOverlay();
  } catch (e) {
    if (e.status === 409) hoverQueued = p; // busy: retry next tick
  } finally {
    hoverBusy = false;
    if (hoverQueued) pumpHover();
  }
}

function sourceText(src, confidence) {
  if (!src) return null;
  const file = typeof src === 'string' ? src : (src.fileName || src.file || '');
  const line = typeof src === 'object' && src.lineNumber ? ':' + src.lineNumber : '';
  const comp = typeof src === 'object' && src.componentName ? ` (${src.componentName})` : '';
  const conf = typeof confidence === 'number' ? ` · confidence ${confidence.toFixed(2)}` : '';
  return file ? `${file}${line}${comp}${conf}` : null;
}

function tipLines() {
  const h = state.hover;
  if (!h || !h.element) return '';
  const e = h.element;
  const parts = [];
  if (e.role) parts.push(e.role + (e.tag ? ` <${e.tag}>` : e.name === undefined ? '' : ''));
  if (e.label) parts.push('label: ' + e.label);
  if (e.ref) parts.push('ref: ' + e.ref);
  const src = sourceText(h.source, h.confidence) || sourceText(e.source, null);
  if (src) parts.push('src: ' + src);
  return parts.join('\n') || '(element)';
}

/* ------------------------------------------------------------------ */
/* overlay rendering (SVG) + tooltip                                   */
/* ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

function renderOverlay() {
  const svg = $('overlay');
  svg.textContent = '';
  const { width, height } = state.viewport;

  // pinned elements/regions
  for (const pin of state.pins) {
    const b = pin.box;
    if (!b) continue;
    svg.appendChild(svgEl('rect', {
      x: b.x, y: b.y, width: b.width, height: b.height,
      fill: 'rgba(236,0,140,0.08)', stroke: '#ec008c', 'stroke-width': 2,
      class: 'pin-box', 'data-pin': pin.number,
    }));
    const cx = clamp(b.x + 1, 10, width - 12);
    const cy = clamp(b.y - 1, 12, height - 12);
    svg.appendChild(svgEl('circle', { cx, cy, r: 10, fill: '#ec008c', class: 'pin-badge', 'data-pin': pin.number }));
    const t = svgEl('text', {
      x: cx, y: cy + 4, 'text-anchor': 'middle', fill: '#fff',
      'font-size': 12, 'font-family': 'system-ui, sans-serif', 'font-weight': 700,
    });
    t.textContent = String(pin.number);
    svg.appendChild(t);
  }

  // region marquee (while dragging)
  if (state.marquee) {
    const m = state.marquee;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    svg.appendChild(svgEl('rect', {
      x, y, width: w, height: h,
      fill: 'rgba(236,0,140,0.15)', stroke: '#ec008c', 'stroke-width': 1.5,
      'stroke-dasharray': '6 4', class: 'marquee',
    }));
  }

  // hover highlight
  const tip = $('hover-tip');
  if (state.mode === 'hover' && state.hover && state.hover.box) {
    const b = state.hover.box;
    svg.appendChild(svgEl('rect', {
      x: b.x, y: b.y, width: b.width, height: b.height,
      fill: 'rgba(76,194,255,0.10)', stroke: '#4cc2ff', 'stroke-width': 2,
      'stroke-dasharray': '4 3', class: 'hover-box',
    }));
    const txt = tipLines();
    if (txt) {
      tip.hidden = false;
      tip.textContent = txt;
      const wrapRect = $('canvas-wrap').getBoundingClientRect();
      const scale = wrapRect.width / width;
      const left = clamp(b.x * scale + 12, 0, Math.max(0, wrapRect.width - tip.offsetWidth - 4));
      const topRaw = b.y * scale + 12;
      const top = clamp(topRaw, 0, Math.max(0, wrapRect.height - tip.offsetHeight - 4));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    } else {
      tip.hidden = true;
    }
  } else {
    tip.hidden = true;
    if (state.mode !== 'hover') state.hover = null;
  }
}

/* ------------------------------------------------------------------ */
/* pins (numbered comments)                                            */
/* ------------------------------------------------------------------ */

function clampBox(b) {
  const { width, height } = state.viewport;
  const x0 = clamp(b.x, 0, width), y0 = clamp(b.y, 0, height);
  const x1 = clamp(b.x + b.width, 0, width), y1 = clamp(b.y + b.height, 0, height);
  return { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
}

function addPin(partial) {
  const pin = {
    number: state.pinSeq++,
    kind: partial.kind,
    ref: partial.ref || null,
    box: partial.box ? clampBox(partial.box) : null,
    meta: partial.meta || null,
    source: partial.source || (partial.meta && partial.meta.source) || null,
    confidence: typeof partial.confidence === 'number' ? partial.confidence : null,
    comment: partial.comment || '',
    thumb: partial.thumb || null,
    status: partial.status || 'unknown',
  };
  state.pins.push(pin);
  renderPins();
  renderOverlay();
  return pin;
}

function removePin(pin) {
  const i = state.pins.indexOf(pin);
  if (i >= 0) state.pins.splice(i, 1);
  renderPins();
  renderOverlay();
}

/* SAFE METADATA WHITELIST — never render meta.value or anything not in
   this list, so typed input values can never reach the screen. */
function metaRows(pin) {
  const rows = [];
  const m = pin.meta || {};
  const add = (k, v, cls) => { if (v !== undefined && v !== null && v !== '') rows.push([k, String(v), cls]); };
  add('tag', m.tag || m.htmlTag);
  add('role', m.role);
  add('label', m.label);
  add('name', m.name);
  add('testid', m.testid || m['data-testid']);
  add('id', m.id);
  add('selector', m.selector);
  if (m.disabled === true) add('disabled', 'true');
  if (pin.box) add('box', `${pin.box.x},${pin.box.y} ${pin.box.width}×${pin.box.height}`);
  const src = sourceText(pin.source, pin.confidence) || sourceText(m.source, pin.confidence);
  if (src) add('source', src, 'pin-src');
  return rows;
}

function renderPins() {
  const list = $('pin-list');
  list.textContent = '';
  for (const pin of state.pins) list.appendChild(buildPinCard(pin));
  $('pin-empty').hidden = state.pins.length > 0;
  $('pin-count').textContent = state.pins.length + (state.pins.length === 1 ? ' pin' : ' pins');
}

function buildPinCard(pin) {
  const li = document.createElement('li');
  li.className = 'pin-card';
  li.dataset.pin = String(pin.number);
  pin.card = li;

  const head = document.createElement('div');
  head.className = 'pin-head';
  const num = document.createElement('span');
  num.className = 'pin-num';
  num.textContent = String(pin.number);
  const kind = document.createElement('span');
  kind.className = 'pin-kind';
  kind.textContent = pin.kind + (pin.ref ? ' · ' + pin.ref : '');
  const status = document.createElement('span');
  status.className = 'pin-status ' + (pin.status || 'unknown');
  status.dataset.role = 'pin-status';
  status.textContent = pin.status || 'unknown';
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'pin-del';
  del.textContent = 'Delete';
  del.setAttribute('aria-label', `Delete pin ${pin.number}`);
  del.addEventListener('click', () => removePin(pin));
  head.append(num, kind, status, del);

  const meta = document.createElement('div');
  meta.className = 'pin-meta';
  fillMeta(meta, pin);

  const ta = document.createElement('textarea');
  ta.className = 'pin-comment';
  ta.placeholder = `Comment for pin #${pin.number}`;
  ta.setAttribute('aria-label', `Comment for pin ${pin.number}`);
  ta.value = pin.comment;
  ta.addEventListener('input', () => { pin.comment = ta.value; });

  const actions = document.createElement('div');
  actions.className = 'row';
  if (pin.kind === 'element' && pin.box) {
    const shot = document.createElement('button');
    shot.type = 'button';
    shot.className = 'pin-region-shot';
    shot.textContent = 'Add region shot';
    shot.setAttribute('aria-label', `Add region shot for pin ${pin.number}`);
    shot.addEventListener('click', () => void addRegionShot(pin));
    actions.appendChild(shot);
  }

  li.append(head, meta, ta, actions);
  if (pin.thumb) {
    const img = document.createElement('img');
    img.className = 'pin-thumb';
    img.alt = `Region screenshot for pin ${pin.number}`;
    img.src = pin.thumb;
    li.insertBefore(img, ta);
  }
  return li;
}

function fillMeta(meta, pin) {
  meta.textContent = '';
  for (const [k, v, cls] of metaRows(pin)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (cls) dd.className = cls;
    dd.textContent = v;
    meta.append(dt, dd);
  }
}

function updatePinCard(pin) {
  if (!pin.card) { renderPins(); return; }
  fillMeta(pin.card.querySelector('.pin-meta'), pin);
  const st = pin.card.querySelector('[data-role="pin-status"]');
  if (st) {
    st.className = 'pin-status ' + (pin.status || 'unknown');
    st.textContent = pin.status || 'unknown';
  }
}

async function selectAt(p) {
  if (!state.sessionId) { toast('No session selected.', 'err'); return; }
  let r;
  try {
    r = await apiRetry409('POST', `/sessions/${encodeURIComponent(state.sessionId)}/element-at`, { x: p.x, y: p.y });
  } catch (e) {
    toast('element-at failed: ' + e.message, 'err');
    return;
  }
  if (!r || !r.found || !r.element) { toast('No element found at that point.'); return; }
  const el = r.element;
  addPin({
    kind: 'element',
    ref: el.ref || null,
    box: el.box || null,
    meta: el,
    source: r.source || el.source || null,
    confidence: r.confidence,
    status: 'ok',
  });
}

async function captureClip(clip) {
  const r = await apiRetry409('POST', `/sessions/${encodeURIComponent(state.sessionId)}/screenshot`, {
    clip,
    format: 'png',
  });
  return (r && (r.dataUrl || r.dataURL)) || null;
}

async function addRegionShot(pin) {
  if (!pin.box) return;
  try {
    const dataUrl = await captureClip(pin.box);
    if (dataUrl) {
      pin.thumb = dataUrl;
      renderPins();
      toast(`Region shot added to pin #${pin.number}.`, 'ok', 2500);
    } else {
      toast('Broker returned no dataUrl.', 'err');
    }
  } catch (e) {
    toast('Screenshot failed: ' + e.message, 'err');
  }
}

/* marquee (region mode) */
async function finishMarquee() {
  const m = state.marquee;
  state.marquee = null;
  renderOverlay();
  if (!m) return;
  const box = clampBox({
    x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
    width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0),
  });
  if (box.width < 4 || box.height < 4) return;
  if (!state.sessionId) { toast('No session selected.', 'err'); return; }
  try {
    const dataUrl = await captureClip(box);
    addPin({ kind: 'region', box, thumb: dataUrl, status: 'ok' });
    if (!dataUrl) toast('Region captured, but the broker returned no image.', 'err');
  } catch (e) {
    toast('Region screenshot failed: ' + e.message, 'err');
  }
}

/* rebinding after navigation */
async function rebindPins() {
  const refs = [...new Set(state.pins.filter((p) => p.kind === 'element' && p.ref).map((p) => p.ref))];
  if (!refs.length) return;
  let r;
  try {
    r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/elements/resolve`, { refs });
  } catch { return; }
  const results = (r && r.results) || [];
  for (const res of results) {
    for (const pin of state.pins) {
      if (pin.kind !== 'element' || pin.ref !== res.ref) continue;
      pin.status = res.status || 'lost';
      if (res.element) {
        pin.meta = res.element;
        if (res.element.box) pin.box = clampBox(res.element.box);
        if (res.element.ref) pin.ref = res.element.ref;
        pin.source = res.element.source || pin.source;
      }
      updatePinCard(pin);
    }
  }
  renderOverlay();
}

/* ------------------------------------------------------------------ */
/* send to orchestrator                                                */
/* ------------------------------------------------------------------ */

async function sendAnnotations() {
  if (!state.sessionId) { toast('No session selected.', 'err'); return; }
  if (!state.pins.length) { toast('No pins to send — pin something first.', 'err'); return; }
  // The API requires a non-empty comment per item — validate before sending.
  const missing = state.pins.filter((p) => !p.comment || !p.comment.trim());
  if (missing.length) {
    toast(`Pin ${missing.map((p) => '#' + p.number).join(', ')} needs a comment before sending.`, 'err', 6000);
    return;
  }
  const items = state.pins.map((p) => (
    p.kind === 'element'
      ? {
          kind: 'element',
          ref: p.ref || undefined,
          selector: (p.meta && p.meta.selector) || undefined,
          box: p.box || undefined,
          meta: p.meta || undefined,
          screenshot: p.thumb || undefined,
          comment: p.comment || '',
          number: p.number,
        }
      : {
          kind: 'region',
          box: p.box || undefined,
          screenshot: p.thumb || undefined,
          comment: p.comment || '',
          number: p.number,
        }
  ));
  const note = $('ann-note').value.trim();
  const context = {
    url: (state.session && state.session.url) || '',
    viewport: { ...state.viewport },
  };
  if (note) context.note = note;
  let r;
  try {
    r = await api('POST', `/sessions/${encodeURIComponent(state.sessionId)}/annotations`, { items, context });
  } catch (e) {
    toast('Send failed: ' + e.message, 'err');
    return;
  }
  const gid = r && (r.groupId ?? r.id);
  state.lastGroupId = gid !== undefined ? gid : null;
  toast(`delivered ✓ (group ${gid === undefined ? '?' : gid})`, 'ok', 8000);
  state.pins = [];
  state.pinSeq = 1;
  renderPins();
  renderOverlay();
  void pollPending();
}

/* ------------------------------------------------------------------ */
/* keyboard forwarding                                                 */
/* ------------------------------------------------------------------ */

function onKeyDown(e) {
  if (state.mode !== 'browse') return;
  if (document.activeElement !== $('frame')) return;
  const combo = e.ctrlKey || e.metaKey || e.altKey;
  const mods = ['Control', 'Meta', 'Alt', 'Shift'].filter((m) =>
    (m === 'Control' && e.ctrlKey) || (m === 'Meta' && e.metaKey) ||
    (m === 'Alt' && e.altKey) || (m === 'Shift' && e.shiftKey));
  if (!combo && e.key.length === 1) {
    // Playwright's keyboard.type applies case itself; modifiers only matter for combos
    void sendInput({ op: 'type', text: e.key });
  } else {
    void sendInput({ op: 'key', key: e.key, ...(mods.length ? { modifiers: mods } : {}) });
  }
  e.preventDefault();
}

/* ------------------------------------------------------------------ */
/* test runner panel                                                   */
/* ------------------------------------------------------------------ */

function setRunStatus(text) { $('run-status').textContent = text; }

async function runTests() {
  const projectDir = $('run-project').value.trim();
  if (!projectDir) { toast('Project dir required.', 'err'); return; }
  const body = { projectDir };
  const filter = $('run-filter').value.trim();
  if (filter) body.filter = filter;
  setRunStatus('submitting…');
  $('run-log').textContent = '';
  $('run-counters').hidden = true;
  try {
    const r = await api('POST', '/tests/run', body);
    state.runId = (r && (r.runId ?? r.opId ?? r.id)) || null;
    if (!state.runId) { setRunStatus('broker returned no run id'); return; }
    setRunStatus('run ' + state.runId + ' · starting…');
    $('btn-cancel-run').disabled = false;
    scheduleRunPoll(300);
  } catch (e) {
    setRunStatus('run failed: ' + e.message);
    toast('tests/run failed: ' + e.message, 'err');
  }
}

function scheduleRunPoll(delay) {
  clearTimeout(state.runTimer);
  state.runTimer = setTimeout(pollRun, delay);
}

async function pollRun() {
  if (!state.runId) return;
  let r;
  try {
    r = await api('GET', '/tests/runs/' + encodeURIComponent(state.runId));
  } catch (e) {
    setRunStatus('run ' + state.runId + ' · poll failed: ' + e.message);
    scheduleRunPoll(2000);
    return;
  }
  renderRun(r);
  if (r && r.status === 'running') {
    $('btn-cancel-run').disabled = false;
    scheduleRunPoll(RUN_POLL_MS);
  } else {
    $('btn-cancel-run').disabled = true;
  }
}

function renderRun(r) {
  if (!r) return;
  const s = r.summary || {};
  const counters = $('run-counters');
  counters.hidden = false;
  $('c-pass').textContent = String(s.passed ?? 0);
  $('c-fail').textContent = String(s.failed ?? 0);
  $('c-flaky').textContent = String(s.flaky ?? 0);
  $('c-skip').textContent = String(s.skipped ?? 0);
  const dur = typeof s.durationMs === 'number' ? `${(s.durationMs / 1000).toFixed(1)} s` : '';
  $('c-duration').textContent = dur ? '· ' + dur : '';
  setRunStatus(`run ${r.runId || state.runId} · ${r.status}${r.exitCode !== undefined && r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`);
  const log = $('run-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = String(r.logTail || '');
  if (atBottom) log.scrollTop = log.scrollHeight;
  const report = $('run-report');
  report.textContent = '';
  if (r.reportDir) report.append('report: ' + r.reportDir);
  if (r.traceDir) report.append(' · trace: ' + r.traceDir);
}

async function cancelRun() {
  if (!state.runId) return;
  try {
    await api('POST', `/ops/${encodeURIComponent(state.runId)}/cancel`, {});
    toast('Cancel requested for run ' + state.runId, 'ok', 2500);
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'err');
  }
  scheduleRunPoll(300);
}

/* ------------------------------------------------------------------ */
/* mode switching                                                      */
/* ------------------------------------------------------------------ */

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  }
  for (const span of document.querySelectorAll('#stage-hint span')) {
    span.hidden = span.dataset.for !== mode;
  }
  if (mode !== 'hover') { state.hover = null; renderOverlay(); }
  else { state.hover = null; renderOverlay(); }
}

/* ------------------------------------------------------------------ */
/* unlock on tab close (best effort, fetch keepalive)                  */
/* ------------------------------------------------------------------ */

function unlockOnUnload() {
  if (!state.sessionId || !state.lockOwned) return;
  try {
    void fetch(`${state.base}/sessions/${encodeURIComponent(state.sessionId)}/unlock`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ owner: OWNER }),
      keepalive: true,
    });
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function wirePointerInput() {
  const wrap = $('canvas-wrap');

  wrap.addEventListener('pointermove', (e) => {
    const p = toViewportPoint(e.clientX, e.clientY);
    if (state.mode === 'browse') queueMove(p.x, p.y);
    else if (state.mode === 'hover') queueHover(p);
    else if (state.mode === 'region' && state.marquee) {
      state.marquee.x1 = p.x;
      state.marquee.y1 = p.y;
      renderOverlay();
    }
  });

  wrap.addEventListener('pointerdown', (e) => {
    const canvas = $('frame');
    if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
    const p = toViewportPoint(e.clientX, e.clientY);
    if (state.mode === 'browse') {
      void sendInput({ op: 'down', x: p.x, y: p.y, button: btnName(e.button) });
    } else if (state.mode === 'region' && e.button === 0) {
      state.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      try { wrap.setPointerCapture(e.pointerId); } catch { /* optional */ }
      renderOverlay();
    }
  });

  wrap.addEventListener('pointerup', (e) => {
    const p = toViewportPoint(e.clientX, e.clientY);
    if (state.mode === 'browse') {
      void sendInput({ op: 'up', x: p.x, y: p.y, button: btnName(e.button) });
    } else if (state.mode === 'region' && state.marquee) {
      state.marquee.x1 = p.x;
      state.marquee.y1 = p.y;
      void finishMarquee();
    }
  });

  wrap.addEventListener('dblclick', (e) => {
    if (state.mode !== 'browse') return;
    const p = toViewportPoint(e.clientX, e.clientY);
    void sendInput({ op: 'dblclick', x: p.x, y: p.y, button: 'left', clickCount: 2 });
  });

  // right-click: suppress the local menu, forward as right-button ops
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());

  wrap.addEventListener('wheel', (e) => {
    if (state.mode !== 'browse') return;
    e.preventDefault();
    void sendInput({ op: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  wrap.addEventListener('click', (e) => {
    if (state.mode !== 'select') return;
    const p = toViewportPoint(e.clientX, e.clientY);
    void selectAt(p);
  });

  window.addEventListener('keydown', onKeyDown);
}

function wireToolbar() {
  $('session-select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) void attachToSession(id);
  });
  $('btn-new-session').addEventListener('click', () => void newSession());
  $('new-session-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void newSession();
  });
  $('btn-go').addEventListener('click', () => void navigateTo($('url-bar').value));
  $('url-bar').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void navigateTo($('url-bar').value);
  });
  $('btn-back').addEventListener('click', () => void goBack());
  $('btn-reload').addEventListener('click', () => void goReload());
  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
  const tok = $('token-input');
  tok.value = state.token;
  tok.addEventListener('change', () => {
    state.token = tok.value.trim();
    if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
    else localStorage.removeItem(TOKEN_KEY);
    setAuthFail(false);
    void pollHealth();
    void pollSessions();
    void pollPending();
  });
  $('btn-send').addEventListener('click', () => void sendAnnotations());
  $('btn-run-tests').addEventListener('click', () => void runTests());
  $('btn-cancel-run').addEventListener('click', () => void cancelRun());
  $('runner-toggle').addEventListener('click', () => {
    const body = $('runner-body');
    const open = body.hidden;
    body.hidden = !open;
    $('runner-toggle').setAttribute('aria-expanded', String(open));
    $('runner-toggle').querySelector('.caret').textContent = open ? '▾' : '▸';
  });
  window.addEventListener('pagehide', unlockOnUnload);
  window.addEventListener('beforeunload', unlockOnUnload);
}

function init() {
  // SEC-4: the token is taken from localStorage or manual paste ONLY. A legacy
  // ?token=… URL is stripped via history.replaceState and NEVER persisted.
  const params = new URLSearchParams(location.search);
  if (params.has('token')) {
    params.delete('token');
    const qs = params.toString();
    try {
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    } catch { /* non-secure context etc. — the token still must not be used */ }
  }
  state.token = localStorage.getItem(TOKEN_KEY) || '';

  state.urlWatch = { last: null };
  paintIdle();
  wirePointerInput();
  wireToolbar();
  setMode('browse');
  layoutStage();

  if (!('ResizeObserver' in window)) window.addEventListener('resize', layoutStage);
  else new ResizeObserver(() => layoutStage()).observe($('stage'));

  void pollHealth();
  void pollSessions();
  void pollPending();
  setInterval(pollHealth, HEALTH_POLL_MS);
  setInterval(pollSessions, LIST_POLL_MS);
  setInterval(pollPending, PENDING_POLL_MS);
  setInterval(() => { if (state.sessionId) void pollSession(); }, SESSION_POLL_MS);
}

init();

/* ------------------------------------------------------------------ */
/* test hook (read-only introspection for ui.spec.mjs)                 */
/* ------------------------------------------------------------------ */

window.__vbwTest = {
  get viewport() { return { ...state.viewport }; },
  get mode() { return state.mode; },
  get sessionId() { return state.sessionId; },
  get pinCount() { return state.pins.length; },
  get pinNumbers() { return state.pins.map((p) => p.number); },
  get hasFrame() { return state.hasFrame; },
  toViewportPoint,
  renderOverlay,
};
