@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Install Beluchis Kitchen

set "TASKNAME=BeluchisKitchen"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

if not exist ".env" (
  echo .env is missing. Run start-kitchen.bat once to create it and set the PIN.
  pause
  exit /b 1
)
if not exist "bin\node.exe" (
  echo bin\node.exe is missing. Run fetch-node.bat to download it.
  pause
  exit /b 1
)
if not exist "run-kitchen.cmd" (
  echo run-kitchen.cmd is missing - the package is incomplete.
  pause
  exit /b 1
)

rem --- clear out any previous version ---------------------------------------
call :stopbridge

rem --- write the task definition -------------------------------------------
rem Windows will only read a task file as UTF-16, so it is written as plain
rem text here and converted to UTF-16 just below.
set "XML=%~dp0BeluchisKitchen.xml"
set "BELUCHIS_XML=%XML%"
set "RUNNER=%~dp0run-kitchen.cmd"
set "BELUCHIS_RUNNER=%RUNNER%"

(
  echo ^<?xml version="1.0" encoding="UTF-16"?^>
  echo ^<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"^>
  echo   ^<RegistrationInfo^>
  echo     ^<Author^>Beluchis^</Author^>
  echo     ^<Description^>Beluchis Kitchen Bridge - prints new online orders on the kitchen printer.^</Description^>
  echo   ^</RegistrationInfo^>
  echo   ^<Triggers^>
  echo     ^<BootTrigger^>
  echo       ^<Enabled^>true^</Enabled^>
  echo       ^<Delay^>PT30S^</Delay^>
  echo     ^</BootTrigger^>
  echo   ^</Triggers^>
  echo   ^<Principals^>
  echo     ^<Principal id="Author"^>
  echo       ^<UserId^>S-1-5-18^</UserId^>
  echo       ^<LogonType^>ServiceAccount^</LogonType^>
  echo       ^<RunLevel^>HighestAvailable^</RunLevel^>
  echo     ^</Principal^>
  echo   ^</Principals^>
  echo   ^<Settings^>
  echo     ^<MultipleInstancesPolicy^>IgnoreNew^</MultipleInstancesPolicy^>
  echo     ^<DisallowStartIfOnBatteries^>false^</DisallowStartIfOnBatteries^>
  echo     ^<StopIfGoingOnBatteries^>false^</StopIfGoingOnBatteries^>
  echo     ^<AllowHardTerminate^>true^</AllowHardTerminate^>
  echo     ^<StartWhenAvailable^>true^</StartWhenAvailable^>
  echo     ^<RunOnlyIfNetworkAvailable^>false^</RunOnlyIfNetworkAvailable^>
  echo     ^<IdleSettings^>
  echo       ^<StopOnIdleEnd^>false^</StopOnIdleEnd^>
  echo       ^<RestartOnIdle^>false^</RestartOnIdle^>
  echo     ^</IdleSettings^>
  echo     ^<AllowStartOnDemand^>true^</AllowStartOnDemand^>
  echo     ^<Enabled^>true^</Enabled^>
  echo     ^<Hidden^>true^</Hidden^>
  echo     ^<RunOnlyIfIdle^>false^</RunOnlyIfIdle^>
  echo     ^<WakeToRun^>false^</WakeToRun^>
  echo     ^<ExecutionTimeLimit^>PT0S^</ExecutionTimeLimit^>
  echo     ^<Priority^>7^</Priority^>
  echo     ^<RestartOnFailure^>
  echo       ^<Interval^>PT1M^</Interval^>
  echo       ^<Count^>999^</Count^>
  echo     ^</RestartOnFailure^>
  echo   ^</Settings^>
  echo   ^<Actions Context="Author"^>
  echo     ^<Exec^>
  echo       ^<Command^>%SystemRoot%\System32\cmd.exe^</Command^>
  echo       ^<Arguments^>/c ""!RUNNER!""^</Arguments^>
  echo       ^<WorkingDirectory^>%~dp0^</WorkingDirectory^>
  echo     ^</Exec^>
  echo   ^</Actions^>
  echo ^</Task^>
) > "%XML%"

powershell -NoProfile -Command "$p = $env:BELUCHIS_XML; $t = [IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, $t, [Text.Encoding]::Unicode)"
if errorlevel 1 (
  echo ERROR: could not prepare the task definition file.
  pause
  exit /b 1
)

rem --- create it ------------------------------------------------------------
echo Installing the "%TASKNAME%" scheduled task...
schtasks /create /tn "%TASKNAME%" /xml "%XML%" /f
if errorlevel 1 (
  echo.
  echo ERROR: Windows refused to create the scheduled task.
  echo The message from Windows is printed above. The usual cause is that this
  echo folder was moved or renamed after it was installed. Move it back, or
  echo delete BeluchisKitchen.xml and run this file again.
  pause
  exit /b 1
)

rem --- let other kitchen screens on the network open the page ---------------
rem This opens port 3101 to any machine that can reach this one. Narrowing it
rem to the local subnet is a separate decision, because the kitchen screens
rem are not all on the same network segment.
netsh advfirewall firewall delete rule name="Beluchis Kitchen" >nul 2>&1
netsh advfirewall firewall add rule name="Beluchis Kitchen" dir=in action=allow protocol=TCP localport=3101 >nul

rem --- start it -------------------------------------------------------------
echo Starting it...
schtasks /run /tn "%TASKNAME%" >nul
if errorlevel 1 (
  echo.
  echo The task was installed but would not start. Run check-env.bat to see why.
  pause
  exit /b 1
)

echo.
echo Installed and running.
echo   Kitchen page : http://localhost:3101/
echo   Auto-starts : every time the computer starts
echo   Managed as   : Task Scheduler, task name "BeluchisKitchen"
echo   Log file     : beluchis-kitchen.log
pause
exit /b 0


rem ===========================================================================
rem helpers
rem ===========================================================================
rem Stop the task and make sure no bridge process is left running.
rem
rem Task Scheduler does not always take the child process down with it. If one
rem survives, the next start fights it for port 3101 and both could try to
rem print the same order, so this is not optional.
:stopbridge
schtasks /end /tn "%TASKNAME%" >nul 2>&1
schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1
set "BELUCHIS_DIR=%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object CommandLine -like ('*' + $env:BELUCHIS_DIR + '*') | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
exit /b 0
