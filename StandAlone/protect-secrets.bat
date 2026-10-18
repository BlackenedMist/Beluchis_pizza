@echo off
setlocal
cd /d "%~dp0"
title Protect the passwords in .env

rem DPAPI with LocalMachine scope needs administrator rights - a per-user blob
rem would not be readable by the bridge, which runs as SYSTEM.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0protect-secrets.ps1"
echo.
pause