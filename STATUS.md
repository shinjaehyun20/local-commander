# STATUS — Local Commander

Updated on **2026-10-24 (KST)**. This document records the repository's public release state, verified CI test coverage, and operational boundaries.

## Repository status and source of truth

- **Repository:** [shinjaehyun20/local-commander](https://github.com/shinjaehyun20/local-commander), branch `main`.
- **Visibility:** **Public** (MIT License).
- **Identity:** `local-commander` is the standalone neutral distribution of the maintainer's Windows MCP server.

## Verified capabilities and documentation scope

- **ChatGPT integration:** Actively used in the maintainer's Windows deployment via a fixed HTTPS endpoint and outbound **CommanderSocketRelay v1** WebSocket transport (`launch-socket.mjs` / `relay-socket-client.mjs`).
- **Secondary local STDIO templates:** `setup-wizard.mjs` prints configuration snippets for **Claude Desktop, Cursor, and Codex CLI**. Those snippets are provided as local STDIO configuration templates; live application sessions in those third-party clients are verified per host installation.
- **Multi-session concurrency & autonomous execution (Option A):**
  - [`server.mjs`](server.mjs) sets MCP tool annotations to `{readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: !mutating.has(name)}` while preserving `catalogSha256`, preventing multi-tab ChatGPT sessions from hanging on repetitive confirmation modals while enforcing all root/hash/scope guards server-side.
  - [`core.mjs`](core.mjs) exempts `write_file` with `mode: "append"` from `expectedSha256` lock contention, returns `(currentSha256=...)` in `write_file`/`edit_block` conflict errors for immediate retry recovery, and supports up to **16 concurrent supervised process sessions** (`Sixteen concurrent sessions maximum`).
- **README structure:** Uses the Hero Architecture Banner (`assets/hero-banner.jpg`) + ChatGPT-first B design (`assets/readme-hero.svg`), a 5-second positioning comparison table, a GitHub-native Mermaid architecture diagram, 3 copy-paste starter prompts, explicit `readRoots`/`writeRoots` configuration examples, and a full Korean v2.0 guide.

## Windows CI and automated test verification

| Suite | Scope | Command | Result |
| :--- | :--- | :--- | :--- |
| **Node.js test suite (49 tests)** | Core file/process policy, symlink/junction guards, UTF-16/CRLF preservation, OAuth 2.1 + PKCE, atomic state persistence, WebSocket & HTTP relays, setup wizard canonical path handling (`fs.realpathSync.native` for Windows 8.3 short paths), and `SOURCE_MANIFEST.json` SHA-256 verification | `npm test` (`node --test`) | **49 passed, 0 failed** |
| **Python supervisor & startup suite (11 tests)** | Windows Job Object process tree supervision (`supervise.py`) and login recovery (`startup.py`) | `python tests/startup_test.py` | **11 passed, 0 failed** |

### Root cause fixed in Windows Actions CI (`verify-windows`)

1. **Cross-platform test discovery:** Updated `package.json` `"test"` script from `node --test tests/*.test.mjs` (which passed a literal unexpanded wildcard on Windows Node 20) to `node --test`, and configured `.github/workflows/ci.yml` to run the Python verification step with `if: ${{ !cancelled() }}`.
2. **Windows 8.3 short-path (`RUNNER~1`) canonicalization:** On GitHub Actions `windows-latest`, `os.tmpdir()` resolves under `C:\Users\RUNNER~1\AppData\Local\Temp`, whereas `Commander` canonicalizes configured roots via `fs.realpathSync.native` (`C:\Users\runneradmin\...`). Updated [`setup-wizard.mjs`](setup-wizard.mjs) and [`tests/setup-wizard.test.mjs`](tests/setup-wizard.test.mjs) to normalize root directories with `fs.realpathSync.native`, resolving the `Outside allowed roots` mismatch on Windows runners.

## Operational facts to preserve

- **Setup:** `npm run setup` writes `config.json` and prints client snippets (`--print-clients` or interactive mode). `startup-config.json` is written when `--write-startup-config` is specified. No `client-snippets.json` file is generated. Valid repeatable root flags are `--read-root` and `--write-root`. See [`setup-wizard.mjs`](setup-wizard.mjs).
- **Process access:** Controlled by the `allowShell` boolean switch; there is no executable allowlist. Launched programs run with the Windows user's permissions, and file-tool roots do not act as an OS-level process sandbox. See [`core.mjs`](core.mjs).
- **Remote transport:** [`relay-socket-client.mjs`](relay-socket-client.mjs) connects outward to a compatible **CommanderSocketRelay v1** service at `/_relay/connect`. The included [`relay-worker.mjs`](relay-worker.mjs) implements a separate HTTP upstream relay using `/_relay/register`.
- **Pairing:** [`launch-socket.mjs`](launch-socket.mjs) restores the server/relay connection using existing auth state; initial pairing codes are created through `remote.mjs` or `launch.mjs`.
- **State persistence:** Default Windows runtime state lives in `%LOCALAPPDATA%\local-commander` (overridable via `LOCAL_COMMANDER_STATE`). Atomic JSON writes and corrupt-state backups are implemented in [`vendor-auth/config/paths.js`](vendor-auth/config/paths.js).
- **Login recovery:** [`install-startup.ps1`](install-startup.ps1) registers the Windows Scheduled Task separately and requires a Python installation containing `pythonw.exe`.
