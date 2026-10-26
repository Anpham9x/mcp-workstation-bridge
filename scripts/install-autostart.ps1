param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$NodePath = (Get-Command node -ErrorAction Stop).Source
$hash = [System.Security.Cryptography.SHA256]::Create()
$suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectRoot)))).Replace('-', '').Substring(0, 12)
$TaskName = "MCP Workstation Bridge $suffix"
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'Removed login/watchdog task. The current runtime is unchanged.'
  exit 0
}
$CliPath = Join-Path $PSScriptRoot 'bridge.mjs'
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$CliPath`" start" -WorkingDirectory $ProjectRoot
$login = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$watchdog = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($login, $watchdog) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Installed login + 5-minute supervisor watchdog: $TaskName"
