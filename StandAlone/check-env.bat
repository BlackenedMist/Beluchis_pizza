@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Beluchis Kitchen - machine check

set "TASKNAME=BeluchisKitchen"

echo.
echo   Beluchis Kitchen Bridge - machine check
echo   =========================================
echo.

echo   1. The app files
if exist "server.mjs"        (echo        [ ok ]  server.mjs)             else (echo        [BAD ]  server.mjs is missing - was this opened from inside a zip?)
if exist "lib\poller.mjs"    (echo        [ ok ]  lib\poller.mjs)         else (echo        [BAD ]  lib\poller.mjs is missing - extract the whole zip to a folder)
if exist "public\index.html" (echo        [ ok ]  public\index.html)      else (echo        [BAD ]  public\index.html is missing)
if exist "run-kitchen.cmd"   (echo        [ ok ]  run-kitchen.cmd)        else (echo        [BAD ]  run-kitchen.cmd is missing - the package is incomplete)
echo.

echo   2. The Node.js runtime
call "%~dp0fetch-node.bat" check
if errorlevel 1 (echo        ->  run start-kitchen.bat, it will download it) else (echo        [ ok ]  the checksum matches the build we expect)
echo.

echo   3. Your settings in .env
if exist ".env" (
  findstr /r /c:"^SOURCE_PIN=." ".env" >nul 2>&1
  if errorlevel 1 (echo        [WARN]  SOURCE_PIN is still empty) else (echo        [ ok ]  SOURCE_PIN is set)
  findstr /r /c:"^SOURCE_BASE_URL=." ".env" >nul 2>&1
  if errorlevel 1 (echo        [WARN]  SOURCE_BASE_URL is empty) else (echo        [ ok ]  SOURCE_BASE_URL is set)
) else (
  echo        [BAD ]  .env does not exist - run start-kitchen.bat
)
echo.

echo   4. Starting automatically with Windows
schtasks /query /tn "%TASKNAME%" >nul 2>&1
if errorlevel 1 (
  echo        [WARN]  the "%TASKNAME%" scheduled task is not installed
  echo                run start-kitchen.bat to install it
) else (
  echo        [ ok ]  the "%TASKNAME%" scheduled task is installed
  echo        --- what Windows recorded about it ---
  schtasks /query /tn "%TASKNAME%" /v /fo list
  echo        --- end ---
)
echo.

echo   5. Is the bridge answering?
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://localhost:3101/api/status' | Out-Null; '        [ ok ]  the kitchen page answered on port 3101' } catch { '        [DOWN]  nothing answered on port 3101 - the bridge is not running' }"
echo.

echo   6. The log file
if exist "beluchis-kitchen.log" (
  echo        --- last 15 lines of beluchis-kitchen.log ---
  powershell -NoProfile -Command "Get-Content -Tail 15 'beluchis-kitchen.log'"
  echo        --- end of log ---
) else (
  echo        there is no beluchis-kitchen.log yet
)
echo.

echo   Anything marked [BAD ] or [DOWN] above is the reason it is not working.
echo   Send this whole screen to whoever set the bridge up.
echo.
pause
