@echo off
rem Started by the BeluchisKitchen scheduled task, on every boot and again
rem whenever it needs restarting.
rem
rem Task Scheduler cannot send a program's output to a file, so this wrapper
rem does it. It also caps the log size, which is what the old nssm log
rem rotation used to do.
rem
rem Do not run this by hand. Use start-kitchen.bat, restart-service.bat or
rem stop-service.bat instead.

cd /d "%~dp0"
setlocal

set "LOG=%~dp0beluchis-kitchen.log"

rem Once the log passes 10 MB, move it aside and start a fresh one.
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GEQ 10485760 move /y "%%F" "%%F.1" >nul 2>&1

"%~dp0bin\node.exe" --env-file=.env server.mjs >> "%LOG%" 2>&1
exit /b %errorlevel%
