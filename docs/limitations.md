# VBW — Limitations & Honesty Ledger

Date: 2026-11-12 · Status after integration phase.

## Actually verified with real outputs (during this project)
1. Demo app: pnpm install, `tsc --noEmit` clean, `vite build` success.
2. Playwright baseline on system Chrome (channel `chrome`): **14 passed / 3 failed** — the 3
   failures are the intentional demo defects (price contrast, tap target desktop+mobile).
   First baseline run also caught a real missing-favicon 404 via console monitoring (fixed).
3. React fiber visual-to-code: DOM `price-current` → `src/components/PriceTag.tsx:37`,
   `origin:"fiber"`, `confidence:0.95` — via broker `element-at`/`map-source` (T3 VERIFY.md,
   re-confirmed by broker smoke).
4. Broker: loopback+token auth (401 shape), sessions with isolated contexts (cookie isolation
   proven), op-locks (409 SESSION_BUSY), idle reaper (3 s env test), URL guard (file:/data:/FTP/
   credentials/own-origin/GUI-origin 403s), redaction (5 patterns → «redacted»), annotations
   pending/ack, test runner with cancel (202→cancelled) and real summary (14/3/20.2 s),
   `/ui` statics + relative projectDir (fixed during integration, re-verified live).
5. UI self-test (Playwright-driven, against live broker): 25 pass — session create, frame
   rendering (pixel-sampled), click forwarding, hover tooltip with source, select-pin with
   metadata, region pin, send-group → pending queue, runner run+cancel, takeover dialog,
   unlock-on-close, letterbox coordinate mapping (<0.5 px error).
6. Bundle: 36/36 static validations; ho-* sessions unaffected (vbw tools do NOT leak — proven
   by two independent ho-explorer probes); YAML/manifest/syntax checks all pass.
7. Profile wiring: pnpm link installed (exit 0); recomposition semantics per dsh-hmr README
   (bundles-list change triggers recomposition).

## Implemented, exercised end-to-end, but with known caveats
- **Subagent role presets (`vbw-*`)**: fully defined and validated (patch + AGENTS.md + persona
  + tool mounting). NOT yet exercised in a live delegated session from THIS conversation: the
  running session's delegation enum froze at start (5 attempts to emit `vbw-browser-explorer`
  snapped back to the ho-* enum — runtime behavior, documented in the report). New orchestrator
  sessions can delegate into the roles after the profile recomposition/restart.
- **GUI tab (`vbw.browser`)**: client plugin written per the audited sidebar-right contract and
  byte-exact `__ModuleLoader__.load` wrapper; static validators pass. Live mounting in the GUI
  was not visually confirmed from this session (no GUI auth token available to headless checks;
  restart may be required). Fallback path (shipped Browser tab → `127.0.0.1:8931/ui`) is the
  documented, working way to open the UI today.
- **`defineTool` source**: the pinned `@deepseek-ai/dsh-tools` is not on npm; a registry-shape
  replica is used when the real package is not resolvable. Contract verified against the
  compiled lib; live in-host tool execution awaits first vbw-preset session.

## Experimental (documented, not guaranteed)
- Source-map fallback channel (only local dev servers with inline maps; fiber channel is primary).
- **Fiber line numbers drift**: file + element identity attribution is reliable (verified 0.95
  confidence), but `_debugSource` lineNumbers reference the served (esbuild-transformed) dev
  module, not the original source — found live by the Inspector: annotation said
  `PriceTag.tsx:37` while the real span is at line 18. Consumers must treat line numbers as
  approximate and re-verify by reading the file (the QA flow does this).
- Heuristic source search quality beyond data-testid/id/class/text matches (confidence-gated).
- WebSocket streaming (v1 is JPEG polling at ~6 fps; input latency ≈ poll interval).
- Multi-window/multi-session UI management beyond the single-session picker.
- Non-React frameworks for visual-to-code (architecture supports plugging mappers; only React
  dev-build fiber mapping is implemented).

## Out of scope / not possible without core changes (audit §14.6, §15)
- Plugin-created Electron webview guests (lease ownership hardcoded to the shipped Browser).
- Per-tab CDP access to sidebar webview guests.
- Modifying `app.asar`, shipped presets, or HO runtime caps (maxDepth 2 / pool 6 kept).
- Camera/mic/print/downloads inside driven sessions (broker does not grant them).

## Shared-environment notes
- Windows: killing the broker cross-process leaves a stale pid in `broker.json` (consumers
  check liveness; documented). `SIGTERM` graceful path is in-process only.
- OneDrive workspace: heavy node_modules live under `_vbw` (pnpm store on C: default; junctions
  tolerated). If sync churn matters, move the store via `store-dir` env.
- Port conflicts: broker 8931, dev server 5173 (strictPort), GUI 31184 — verified free at handoff.
