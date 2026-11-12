# Visual Browser Workspace (VBW) — Architecture

Date: 2026-11-12 · Target: DeepSeek Harness 0.2.2-rc.1 (installed desktop, win32-x64)
References: `_vbw\research\hermes-map.md` (Hermes Agent @ 3c79700a6ccf098cd32eeab73c95c2514b2055e3, MIT),
`_vbw\research\harness-audit.md` (Harness 0.2.2-rc.1 capability audit).

## 1. Goal

Open a real website inside the Harness environment, watch and steer a real browser, select DOM
elements / regions with the mouse, attach numbered comments, hand the findings (with safe DOM
metadata + screenshots) to the orchestrating agent, map findings to React/TS sources, fix the
sources via subagents, and prove the fix with real Playwright E2E tests in the same UI.

## 2. Component map

```
┌───────────────────────────── DeepSeek Harness (0.2.2-rc.1, not modified) ─────────────────────────────┐
│  GUI (http://127.0.0.1:31184, dsh-app:// renderer)                                                    │
│  ┌── shipped Sidebar Browser tab (managed Electron <webview>, lease-gated)  ──┐                        │
│  │   shows http://127.0.0.1:8931/ui  →  VBW Visual Browser UI (canvas)        │                        │
│  └────────────────────────────────────────────────────────────────────────────┘                        │
│  ┌── VBW bundle tab (installed @local/vbw-bundle client plugin) ─────────────┐   (phase 2, additive)    │
│  │   sidebarRightTabs.register + slots: same canvas UI, first-class tab      │                          │
│  └────────────────────────────────────────────────────────────────────────────────────────────────────┘
│  Chat session (orchestrator) ── tools/pwsh/HTTP ──▶ VBW Broker REST ──▶ findings back into chat
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
                    │ loopback HTTP/WS (token)                      ▲
                    ▼                                               │ REST (tools proxy)
┌──────────────────────────────────────────────┐          ┌────────┴─────────────────────────┐
│ VBW Broker (standalone node service)          │          │ VBW DSH bundle (@local/vbw-bundle)│
│  - Browser Session Broker: sessions, locks,   │          │  - host plugin: ctx.tools.* proxy │
│    lifecycle, cancellation, idle reaper        │          │    (vbw_* tools) + spawns broker  │
│  - Browser Driver: Playwright + system Chrome │          │  - client plugin: sidebar tab     │
│    (channel=chrome/msedge), separate contexts │          │  - cordis.patch.yml:              │
│  - Annotation Engine: safe DOM metadata,      │          │      5 agent-preset rows, tool    │
│    highlights (top-layer overlay), region     │          │      rows, service row            │
│    screenshots, numbered comment store        │          │  - AGENTS.md role docs            │
│  - Source Mapper: React fiber _debugSource,   │          └───────────────────────────────────┘
│    sourcemaps, heuristic fallback + confidence │
│  - Playwright Test Runner: spawn + parse +     │
│    HTML report, console/failed-request capture │
│  - serves /ui (Visual Browser UI)              │
└──────────────────────────────────────────────┘
```

Deliberate difference from Hermes: Hermes' preview stack is text-only (renderer owns the webview,
`executeJavaScript` for reads, `sendInputEvent` for acts, no screenshots). In Harness 0.2.2-rc.1 a
plugin cannot mint Electron webview guests (audit §3), so VBW owns a **server-side Playwright
browser** and renders it in the UI as a **screenshot canvas**; pointer/keyboard events are forwarded
as Playwright input. This also satisfies "web must not rely on cross-origin iframe DOM access":
the UI never touches the target page's DOM — it only shows JPEG frames and calls broker APIs.

## 3. Components in detail

### 3.1 Browser Session Broker (`_vbw\broker\`, node, ESM)
- Binds `127.0.0.1:8931` only (env `VBW_BROKER_PORT`), bearer-token auth (random, timing-safe
  compare, persisted with pid/port to `%LOCALAPPDATA%\vbw\state\broker.json` — a non-synced
  user-profile path; Host header validated; loopback remoteAddress checked per request).
