# Visual Browser Workspace (VBW) for DeepSeek Harness

A visual browser environment for agentic web work, inspired by the Hermes Agent desktop
preview: watch a real, Playwright-driven browser, steer it with the mouse, **annotate DOM
elements and regions with numbered comments**, hand the findings (safe DOM metadata + fiber
source mapping + screenshots) to an orchestrating agent, fix the **source files** via subagents,
and prove the result with real **Playwright E2E tests** — all inside a DeepSeek Harness
installation, without modifying Harness core.

Target platform: DeepSeek Harness desktop 0.2.2-rc.1 (win32-x64). Reference study:
NousResearch/hermes-agent @ `3c79700a6ccf098cd32eeab73c95c2514b2055e3` (MIT).

## Components

| Path | What it is |
|---|---|
| [`broker/`](broker/) | Standalone Node service (loopback HTTP, bearer token): browser session broker, Playwright driver (system Chrome/Edge), safe-DOM inventory with Hermes-style delta/rebind, top-layer annotation overlay, source mapper (fiber → sourcemap → heuristic), annotation store, Playwright test runner with dev-server auto-bootstrap. Contract: [`specs/broker-api.md`](specs/broker-api.md) |
| [`broker/public/ui/`](broker/public/ui/) | The Visual Browser UI — vanilla ES modules, no build step: canvas frame streaming, mouse/keyboard forwarding, Annotate Modes (hover/select/region), numbered comments, test-runner panel |
| [`bundle/`](bundle/) | Installable DSH bundle `@local/vbw-bundle`: host plugin with 11 `vbw_*` tools, client-ui sidebar tab, 5 agent-preset roles (`vbw-browser-explorer`, `vbw-ui-inspector`, `vbw-frontend-developer`, `vbw-browser-tester`, `vbw-qa-reviewer`) with least-privilege tool subsets |
| [`demo-app/`](demo-app/) | React 18 + TS + Vite demo target with a real E2E suite (routing, forms, responsive, WCAG contrast) and intentionally documented defects for the fix loop |
| [`docs/`](docs/) | Architecture, install, rollback, limitations, role documentation |
| [`AGENTS.md`](AGENTS.md) | Team rules for the five VBW roles |

## Quick start

```powershell
# 1. start the broker (bundled Harness node or any recent Node; deps: playwright, ws)
cd broker
node src/server.mjs
# facts (port/token/pid) → %LOCALAPPDATA%\vbw\state\broker.json

# 2. open the UI (any browser tab inside Harness: the shipped Browser tab, or plain browser)
#    http://127.0.0.1:8931/ui   (paste the token once)

# 3. demo target
cd demo-app
node node_modules/vite/bin/vite.js --port 5173 --strictPort

# 4. install the DSH bundle (sidebar tab + vbw_* tools + agent presets)
#    see docs/install.md §4
```

## Security posture

Loopback-only bind + Host header validation; random bearer token stored **outside any synced
workspace** (`%LOCALAPPDATA%\vbw\state\`); timing-safe token compare; enforced session
ownership (`409 SESSION_LOCKED` for cross-owner access; explicit takeover); redirect
quarantine; no `file:` navigation; TLS errors rejected by default; secret-pattern redaction
(cards, JWT, AWS/GitHub/Slack/Google keys, hex runs) over page text and titles — best-effort:
screenshots are never redacted; **no exec endpoints** (the dev server spawns a fixed vite argv
only). Input values of form fields never leave the page. Full ledger: `docs/limitations.md`.

## Verified integration (summary)

End-to-end demo loop executed with real artifacts: annotate a WCAG contrast defect in the UI →
group delivered to the orchestrator → React fiber maps it to `src/components/PriceTag.tsx` →
developer role fixes the CSS source → fresh browser session → Playwright suite
**17 passed / 0 failed (exit 0, twice)**. Broker regression: scenario 11/11, edge cases 8/8,
UI self-test 27/27. Details in each component's docs.

## License

MIT — see [LICENSE](LICENSE) (includes third-party attribution for Hermes-derived portions).
