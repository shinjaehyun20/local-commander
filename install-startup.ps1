$ErrorActionPreference = 'Stop'
$commanderConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-config.json') -Raw | ConvertFrom-Json
$commanderPythonw = Join-Path (Split-Path $commanderConfig.python) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $commanderPythonw)) { throw 'pythonw.exe is missing.' }
$commanderLinkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Local Commander Recovery.lnk'
$commanderShell = New-Object -ComObject WScript.Shell
$commanderLink = $commanderShell.CreateShortcut($commanderLinkPath)
$commanderArguments = '"' + (Join-Path $PSScriptRoot 'startup.py') + '" --watch'
if ((Test-Path -LiteralPath $commanderLinkPath) -and ($commanderLink.TargetPath -ne $commanderPythonw -or $commanderLink.Arguments -ne $commanderArguments)) {
    throw 'An existing startup shortcut has different ownership; preserve it.'
}
$commanderLink.TargetPath = $commanderPythonw
$commanderLink.Arguments = $commanderArguments
$commanderLink.WorkingDirectory = $PSScriptRoot
$commanderLink.WindowStyle = 7
$commanderLink.Description = 'Recover approved Local Commander fixed tunnels after user login'
$commanderLink.Save()
$commanderReadback = $commanderShell.CreateShortcut($commanderLinkPath)
if ($commanderReadback.TargetPath -ne $commanderPythonw -or $commanderReadback.Arguments -ne $commanderArguments) { throw 'Startup read-back failed.' }
Write-Output ('Registered current-user login recovery: ' + $commanderLinkPath)
