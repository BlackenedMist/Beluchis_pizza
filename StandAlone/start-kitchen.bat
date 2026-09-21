@echo off
setlocal
cd /d "%~dp0"
title Beluchis Kitchen Bridge

if not exist "bin\node.exe" (
  echo Missing bin\node.exe - the package is incomplete. Please download it again.
  pause
  exit /b 1
)
if not exist "bin\nssm.exe" (
  echo Missing bin\nssm.exe - the package is incomplete. Please download it again.
  pause
  exit /b 1
)

rem --- first run: create .env and ask for the admin PIN -------------------
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo.
    echo  First run: your .env file was created and has opened in Notepad.
    echo.
    echo  Inside it, set the website admin PIN next to  SOURCE_PIN=  ,
    echo  save and close Notepad, then run this file again.
    echo.
    start "" notepad ".env"
    pause
    exit /b 0
  ) else (
    echo Missing .env.example - the package is incomplete. Please download it again.
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

rem --- install the service on first start ---------------------------------
sc query BeluchisKitchen >nul 2>&1
if errorlevel 1 (
  echo Installing Beluchis Kitchen as a Windows service...
  call "%~dp0install-service.bat"
  if errorlevel 1 exit /b 1
)

echo.
echo Kitchen bridge is running. Open the kitchen page:
echo   http://localhost:3101/
start "" "http://localhost:3101/"
exit /b 0