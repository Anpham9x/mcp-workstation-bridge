# Queue outside the MCP child, which will be stopped by its own supervisor.
$ErrorActionPreference = 'Stop'
$NodePath = (Get-Command node -ErrorAction Stop).Source
$CliPath = Join-Path $PSScriptRoot 'bridge.mjs'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Start-Process -FilePath $NodePath -ArgumentList @(('"' + $CliPath + '"'), 'restart') -WorkingDirectory $ProjectRoot -WindowStyle Hidden
Write-Output 'Restart queued. Reconnect the MCP client and verify health.'
