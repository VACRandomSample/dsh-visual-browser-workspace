# VBW — Rollback & Uninstall

Everything is additive. Rollback restores the exact pre-VBW state.

## 1. Stop the broker
```powershell
$st = Get-Content "$env:LOCALAPPDATA\vbw\state\broker.json" | ConvertFrom-Json
Stop-Process -Id $st.pid -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\vbw" -Recurse -Force -ErrorAction SilentlyContinue
```
(The pre-hardening location `_vbw\state\broker.json` may still exist from earlier runs — remove
it too if present. Any driven Chrome processes are children of the broker's Playwright — they
close with it; if orphans remain: close the visible windows, they are normal Chrome instances.)

## 2. Unmount the DSH bundle
1. `~/.dsh/profiles/desktop/package.json` — remove the `"@local/vbw-bundle"` dependency line
   AND the `"@local/vbw-bundle"` entry from `dsh.profile.bundles`.
   Pre-VBW copies: `_vbw\backup\profile\package.json`.
2. `pnpm install` in `~/.dsh/profiles/desktop`.
3. Recomposition applies on the next bundles-list change / app start.

## 3. Revert the orchestrator delegation extension
Restore `hierarchical-orchestrator-bundle\cordis.patch.yml` from
`_vbw\backup\ho-bundle\cordis.patch.yml` (removes the 5 `vbw-*` ids from
`allowedAgentPresets` and the persona mention). Pre-VBW copy of its package.json is in
`_vbw\backup\ho-bundle\package.json` (unchanged in place).

## 4. Remove the workspace files (optional, full removal)
Delete `_vbw\` — it contains broker, bundle, demo app, docs, research, state, backups.
If you delete it, keep a copy of `backup\` first (step 2/3 reference it).

## 5. Verification after rollback
- `GET http://127.0.0.1:8931/health` refused (nothing listens).
- New DSH sessions: no `vbw-*` presets, no `vbw_*` tools, GUI sidebar has no VBW tab.
- `~/.dsh/profiles/desktop/cordis.patch.yml` and shipped presets untouched by VBW at any point.

## Never touched by this project
`D:\Programs\Harness` (app.asar and unpacked files), shipped DSH packages, `~/.dsh/AGENTS.md`,
`~/.dsh/profiles/desktop/cordis.patch.yml`, existing sessions and their settings.
