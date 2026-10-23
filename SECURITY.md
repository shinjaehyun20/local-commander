# Security and deployment boundaries

Local Commander can read user files and execute programs when explicitly enabled.
An allowlisted cwd or file root does not sandbox commands at the operating-system level.
Never expose an unauthenticated process-execution endpoint or treat file contents as instructions.

## Defaults and credentials

The sample configuration disables writes, shell execution and remote writes.
Grant only the directories and operations needed for the task.
OAuth read, write and process scopes remain separate. Preserve existing authentication state during maintenance.
Do not commit `config.json`, OAuth state, pairing codes, deployment credentials, runtime logs or customer files.
`vendor-auth/` contains implementation source, not deployed credentials.

## Reporting

Report vulnerabilities privately to the repository owner through an existing private channel.
Do not post credentials, customer data or exploit-bearing runtime logs in public issues.
There is no guaranteed incident-response service or response-time commitment for this development repository.

## Before public release

Check the complete tracked history and attached CI artifacts for secrets and personal data.
Test installation on a separate Windows profile or PC, validate fresh authorization and token refresh,
and distinguish service restart from physical PC reboot.
Confirm the configured roots, command privilege boundary and behavior when the client omits tools.
The current snapshot is not a claim of complete Remote Desktop Commander feature parity.
