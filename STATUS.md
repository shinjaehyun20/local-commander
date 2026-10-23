# STATUS — Local Commander (Standalone Neutral Edition)

- **Canonical Workspace Path**: `D:\workspace\projects\active\local-commander`
- **Default Runtime State & Auth Path**: `%LOCALAPPDATA%\local-commander` (overridable via `LOCAL_COMMANDER_STATE`)
- **Primary Entrypoints**:
  - Interactive & CLI First-Run Setup Wizard: `npm run setup` (`node setup-wizard.mjs`)
  - Local STDIO MCP Server: `node server.mjs --config config.json`
  - Remote OAuth + Fixed-Address WebSocket Relay Launcher: `node launch.mjs --socket --config <config-path>`
  - Windows Login Auto-Start & 30s Watchdog: `pythonw startup.py --watch --commander-start`

## Current Verification Summary

| Suite | Command | Result |
| :--- | :--- | :--- |
| **Node.js Core, OAuth, Setup Wizard, WS Reconnect & Manifest Tests** | `npm test` | **49 / 49 PASS** |
| **Python PID Identity, Conflict Guard & Supervised Restart Tests** | `python tests/startup_test.py` | **11 / 11 PASS** |
| **Source Manifest SHA-256 Verification (`tests/manifest.test.mjs`)** | Included in `npm test` | **35 / 35 Matched (`Preserved & Verified`)** |
| **Windows GitHub Actions CI** | `.github/workflows/ci.yml` | **Configured (`windows-latest`)** |

## Architecture & Operational Notes

1. **Zero-PII Neutral Packaging & First-Run Setup Wizard (`setup-wizard.mjs`)**:
   - All service identifiers (`local-commander`), OAuth token prefixes (`lc_`), and state paths (`%LOCALAPPDATA%\local-commander`) are neutral and ready for standalone developer setup.
   - `npm run setup` (`setup-wizard.mjs`) guides developers through configuring `readRoots`, `writeRoots`, `allowedExecutables`, and `tunnel.mode`, generating `config.json`, `startup-config.json`, and `%LOCALAPPDATA%\local-commander\client-snippets.json`.
2. **Atomic State Persistence & Corrupt-File Isolation**:
   - `readJsonIfExists` distinguishes missing files (`ENOENT`) from corrupt JSON (preserving `.corrupt-<timestamp>` backups and throwing `ERR_CORRUPT_STATE_JSON` instead of silently resetting), and `writeSecureJson` writes atomically via sibling temp-file replacement.
3. **Verification Scope Boundaries**:
   - Automated tests verify protocol, file safety, Job Object cleanup, OAuth PKCE, corrupt auth preservation, setup wizard config generation, live WebSocket disconnect/reconnect & retry exhaustion, and supervised restart dispatch.
   - Actual Windows logout/login, physical PC reboot, and external Cloudflare Worker provisioning remain host-level operational steps.
