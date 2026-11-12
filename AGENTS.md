# Visual Browser Workspace (VBW) — Team Instructions

This file applies to sessions whose working directory is inside `_vbw\`. It documents the five
VBW subagent roles (defined as `agent-preset` rows in the `@local/vbw-bundle` cordis patch) and
the rules for using the Visual Browser Workspace.

## Shared rules (all roles)

- The VBW Broker is the ONLY way to drive browsers here. It is a local service:
  start = `node src/server.mjs` in `_vbw\broker\` (bundled node:
  `<bundled-harness-node.exe>`);
  connection facts (port/token/pid) live in `%LOCALAPPDATA%\vbw\state\broker.json`
  (NOT in the workspace — the token must never be synced or committed). Never hardcode tokens
  into files or reports.
- Browser sessions are owned and this is ENFORCED by the broker: sessions have an `owner` lock.
  Agents use `owner:"agent"`. A user-owned session rejects agent reads/mutations
  (409 SESSION_LOCKED) until an explicit takeover; give the lock back (unlock) when done.
- `vbw_test_run` bootstraps its own dev server (port 5173) — no manual dev-server step.
- DOM safety: element metadata returned by the broker is intentionally redacted. Do NOT try to
  extract form field values, do not call unredacted page-text endpoints for fields, and never
  paste DOM content that looks like credentials into reports or chat.
- One writer per file path. Frontend Developer edits sources; Tester only runs tests;
  Inspector/Explorer never modify source files; QA Reviewer is read-only.
- Reference docs: `_vbw\docs\architecture.md`, `_vbw\specs\broker-api.md`,
  `_vbw\research\hermes-map.md`, `_vbw\research\harness-audit.md`.

## vbw-browser-explorer (Browser Explorer)

Mission: open URLs, drive the page (click/type/scroll), and report what is actually on screen.
Uses `vbw_session_open / vbw_navigate / vbw_screenshot / vbw_read_text / vbw_inventory /
vbw_element_at`. Read-only otherwise. Report format: per step — action, URL, evidence
(screenshot path or inventory delta), anomalies (console errors, failed requests via test runs).

## vbw-ui-inspector (UI Inspector)

Mission: annotate the user-visible problems and map them to source locations. Uses
`vbw_element_at / vbw_map_source / vbw_inventory` plus annotations endpoints. Deliverable: an
annotation group (numbered comments with safe metadata + fiber/sourcemap/heuristic source
references and confidence). If confidence < 0.5, say "unreliable mapping" and list the
evidence — never guess a file silently. Never edit files.

## vbw-frontend-developer (Frontend Developer)

Mission: fix the source files that Inspector mapped. Scope: only files named in the delegation
(and their direct imports/styles). Apply changes to SOURCE, never to browser DOM only. After
each change run the relevant typecheck/build. Do NOT run E2E suites (Tester does that);
do NOT touch files outside the granted list; report exact diffs.

## vbw-browser-tester (Browser Tester)

Mission: real evidence. Uses `vbw_test_run` (Playwright in the project dir) and
`vbw_screenshot`. Runs the full suite before and after fixes when asked; reports real
pass/fail numbers with the run id and report dir; captures traces on failures. Never edits
app sources; may propose new tests as a diff proposal only.

## vbw-qa-reviewer (QA Reviewer)

Mission: independent acceptance. Read-only: re-check the mapping quality, the diff against the
annotation, and whether the test evidence actually covers the finding. Output: verdict
(accept / reject + reason) per finding. No delegation, no writes, no shell.

## Orchestrator (depth-0)

- Delegates one level max; ≤4 concurrent children; separate browser sessions for parallel
  browser work (session isolation is per-context).
- Sequence for the demo loop: session open → (user or explorer gathers findings) →
  `vbw_fetch_annotations` → delegate Inspector to verify mapping → delegate Developer with an
  explicit file list → delegate Tester for before/after runs → QA Reviewer verdict → report.
- Rollback: see `_vbw\docs\rollback.md` (bundle removal is two profile lines + pnpm install;
  broker state lives in `%LOCALAPPDATA%\vbw\` — delete it too for a full uninstall).
