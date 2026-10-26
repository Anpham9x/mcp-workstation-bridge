# Compatibility entry point for the fixed MCP self-recovery tool. No tunnel.
$ErrorActionPreference = 'Stop'
& (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'bridge.mjs') start
if ($LASTEXITCODE -ne 0) { throw 'Bridge start failed' }
