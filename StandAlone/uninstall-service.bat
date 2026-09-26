@echo off
setlocal
cd /d "%~dp0"
title Remove Beluchis Kitchen

set "TASKNAME=BeluchisKitchen"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

call :stopbridge
schtasks /delete /tn "%TASKNAME%" /f >nul 2>&1
del /q "%~dp0BeluchisKitchen.xml" >nul 2>&1
netsh advfirewall firewall delete rule name="Beluchis Kitchen" >nul 2>&1

echo.
echo Beluchis Kitchen removed. It will no longer start with Windows.
echo.
echo Your settings were kept - .env and data\ are still in this folder, so you
echo can put it back any time with start-kitchen.bat.
pause
exit /b 0


rem ===========================================================================
rem helpers
rem ===========================================================================
rem Stop the task and make sure no bridge process is left running.
rem Task Scheduler does not always take the child process down with it, and a
rem survivor would keep running with nothing left to manage it.
:stopbridge
schtasks /end /tn "%TASKNAME%" >nul 2>&1
set "BELUCHIS_DIR=%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' | Where-Object CommandLine -like ('*' + $env:BELUCHIS_DIR + '*') | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
exit /b 0
