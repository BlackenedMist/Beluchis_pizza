@echo off
setlocal
cd /d "%~dp0"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

nssm.exe stop BeluchisKitchen >nul 2>&1
nssm.exe remove BeluchisKitchen confirm
netsh advfirewall firewall delete rule name="Beluchis Kitchen" >nul 2>&1

echo.
echo Beluchis Kitchen service removed.
echo Your settings (.env and data\) were kept - you can reinstall any time.
pause
exit /b 0