# VBW Broker API — v1.1 (hardened; single source of truth for workers)

Base: `http://127.0.0.1:8931` (env `VBW_BROKER_PORT`). All requests require header
`Authorization: Bearer <token>`; token + port + pid are written to
`%LOCALAPPDATA%\vbw\state\broker.json` (env `VBW_STATE_DIR` overrides the directory; the
workspace `_vbw\state\` holds only artifacts — screenshots, annotations, test runs — never the
token). All bodies are JSON unless noted. Errors:
`{ "error": { "code": string, "message": string } }` with proper HTTP status. CORS:
`Access-Control-Allow-Origin: *` for GET (frames/UI need it) and token-guarded for mutations.
All coordinates are **CSS pixels relative to the page viewport** unless noted.
Caller identity: `X-VBW-Owner` header (default `"agent"`); user-owned sessions reject
mutations AND reads from other owners with `409 SESSION_LOCKED` until takeover/unlock.

## Hardened transport rules (v1.1)
- Host header must be `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` → else `400 BAD_HOST`.
- Loopback remoteAddress check (incl. IPv4-mapped IPv6) on every request → else `403 FORBIDDEN_REMOTE`.
- Token compare is length-guarded `crypto.timingSafeEqual`.
- `GET /health` and `GET /ui*` are the only unauthenticated routes.

## Health & discovery
- `GET /health` → `{ ok:true, version:"0.1.0", sessions:<n>, uptimeMs, channel }` (no auth; no data).

## Sessions
- `POST /sessions` `{ url?, owner?: "agent"|"user"|string, viewport?: {width,height}, label? }` →
  `201 { session }`. Creates Playwright context (isolated storage) + page. Applies per-owner lock.
  409 `SESSION_LIMIT` when ≥ `VBW_MAX_SESSIONS` (default 4).
- `GET /sessions` → `{ sessions: [SessionSummary] }`; summary: `{ id, owner, label, url, title,
  status:"idle"|"busy"|"closed", lock:{owner,acquiredAt}|null, createdAt, lastOpAt }`.
- `GET /sessions/:id` → `{ session }` (404 if unknown, 410 if closed).
- `DELETE /sessions/:id` → closes context. 409 if caller is not the lock owner (unless `?force=1`
  with token owner `agent`).
- `POST /sessions/:id/lock` `{ owner, takeOver?:boolean }` → sets/steals lock. Steal requires
  `takeOver:true` and returns `{ takeover:true }` (UI must confirm before calling).
- `POST /sessions/:id/unlock` `{ owner }`.

## Navigation
- `POST /sessions/:id/navigate` `{ url, waitUntil?: "load"|"domcontentloaded"|"networkidle",
  timeoutMs? }` → `{ url, title }`. Only `http:`/`https:` allowed (block `file:`, `data:`,
  credentials-in-URL; hostname normalization strips trailing dots and IPv4-mapped IPv6 before
  the self-origin/GUI-origin blocklist). Navigation retires all element refs (Hermes delta rule).
  **Cancel**: navigations with `waitUntil:"networkidle"` register a cancellable op —
  `POST /ops/:opId/cancel` aborts the race and settles the op as `cancelled`
  (`{ "cancelled": true }` returned to the original caller; repeat cancel → `409 OP_NOT_RUNNING`).
  **Redirect quarantine (defense-in-depth)**: after goto/back/forward/reload the final
  `page.url()` is re-validated; a disallowed landing → `403 URL_REDIRECT_BLOCKED`, session
  status `blocked-navigation` (pinned to `about:blank`); reads are refused until the next
  successful navigate.
- `POST /sessions/:id/back` / `forward` / `reload` → `{ url, title }` (same guard + cancel rules).

## Input (real input events)
- `POST /sessions/:id/input` `{ op: "move"|"down"|"up"|"click"|"dblclick"|"wheel"|"key"|"type",
  x?, y?, button?: "left"|"right"|"middle", clickCount?, deltaX?, deltaY?, key?, text?,
  modifiers?: string[], delay? }` → `{ ok:true }`. Mouse ops require x,y (viewport-relative).
- `POST /sessions/:id/scroll-to` `{ to: "top"|"bottom" }`.

## Perception
- `GET /sessions/:id/frame.jpg` (or `.png`) `?quality=` → image bytes (viewport screenshot).
  No auth-exempt: requires token like everything except /health. `Cache-Control: no-store`.
- `POST /sessions/:id/screenshot` `{ fullPage?, clip?: {x,y,width,height}, elementSelector?,
  format?: "png"|"jpeg", quality?, save?: boolean }` → `{ dataUrl, file? }` (file set when
  `save:true`; stored under `_vbw\state\screenshots\`).
- `POST /sessions/:id/read-text` `{ start?, count? (chars, default 4000) }` →
  `{ url, title, text, start, end, totalChars }` — visible text, paged. Runs secret-pattern
  redaction (16-digit cards, `sk-…`, `Bearer …`, `password=…`, JWT `eyJ…`, AWS `AKIA…`,
  GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, Slack `xox[bpars]-`, Google `AIza…`,
  hex-32+ runs) over text AND title before returning; matched titles become `«redacted»`.
  Best-effort by design: screenshots are never redacted.
- `POST /sessions/:id/inventory` `{ max? (≤120) }` → `{ url, elements: [Element], retired: [ref],
  delta: Delta }` where `Element = { ref, role, label, name?, value?, disabled?, selector?,
  box:{x,y,width,height}, source?: SourceRef }` and `Delta = { added:[ref], changed:[{ref,...}],
  removed:[ref], rebound:[ref], same:number }` (Hermes wire shape; `source` only when fiber
  mapping succeeds).
- `POST /sessions/:id/element-at` `{ x, y }` → `{ found:boolean, element?: Element&{ html-tag
  info }, source?: SourceRef, confidence?: number }` — **safe metadata only** (see Security).
- `POST /sessions/:id/elements/resolve` `{ refs: string[] }` → `{ results: { ref, status:
  "ok"|"rebound"|"lost", element? }[] }` (UI uses this to rebind pins after navigation).

## Source mapping (visual-to-code)
- `POST /sessions/:id/map-source` `{ ref? , selector?, x?, y? }` →
  `{ match: { fileName, lineNumber?, componentName?, origin: "fiber"|"sourcemap"|"heuristic",
  confidence: number, evidence: string[] } | null }`. Project root resolved from
  `VBW_PROJECT_ROOT` env or `{ closest vite.config.* ancestor of served URL }` when the page is
  a local dev server.

## Highlight / annotate (driven page overlay)
- `POST /sessions/:id/highlight` `{ refs?: string[], boxes?: {x,y,width,height}[], label?,
  style?: "candidate"|"held"|"hit", clear?: boolean }` → `{ ok:true }` (top-layer overlay).
- `POST /sessions/:id/annotations` `{ items: [ { kind:"element"|"region", ref?, selector?, box?,
  meta?: Element, screenshot?: dataUrl (optional; broker captures when absent), comment:string,
  number?:number } ], context?: { url, viewport, note } }` → `201 { groupId, items:[{number,…}] }`.
  Persists under `_vbw\state\annotations\YYYYMMDD-<groupId>.json`.
- `GET /annotations/pending` `?includeShots=1` → `{ groups: [Group] }` — item `screenshot`
  dataURLs are STRIPPED unless `includeShots=1` (keep payloads small; `screenshotFile` path is
  always present); `POST /annotations/ack` `{ groupIds }` →
  `{ acked:n }` (pending queue consumed by orchestrator tool).

## Tests
- `POST /tests/run` `{ projectDir, filter?, extraArgs?, devServer?: { port? } }` →
  `202 { runId }`. Broker spawns `node <bundled-node> <pnpm.cjs> exec playwright test …` with
  `cwd=projectDir`, `VBW_NO_WEBSERVER=1`, and **auto-bootstraps the dev server**: TCP-probes
  `http://127.0.0.1:<devServer.port>` (default 5173); reuses a live server (broker-managed or
  external) or starts one for the SAME projectDir via the fixed vite argv (no shell). The run
  result exposes `devServerStarted/devServerPort/devServerReused`. `extraArgs` must not contain
  `-c`/`--config` → `400 BAD_TEST_ARG`. Runs auto-cancel at `VBW_TEST_MAX_MS` (default
  900000) with status `"timeout"`.
