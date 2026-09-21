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
  echo Service is not installed - run start-kitchen.bat first.
  pause
  exit /b 1
)

nssm.exe restart BeluchisKitchen
echo.
echo Restarted. Open the kitchen page:
echo   http://localhost:3101/
timeout /t 2 >nul
start "" "http://localhost:3101/"
exit /b 0