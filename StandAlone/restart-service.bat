@echo off
setlocal
cd /d "%~dp0"
title Restart Beluchis Kitchen

set "TASKNAME=BeluchisKitchen"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

schtasks /query /tn "%TASKNAME%" >nul 2>&1
if errorlevel 1 (
  echo Beluchis Kitchen is not installed - run start-kitchen.bat first.
  pause
  exit /b 1
)

call :stopbridge
schtasks /run /tn "%TASKNAME%" >nul

echo.
echo Restarted. Open the kitchen page:
echo   http://localhost:3101/
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:3101/"
exit /b 0


rem ===========================================================================
rem helpers
rem ===========================================================================
rem Stop the task and make sure no bridge process is left running.
rem Task Scheduler does not always take the child process down with it, and a
rem survivor would fight the new process for port 3101.
:stopbridge
schtasks /end /tn "%TASKNAME%" >nul 2>&1
set "BELUCHIS_DIR=%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object CommandLine -like ('*' + $env:BELUCHIS_DIR + '*') | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
exit /b 0