- `GET /tests/runs/:runId` → `{ runId, status:"running"|"done"|"failed"|"cancelled"|"timeout",
  exitCode?, summary?, logTail, reportDir?, traceDir?, devServerStarted?, devServerPort?,
  devServerReused? }`.
- `POST /ops/:opId/cancel` → cancels a running op (test runs, networkidle navigations).
- `POST /devserver` `{ projectDir, port }` → `{ devServerId, url }` — **fixed vite argv only**
  (the former `command` parameter is removed: the broker has no exec endpoints);
  `DELETE /devserver/:id` → stops it. Used so the runner and UI hit the same dev instance.

## Ops & lifecycle rules
- Every mutation is serialized per session by an async op-lock; concurrent mutations get
  409 `SESSION_BUSY` (UI treats as "try again"); readers (frame, read-text, inventory) may run
  concurrently unless a mutation is in flight, then they get 409 too (UI backs off 300 ms).
- **Ownership gates**: mutations and reads check the caller (`X-VBW-Owner`, default `agent`)
  against the session lock → `409 SESSION_LOCKED` for a different owner; `POST /lock
  {owner, takeOver:true}` is the takeover path; session creation is serialized and re-checks
  the cap after context creation.
- `lastOpAt` updated per op; reaper closes sessions idle > 30 min (env override) and logs it.
  Ops are pruned 10 min after terminal state; closed sessions are pruned from memory after 1 h
  (fresh closed rows remain listed). Long ops (tests, devserver start, navigation with
  `networkidle`) accept `opId` in response and support `POST /ops/:opId/cancel`.
