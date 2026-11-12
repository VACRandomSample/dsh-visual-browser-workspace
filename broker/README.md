# VBW Broker

Standalone Node (ESM) service that brokers Playwright-driven browser sessions, safe DOM
inventory, annotations, source mapping and a Playwright test runner for Visual Browser
Workspace. Spec: `..\specs\broker-api.md` (single source of truth).

## Start

```powershell
cd _vbw\broker
node src\server.mjs          # bundled node: <bundled-harness-node.exe>
```

- Listens on `http://127.0.0.1:8931` only (env `VBW_BROKER_PORT`), loopback-checked per request.
  Host headers other than `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` are rejected
  with `400 BAD_HOST`, and the bearer token is compared with `crypto.timingSafeEqual`.
- Bearer token + port + pid are written to `%LOCALAPPDATA%\vbw\state\broker.json` at startup
  (SEC-2: outside OneDrive; env `VBW_STATE_DIR` moves the dir, `VBW_STATE_FILE` overrides the
  file for test instances). Artifacts (screenshots/annotations/test-runs/logs) STAY under
  `_vbw\state\`. Never log the token.
- Every request except `GET /health` needs `Authorization: Bearer <token>`.
- Lock ownership is read from the `X-VBW-Owner` header (default `agent`). Gated calls
  (`gateMutation`/`gateRead`) are refused with `409 SESSION_LOCKED` when the session is locked
  by a different owner (SEC-1); the lock lifecycle itself (`POST /lock` with `takeOver:true`,
  `POST /unlock`) is unchanged.

## Environment

| var | default | meaning |
|---|---|---|
| `VBW_BROKER_PORT` | `8931` | loopback port |
| `VBW_MAX_SESSIONS` | `4` | session cap (409 `SESSION_LIMIT` beyond) |
| `VBW_SESSION_IDLE_MS` | `1800000` | idle reaper threshold (30 min) |
| `VBW_REAPER_INTERVAL_MS` | `5000` | reaper check interval (also prunes closed session rows after 1 h and terminal ops after 10 min) |
| `VBW_BROWSER_CHANNEL` | `chrome` | Playwright channel (system Chrome; no browser download) |
| `VBW_HEADLESS` | `1` | set `0` for headed browser |
| `VBW_PROJECT_ROOT` | – | source-mapper project root override |
| `VBW_REDACT_PATTERNS` | built-ins | comma-separated regex sources for secret redaction |
| `VBW_BLOCKED_ORIGINS` | DSH GUI `:31184` | extra origins the driven browser may not visit |
| `VBW_STATE_DIR` | `%LOCALAPPDATA%\vbw\state` | directory of the discovery state file (SEC-2) |
| `VBW_TEST_MAX_MS` | `900000` | test-run wall-clock cap; exceeded runs end with status `timeout` (SEC-12) |

## Endpoints (summary)

- `GET /health` — no auth: `{ok, version, sessions, uptimeMs, channel}`
- `POST /sessions` `{url?, owner?, viewport?, label?, allowInsecureTLS?}` → `201 {session}`;
  contexts refuse invalid TLS certificates by default (`allowInsecureTLS:true` opts in per
  session, SEC-6); `GET /sessions`; `GET/DELETE /sessions/:id`
  (DELETE 409 unless caller owns the lock, `?force=1` as owner `agent`)
- `POST /sessions/:id/lock` `{owner, takeOver?}` / `POST /sessions/:id/unlock` `{owner}`
- `POST /sessions/:id/navigate` `{url, waitUntil?, timeoutMs?}` → `{url,title}` — http/https only,
  no file:/data:/credentials, broker's own origin refused (hostnames are normalized: trailing
  dot, `::ffff:`-mapped IPv6); navigation retires all element refs. After EVERY completed
  goto/back/forward/reload the final `page.url()` is re-checked (SEC-10): a redirect outside
  the allowlist resets the page to about:blank, marks the session `blocked-navigation` (reads
  → `403 URL_REDIRECT_BLOCKED` until the next successful navigate) and returns
  `403 URL_REDIRECT_BLOCKED`
- `POST /sessions/:id/back|forward|reload`; `POST /sessions/:id/scroll-to` `{to:"top"|"bottom"}`
- `POST /sessions/:id/input` `{op:"move|down|up|click|dblclick|wheel|key|type", x?, y?, ...}`
- `GET /sessions/:id/frame.jpg|.png` `?quality=` — viewport screenshot, `Cache-Control: no-store`
- `POST /sessions/:id/screenshot` `{fullPage?, clip?, elementSelector?, format?, quality?, save?}` → `{dataUrl, file?}`
- `POST /sessions/:id/read-text` `{start?, count?}` → paged visible text with `«redacted»` secret
  filter (JWT/AWS/GitHub/Slack/Google keys and hex-32 runs included; the page `title` is
  redacted only when it matches a pattern, same for session summaries)
- `POST /sessions/:id/inventory` `{max?≤120}` → `{url, elements, retired, delta}` (Hermes-style slug refs,
  added/changed/removed/rebound/same, rebind affinity ≥ 0.6; the internal rebound Map is never serialized)
- `POST /sessions/:id/element-at` `{x,y}` → safe metadata + `source`/`confidence`
- `POST /sessions/:id/elements/resolve` `{refs}` → `ok|rebound|lost` per ref
- `POST /sessions/:id/map-source` `{ref?|selector?|x?,y?}` → `{match}` (fiber → sourcemap-refined heuristic; null below 0.5)
- `POST /sessions/:id/highlight` `{refs?|boxes?, label?, style?: "candidate"|"held"|"hit", clear?}`
- `POST /sessions/:id/annotations` `{items:[…], context?}` → `201 {groupId, items}`;
  `GET /annotations/pending` (screenshot dataUrls are STRIPPED unless `?includeShots=1`;
  `screenshotFile` paths always included); `POST /annotations/ack` `{groupIds}`
- `POST /tests/run` `{projectDir, filter?, extraArgs?, devServer?}` → `202 {runId}` (spawns
  `node <bundled> <pnpm.cjs> exec playwright test` with `VBW_NO_WEBSERVER=1`). CORE-2b: the run
  auto-bootstraps the broker-managed dev server for the SAME projectDir when
  `http://127.0.0.1:<port>` (default 5173, override via `devServer:{port}`) does not answer —
  reuse-first, left running after the run, `devServerStarted` recorded in the run meta.
  `extraArgs` must not contain `-c`/`--config` (400 `BAD_TEST_ARG`); runs are capped by
  `VBW_TEST_MAX_MS` (status `timeout`)
