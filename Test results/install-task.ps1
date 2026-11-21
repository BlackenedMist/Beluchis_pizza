$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Root 'run-battery.ps1'
$At     = (Get-Date).Date.AddHours(23).AddMinutes(50)

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Scheduled"
$Trigger = New-ScheduledTaskTrigger -Once -At $At
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'BeluchisTestBattery' -Action $Action -Trigger $Trigger `
  -Principal $Principal -Settings $Settings -Force `
  -Description 'ONE-SHOT: Beluchis order/state test battery at 23:50. Self-removes after running.' | Out-Null

$t = Get-ScheduledTask -TaskName 'BeluchisTestBattery'
$i = Get-ScheduledTaskInfo -TaskName 'BeluchisTestBattery'
Write-Host "Registered: BeluchisTestBattery"
Write-Host "Next run : $($i.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "State    : $($t.State)"
Write-Host "Action   : $($Action.Execute) $($Action.Argument)"