- Playwright `chromium.launch({ channel: 'chrome' | 'msedge' })` (system browsers; no Chromium
  download). One Browser per broker process; **one BrowserContext per session** → cookie/storage
  isolation for parallel testing; `ignoreHTTPSErrors` defaults to false (per-session opt-in).
- Session model: `{ id, owner ('agent'|'user'|<label>), lock, context, page, createdAt, lastOpAt,
  status }`. Limits: max 4 sessions (env), idle reaper (30 min), explicit `DELETE /sessions/:id`,
  per-session op lock — **enforced**: mutations AND reads check the caller (`X-VBW-Owner`) against
  the lock (409 SESSION_LOCKED; takeover is explicit); closed rows pruned after 1 h, ops after
  10 min. Navigation cancellations are honored (op status `cancelled`); after every navigation the
  landing URL is re-validated (redirect quarantine → `blocked-navigation` until next navigate).
- Screenshots: `page.screenshot({ type:'jpeg', quality:70 })`; region shots use `clip` with
  viewport-relative coords (Playwright semantics at `fullPage:false`). Element screenshots via
  locator. Files also persisted under `_vbw\state\screenshots\`.
- Input: `page.mouse.*`, `page.keyboard.*`, `page.mouse.wheel` — real input events like Hermes'
  "act like a human" discipline; no synthetic `el.click()` chains.
- Annotation Engine (port of Hermes inventory ideas, MIT-notice preserved):
  - inventory selector list + visibility filter + caps (120 agent / 600 overlay) — from
    `act-in-page.ts`, ported;
  - slug refs (`btn-sign-in`, `-1` suffixes, never rewound), delta protocol
    (added/changed/removed/rebound/same), rebind affinity ≥ 0.6, navigation retires refs —
    ported from `survey()` (see hermes-map §3.7–3.8);
  - safe metadata: tag, id, classes, role, aria-label, data-testid, label, text snippet ≤120 chars,
    bounding box, input type (**never input value**), href host+path, `sensitive:true` flag for
    password/credit-card-ish fields — values redacted, never sent;
  - highlight overlay injected into the *driven* page: `<vbw-watch popover="manual">` + closed
    shadow root + `style.setProperty` + `element.animate()` (CSP-safe, top-layer beats page z-index,
    invisible to page scripts and to our own inventory);
  - marks glued to elements: rAF re-measure loop; element gone → mark removed (rides scrolls);
  - numbered comment store: client-side numbering, groups persisted to `_vbw\state\annotations\`,
    fetch/ack API for the agent loop.
- Source Mapper (`visual-to-code`):
  1. React fiber walk: DOM node → `__reactFiber$*` key → fiber chain → `_debugSource {fileName,
     lineNumber}` (React 18 dev builds; **verified working** in `_vbw\tools\probe output` —
     PriceTag.tsx:37 for `price-current`);
  2. sourcemap path: stack traces / `sourcesContent` when `# sourceMappingURL` present (vite
     `build --sourcemap`);
  3. heuristic fallback: data-testid / id / class-name / text grep across `src/**` with confidence
     score 0–1 and evidence list; below 0.5 the mapper says "unreliable" instead of guessing.