- `GET /tests/runs/:runId` → status, exitCode, parsed summary, logTail, reportDir, devServerStarted
- `POST /ops/:opId/cancel` — cancels test runs / devserver starts / networkidle navigations
  (a cancelled navigation op settles with status `cancelled`)
- `POST /devserver` `{projectDir, port}` → `{devServerId, url}` — fixed argv ONLY
  (`node node_modules/vite/bin/vite.js --port <port> --strictPort`, no shell); a `command`
  parameter is rejected with 400 `BAD_COMMAND` (CORE-2a: exec tier removed); `DELETE /devserver/:id`
- `GET /ui`, `/ui/*` — static UI assets from `public/ui` (files owned by the UI worker)

Mutations are serialized per session (op-lock): a concurrent mutation gets `409 SESSION_BUSY`;
readers (frame, read-text, inventory) run concurrently unless a mutation is in flight (also 409).

## Security invariants (enforced in code)

- Loopback bind + `req.socket.remoteAddress` check — `src/server.mjs` (`isLoopbackAddress` in `src/config.mjs`);
  Host-header allowlist (400 `BAD_HOST`) and timing-safe token compare in `src/server.mjs`.
- Form-field **values** never leave the page: `src/safe-dom.mjs` `VBW.safeValue` (checkbox/radio state or
  static select option only); secret redaction — `src/perception.mjs` `redactText`/`redactIfMatch`, applied to
  read-text (incl. the page title when it matches), inventory labels/names and element metadata.
- URL allowlist — `src/sessions.mjs` `assertAllowedUrl` (http/https only, no credentials, no self/GUI origin,
  normalized hostnames) + post-navigation re-check with `blocked-navigation` quarantine (SEC-10).
- Session ownership gates — `X-VBW-Owner` vs the session lock on every gated call (SEC-1).
- No exec endpoints (`POST /devserver` runs a fixed argv only); no token or host-user-profile absolute
  paths in responses (fiber source names outside the workspace are DROPPED, not returned raw).

Attribution: inventory/delta/overlay concepts ported from NousResearch/hermes-agent
@ 3c79700a6ccf098cd32eeab73c95c2514b2055e3 (MIT); see file headers in `src/safe-dom.mjs`, `src/overlay.mjs`.