- On broker SIGINT/SIGTERM: close all contexts gracefully, clear the state file pid/token.

## Security invariants (implementation MUST enforce)
1. Bind loopback only; verify `req.socket.remoteAddress` is loopback for every request; require
   a trusted `Host` header (`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`).
2. Input **values** of form fields are never included in any response (`Element.value` is a
   checkbox/radio state or a static combobox option label — never typed user text).
3. `read-text` / inventory text passes a redaction filter (default patterns: 16-digit numbers,
   `sk-…`, `Bearer …`, `password=…`, JWT `eyJ…`, AWS `AKIA…`, GitHub tokens, Slack `xox…`,
   Google `AIza…`, hex-32+ runs; applied to text AND matched titles); hits replaced with
   `«redacted»` and counted in response. Best-effort: screenshots are never redacted.
4. No `file:`/`ftp:`/credentials URLs; navigation to the broker's own origin is refused (avoids
   recursion), as is the DSH GUI origin if reachable; the landing URL is re-validated after
   every navigation (redirect quarantine → `blocked-navigation`).
5. No exec endpoints. No response ever includes broker token or absolute filesystem paths of the
   host user profile (project paths are OK — they're the workspace); fiber/sourcemap sources
   outside the workspace roots are dropped entirely.
6. Session ownership is technically enforced: mutations AND reads honor the owner lock
   (`409 SESSION_LOCKED`), takeover is explicit; agents never auto-target user sessions.
7. TLS errors are rejected by default (`ignoreHTTPSErrors:false`); per-session
   `allowInsecureTLS:true` is the explicit opt-in.
8. The broker state file (token) lives under `%LOCALAPPDATA%\vbw\state\` — a non-synced,
   user-profile path (never under OneDrive-synced directories).

## Non-goals (v1)
No WebSocket push (JPEG polling), no multi-tab-per-session, no download handling, no CDP passthrough.