- Playwright Test Runner: `POST /tests/run` spawns
  `node <bundled node> pnpm exec playwright test …` in a project dir with
  `VBW_NO_WEBSERVER=1` (broker manages the dev server), captures stdout/exit, parses Playwright
  list output into `{passed, failed, flaky, skipped}`, stores HTML report + traces under
  `_vbw\state\test-runs\<id>\`, cancellable op.
- UI statics served at `/ui` (see 3.2).

### 3.2 Visual Browser UI (`_vbw\broker\public\ui\`, vanilla JS, no build step)
- Canvas view: polls `GET /sessions/:id/frame.jpg` (~6 fps, back-off when tab hidden), draws to
  canvas scaled 1:1 with broker-reported viewport; overlays (hover box, selection box, region
  marquee, numbered pins) drawn client-side in an SVG layer.
- Input forwarding: pointer/keyboard events → `POST /sessions/:id/input` (viewport-relative
  coords; canvas letterboxing handled by the UI).
- Annotate modes: `browse` (pure navigation), `hover` (element highlight under cursor via
  `/element-at`), `select` (click pins element → metadata card + numbered comment editor),
  `region` (drag marquee → region screenshot via `/screenshot?clip=`).
- Numbered comments: list panel; each comment links its evidence (element meta or region shot).
- "Send to chat": `POST /sessions/:id/annotations` with the whole group; UI shows "delivered, awaiting
  orchestrator"; orchestrator pulls via `GET /annotations/pending` (tool `vbw_fetch_annotations`).
- Element rebinding status: after any navigation, UI re-checks pinned elements via `/elements/resolve`
  and marks comments `ok | rebound | lost`.
- Ownership: UI can attach to a session as owner `user` with explicit takeover confirmation when the
  session is locked by `agent` (and vice versa) — the "отдельный механизм владения" requirement.

### 3.3 VBW DSH bundle (`_vbw\bundle\`, installed as `@local/vbw-bundle`)
- `package.json`: `dsh.bundle.patch` → `cordis.patch.yml`; deps: host plugin pkg + client plugin pkg
  (workspace `link:` style like the existing 8 `@local/*` rows).
- Host plugin (`@local/vbw-host`): `ctx.tools.register(defineTool(...))` for:
  `vbw_status`, `vbw_session_open`, `vbw_navigate`, `vbw_screenshot`, `vbw_read_text`,
  `vbw_inventory`, `vbw_element_at`, `vbw_map_source`, `vbw_fetch_annotations`, `vbw_test_run`,
  `vbw_ui_url` — thin HTTP proxy to the broker (spawns `node src/server.mjs` if state file is
  stale/dead). Tools read broker port/token from `_vbw\state\broker.json`.
- Client plugin (`@local/vbw-client-ui`): `dsh.client { inject:["slots","locale","sidebarRight",
  "sidebarRightTabs"], platform:"web" }`; registers tab id `vbw.browser` (kind `browser`, priority
  `extension`) + slot body that embeds the same broker UI in an iframe; adds a guide button
  "Open VBW". Degrades on web profile (iframe carrier note, audit §14.5).
- Patch rows (`cordis.patch.yml`):
  - client-ui row (`vbw-client-ui`),
  - 5 `agent-preset` rows (see §4, below),
  - the `vbw-host` plugin is mounted per-preset through a `vbw-tools` cordis:group row inside the
    4 broker-using presets (NOT at root — a root mount would leak `vbw_*` tools into every preset
    and double-register names; deliberate design, see bundle header comment).
- Does NOT touch: app.asar, shipped presets, HO bundle rows, `~/.dsh/AGENTS.md`.
- Profile wiring (documented install step, performed with backup): add
  `"@local/vbw-bundle": "link:…\_vbw\bundle"` to `~/.dsh/profiles/desktop/package.json` deps and
  `"@local/vbw-bundle"` to `dsh.profile.bundles`; `pnpm install` in the profile dir (playwright +
  ws deps get installed at bundle level). Rollback = remove the two lines (+ `pnpm install`).

### 3.4 Demo app (`_vbw\demo-app\`) — React 18 + TS + Vite + react-router
- Pages: Home, Catalog (search + sale filter + product grid), About (validated contact form),
  404; `data-testid` coverage.
- Two intentional, documented issues for the demo loop: price text `#c9c9c9` on white (WCAG
  contrast fail, `PriceTag.tsx`/`styles.css`) and sub-min tap target `.btn-add` (styles.css).
- E2E: `e2e/smoke.spec.ts` (routes, console-error + failed-request monitoring), `forms.spec.ts`,
  `responsive.spec.ts` (nav clipping + tap target), `contrast.spec.ts` (computed-style WCAG check).
- Baseline (real run, 2026-11-12): **14 passed / 3 failed** — the 3 reds are exactly the intentional
  issues; they go green after the subagent fix loop. First baseline run also caught a real missing
  favicon 404 via console monitoring — fixed by adding `public/favicon.svg`.

### 3.5 Subagent roles (bundle preset rows; orchestrator stays ho-orchestrator)
| preset id | role | tools |
|---|---|---|
| `vbw-browser-explorer` | drives the browser, gathers findings | vbw_* browser tools + fs-read + web-fetch |
| `vbw-ui-inspector` | annotates, maps visuals→sources | vbw_* + fs-read (no write) |
| `vbw-frontend-developer` | fixes source files | fs read/write/edit + pwsh (project scope by instructions) |
| `vbw-browser-tester` | runs Playwright suites | vbw_test_run + fs-read + pwsh |
| `vbw-qa-reviewer` | reviews diffs & test evidence | fs-read only (+web) |
Delegation depth for vbw presets: none (workers). One-level delegation from orchestrator only.
Concurrency: ≤4 active children (host allows 6; self-limit 4), separate browser contexts per
session; file-write conflicts prevented by path ownership in task prompts.

## 4. Integration flow (the success criterion)

1. `vbw_session_open {url: demo-app}` (or user opens UI tab, browses).
2. User selects element in Annotate Mode → numbered comment → "Send to chat".
3. `vbw_fetch_annotations` → group with safe metadata + fiber source (`PriceTag.tsx:37`) + shots.
4. Orchestrator delegates: `vbw-ui-inspector` verifies mapping; `vbw-frontend-developer` edits
   `styles.css`/`PriceTag.tsx` (real source change); `vbw-browser-tester` re-runs Playwright.
5. Test report + screenshots delivered back into chat; UI shows the fixed page.

## 5. Security posture (hardened after R1 code review + R2 security audit)
- Broker: loopback-only + Host header validation, random bearer token (timing-safe compare)
  stored OUTSIDE the synced workspace (`%LOCALAPPDATA%\vbw\state\`), no CORS `*` for mutations
  (token required), input values never extracted, extended secret-pattern redaction (cards,
  JWT, AWS/GitHub/Slack/Google keys, hex-32+) over text and matched titles, session cap,
  ownership gates on reads and mutations, idle reaper, op cancellation (navigations included),
  redirect quarantine, no `file:` navigation, TLS errors rejected by default,
  **no exec endpoints** (the dev server spawns a fixed vite argv only; `command` param removed).
- The driven browser is a normal user-profile-free Chromium context; broker never touches
  `D:\Programs\Harness` or app.asar.
- UI: no third-party code; no XSS sinks (all page-derived strings via textContent);
  token only in localStorage + Authorization headers (query-param path removed).
- Bundle tools: standard DSH tool gating applies; `vbw_test_run` (exec-tier) is mounted only for
  tester/developer presets — explorer/inspector get the read/drive subset (least privilege);
  presets for vbw roles are read-or-scoped-write per the table above.
- Fail-safe rollback: uninstall = remove profile dep + bundles entry (+ pnpm install), delete
  `%LOCALAPPDATA%\vbw\`, kill broker by recorded pid; nothing outside `_vbw\` + two profile
  lines changes.

## 6. What is verified vs experimental (honesty ledger)
- Verified during this project (real outputs): demo app build+typecheck, Playwright baseline run,
  fiber `_debugSource` mapping probe, pnpm/node/Chrome availability, DSH audit facts.
- Implemented in-repo, exercised in integration phase: broker endpoints, UI, bundle mounting.
- Experimental (documented, not guaranteed): client-plugin tab mounting on the live GUI (depends on
  profile recomposition), web-profile iframe carrier, source-map fallback quality beyond React dev
  builds, WebSocket streaming (v1 uses JPEG polling).
