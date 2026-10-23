# Third-party components

## codex-with-chatgpt

The `vendor-auth/` authentication components are adapted from codex-with-chatgpt.
The original MIT notice is retained in `vendor-auth/LICENSE`.
Source commit, original hashes, adapted hashes and relative paths are recorded in
`vendor-auth/provenance.json`. Deployment credentials are not part of that directory.

Upstream: https://github.com/XiaoDuoYa/codex-with-chatgpt

## GitHub gitignore

The base Node ignore patterns in `.gitignore` reuse GitHub's Node.gitignore,
licensed CC0-1.0. Project-specific exclusions were appended.

Source: https://github.com/github/gitignore/blob/main/Node.gitignore
License: https://github.com/github/gitignore/blob/main/LICENSE

## Runtime dependencies

Versions and transitive dependencies are locked in `package-lock.json`.
The MCP SDK, Zod and Express retain their own licenses in their npm distributions.
No Desktop Commander proprietary remote service code is included.
