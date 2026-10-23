$ErrorActionPreference = 'Stop'
$commanderConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
& $commanderConfig.python (Join-Path $PSScriptRoot 'startup.py') --commander-start
if ($LASTEXITCODE -ne 0) { throw 'Commander recovery failed. Read startup-status.json.' }
