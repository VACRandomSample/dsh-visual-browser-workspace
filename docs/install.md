# VBW — Installation & Setup (DeepSeek Harness 0.2.2-rc.1, Windows)

## 0. Requirements (verified on this machine)
- DeepSeek Harness desktop 0.2.2-rc.1 (`desktop-runtime.json`: win32-x64).
- Bundled runtime: node 24.21.0 (`<bundled-harness-node.exe>`),
  pnpm 11.28.5 (`…\dependencies\pnpm\bin\pnpm.cjs`).
- Google Chrome or Microsoft Edge installed (Playwright uses `channel:'chrome'`; no browser download).
- `_vbw\` present in the workspace (broker, bundle, demo app are pre-built; no build step needed).

## 1. Start the broker (required for browser features)
```powershell
$env:PATH = 'D:\Programs\Harness\resources\runtime\primary-runtime\dependencies\node\bin;' + $env:PATH
node src/server.mjs        # cwd: _vbw\broker
```
- Facts (port/token/pid) are written to `%LOCALAPPDATA%\vbw\state\broker.json` (NOT under the
  OneDrive-synced workspace — the token never leaves the user profile); never copy the token
  into reports. Loopback-only; everything except `GET /health` and `GET /ui*` needs
  `Authorization: Bearer <token>`. Session ownership is enforced: the UI owns its tabs as
  `user`; agent tools cannot read or drive them without an explicit takeover.
- Auto-start: the `vbw_*` DSH tools spawn the broker on demand (`autoSpawn: true` in the bundle).
- Dev server for tests: `vbw_test_run` / `POST /tests/run` auto-bootstraps a broker-managed
  vite server (fixed argv, port 5173 default) — no manual step needed.

## 2. Open the Visual Browser UI
- Any browser tab inside Harness: `http://127.0.0.1:8931/ui`
  (works in the shipped Sidebar → Browser tab; the page asks for the broker token once).
- After step 4, a dedicated **VBW Browser** tab appears in the GUI right sidebar
  (client plugin `@local/vbw-client-ui`, iframe carrier to the same URL).

## 3. The demo target
- `_vbw\demo-app` — React 18 + TS + Vite. Dev server: `node node_modules/vite/bin/vite.js --port 5173 --strictPort`
  (or let the broker manage it: `POST /devserver {"projectDir":"_vbw\\demo-app","port":5173}`).
- E2E baseline: `pnpm exec playwright test` → documented state is **14 passed / 3 failed**
  (the 3 failures are the intentional demo defects: price contrast, tap target ×2).

## 4. Mount the DSH bundle (adds VBW tab + vbw_* tools + 5 agent roles)
Performed for this machine (backup in `_vbw\backup\`):
1. `~/.dsh/profiles/desktop/package.json` — dependencies += 
   `"@local/vbw-bundle": "link:<vbw>/bundle"`,
   and `dsh.profile.bundles` += `"@local/vbw-bundle"`.
2. `pnpm install` in `~/.dsh/profiles/desktop` (exit 0 verified).
3. Recomposition: per `dsh-hmr` semantics a change to the ordered `dsh.profile.bundles` list
   triggers recomposition of the running host; otherwise it applies at next app start.
4. Optional (done here, backed up): `hierarchical-orchestrator-bundle\cordis.patch.yml` —
   ho-orchestrator `allowedAgentPresets` extended with the five `vbw-*` ids so orchestrator
   sessions can delegate into the new roles. New sessions pick this up; a session that was
   already open keeps its delegation enum from start time (verified live during integration).

## 5. Verify installation
- `GET http://127.0.0.1:8931/health` → `{"ok":true,…}`.
- New DSH session with preset **VBW · Browser Explorer** → `vbw_status` tool responds
  (requires the broker running; autoSpawn otherwise).
- GUI right sidebar shows the **VBW Browser** tab.

## 6. Notes
- Everything is workspace-local except the two profile lines from step 4 (backed up).
- The broker owns no global state; sessions/context die with the process.
- Playwright browsers are NOT downloaded (system Chrome via `channel`).
