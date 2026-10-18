@echo off
setlocal
cd /d "%~dp0"
title Beluchis Kitchen Bridge

rem --- is the whole app actually here? -------------------------------------
rem Windows copies just ONE file out of a zip when you double-click a file
rem inside it, so the rest of the app never arrives. Say so plainly instead of
rem blaming the download.
if not exist "server.mjs" goto :fromzip
if not exist "lib\poller.mjs" goto :fromzip
if not exist "public\index.html" goto :fromzip

rem --- first run: create .env and ask for the admin PIN -------------------
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo.
    echo  First run: your .env file was created and has opened in Notepad.
    echo.
    echo  Inside it, set two things:
    echo    SOURCE_PIN=       the website admin PIN (ask the owner)
    echo    BRIDGE_PASSWORD=  a password for the kitchen page
    echo  Then save and close Notepad and run this file again.
    echo.
    start "" notepad ".env"
    pause
    exit /b 0
  ) else (
    echo Missing .env.example - the package is incomplete.
    pause
    exit /b 1
  )
)

rem --- services and firewall rules need an administrator -----------------
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

rem --- get the Node.js runtime. Downloads it the first time, repairs it if
rem --- the file is damaged or antivirus software removed it. --------------
call "%~dp0fetch-node.bat"
if errorlevel 1 (
  echo.
  echo The kitchen bridge cannot start without Node.js. See the message above.
  pause
  exit /b 1
)

rem --- encrypt the PIN and the page password in .env ------------------------
rem Done on every start rather than once, because it is a no-op once they are
rem already stored as *_ENC, and it means the secrets are never left in .env
rem in readable text just because someone edited the file in Notepad.
if exist "protect-secrets.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0protect-secrets.ps1" >nul
)

rem --- install on first start --------------------------------------------
schtasks /query /tn "BeluchisKitchen" >nul 2>&1
if errorlevel 1 (
  echo Installing Beluchis Kitchen to start automatically with Windows...
  call "%~dp0install-service.bat"
  if errorlevel 1 exit /b 1
)

echo.
echo Kitchen bridge is running. Open the kitchen page:
echo   http://localhost:3101/
start "" "http://localhost:3101/"
exit /b 0


rem ===========================================================================
rem helpers
rem ===========================================================================
:fromzip
echo.
echo  It looks like you opened this file from inside the zip.
echo.
echo  Windows only copies ONE file out of a zip when you double-click a file
echo  inside it, so the rest of the kitchen bridge is not there.
echo.
echo  What to do instead:
echo    1. Right-click the zip file  ->  Extract All...
echo    2. Extract it to a real folder, such as  C:\Beluchis-Kitchen
echo    3. Open start-kitchen.bat inside that folder
echo.
pause
exit /b 1
