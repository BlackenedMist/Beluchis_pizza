@echo off
setlocal
cd /d "%~dp0"
title Install Beluchis Kitchen service

net session >nul 2>&1
if errorlevel 1 (
  echo Run this as administrator: right-click, Run as administrator.
  pause
  exit /b 1
)

if not exist ".env" (
  echo .env is missing. Run start-kitchen.bat once to create it and set the PIN.
  pause
  exit /b 1
)
if not exist "bin\nssm.exe" (
  echo Missing bin\nssm.exe - the package is incomplete.
  pause
  exit /b 1
)

rem --- clean any previous install ----------------------------------------
nssm.exe stop BeluchisKitchen >nul 2>&1
nssm.exe remove BeluchisKitchen confirm >nul 2>&1

echo Installing service...
nssm.exe install BeluchisKitchen "%~dp0bin\node.exe" "--env-file=.env" "server.mjs"
if errorlevel 1 (
  echo nssm install failed. Are bin\nssm.exe and .env present?
  pause
  exit /b 1
)

nssm.exe set BeluchisKitchen AppDirectory "%~dp0"
nssm.exe set BeluchisKitchen AppStdout "%~dp0beluchis-kitchen.log"
nssm.exe set BeluchisKitchen AppStderr "%~dp0beluchis-kitchen.err.log"
nssm.exe set BeluchisKitchen AppRotateFiles 1
nssm.exe set BeluchisKitchen AppRotateOnline 1
nssm.exe set BeluchisKitchen AppRotateBytes 10485760
nssm.exe set BeluchisKitchen Start SERVICE_AUTO_START
nssm.exe set BeluchisKitchen AppExit Default Restart
nssm.exe set BeluchisKitchen AppRestartDelay 3000
nssm.exe set BeluchisKitchen DisplayName "Beluchis Kitchen Bridge"

rem --- let other kitchen screens on the network open the page --------------
netsh advfirewall firewall delete rule name="Beluchis Kitchen" >nul 2>&1
netsh advfirewall firewall add rule name="Beluchis Kitchen" dir=in action=allow protocol=TCP localport=3101 >nul

echo Starting service...
nssm.exe start BeluchisKitchen
if errorlevel 1 (
  echo Service failed to start - check beluchis-kitchen.err.log
  pause
  exit /b 1
)

echo.
echo Installed and running.
echo   Kitchen page : http://localhost:3101/
echo   Auto-starts : every time the computer starts
echo   Log file    : beluchis-kitchen.log
pause
exit /b 0