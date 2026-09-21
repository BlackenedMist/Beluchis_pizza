@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

sc query BeluchisKitchen >nul 2>&1
if errorlevel 1 (
  echo No Beluchis Kitchen service found.
  pause
  exit /b 1
)

nssm.exe stop BeluchisKitchen
echo.
echo Stopped for now. It will start again on the next computer start.
echo Use uninstall-service.bat to remove it completely.
pause
exit /b 0