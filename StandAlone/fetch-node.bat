@echo off
rem Fetches the Node.js runtime that the Beluchis kitchen bridge runs on.
rem
rem   fetch-node.bat          install it, or repair a damaged copy
rem   fetch-node.bat check    only report what is there, change nothing
rem
rem The download comes from nodejs.org and is checked against the SHA256
rem checksums that nodejs.org publishes - once for the zip, and again for the
rem node.exe inside it. Anything that fails the check is thrown away and never
rem run. node.exe is digitally signed by the OpenJS Foundation, so Windows
rem SmartScreen and Defender treat it as the genuine article.
rem
rem Re-running this is harmless. If bin\node.exe is already the exact build we
rem expect, it does nothing at all.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "NODE_VERSION=22.23.2"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip"
set "NODE_ZIP_SHA=1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
set "NODE_EXE_SHA=0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4"
set "TARGET=bin\node.exe"

if /i "%~1"=="check" goto :check
goto :install


rem ===========================================================================
rem report only
rem ===========================================================================
:check
if not exist "%TARGET%" (
  echo MISSING  bin\node.exe has not been downloaded yet
  exit /b 1
)
call :sha "%TARGET%" H
if /i "!H!"=="%NODE_EXE_SHA%" (
  echo ok  Node.js %NODE_VERSION% is installed and the checksum matches
  exit /b 0
)
echo BAD  bin\node.exe is not the expected Node %NODE_VERSION% build
exit /b 1


rem ===========================================================================
rem install or repair
rem ===========================================================================
:install

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: powershell.exe is missing from this computer.
  echo        Windows itself looks damaged - please repair or reinstall it.
  pause
  exit /b 1
)

call :sha "%TARGET%" H
if /i "!H!"=="%NODE_EXE_SHA%" (
  echo Node.js %NODE_VERSION% is already installed and verified - nothing to do.
  exit /b 0
)
if exist "%TARGET%" (
  echo.
  echo WARNING: the existing bin\node.exe is not the expected Node %NODE_VERSION%
  echo          build. It may be damaged, removed by antivirus software, or
  echo          left over from a different version. It will be replaced.
  echo.
)

rem --- scratch folder -------------------------------------------------------
set "TMP=%TEMP%\beluchis-node"
if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%" 2>nul
if not exist "%TMP%" (
  echo.
  echo ERROR: could not create a working folder at %TMP%
  echo        The TEMP folder may be full or read-only.
  pause
  exit /b 1
)
set "ZIP=%TMP%\node.zip"
set "WORK=%TMP%\unpack"
set "BELUCHIS_ZIP=%ZIP%"
set "BELUCHIS_WORK=%WORK%"
set "BELUCHIS_DL_URL=%NODE_URL%"
set "BELUCHIS_DL_OUT=%ZIP%"

rem --- download -------------------------------------------------------------
echo Downloading Node.js %NODE_VERSION% - about 30 MB - from nodejs.org
echo   %NODE_URL%
echo   On a slow line this can take a minute. Do not close this window.
echo.

call :download
if errorlevel 1 goto :dlfail

rem --- verify the zip -------------------------------------------------------
call :sha "%ZIP%" ZH
if /i "!ZH!"=="%NODE_ZIP_SHA%" goto :zipok

echo.
echo ERROR: the downloaded file is damaged, so it was not used.
echo        expected  %NODE_ZIP_SHA%
echo        got       !ZH!
goto :failhint

:zipok

rem --- unpack ---------------------------------------------------------------
echo Unpacking...
mkdir "%WORK%" 2>nul
call :extract
if errorlevel 1 goto :extractfail

set "SRC=%WORK%\node-v%NODE_VERSION%-win-x64\node.exe"
if not exist "!SRC!" (
  echo.
  echo ERROR: the Node package did not contain the file we expected:
  echo        "!SRC!"
  goto :failhint
)

rem --- verify the exe -------------------------------------------------------
call :sha "!SRC!" EH
if /i "!EH!"=="%NODE_EXE_SHA%" goto :exeok

echo.
echo ERROR: the unpacked node.exe is not the expected build, so it was not used.
echo        expected  %NODE_EXE_SHA%
echo        got       !EH!
goto :failhint

:exeok

rem --- put it in place, then check it again --------------------------------
if not exist "bin" mkdir "bin" 2>nul
copy /y "!SRC!" "%TARGET%" >nul
if errorlevel 1 (
  echo.
  echo ERROR: could not write to bin\node.exe
  echo        Close the kitchen page and any window showing this folder,
  echo        then run start-kitchen.bat again.
  goto :failhint
)

call :sha "%TARGET%" FH
if /i "!FH!"=="%NODE_EXE_SHA%" goto :ok

echo.
echo ERROR: bin\node.exe did not survive the copy intact.
echo        Close anything that might be holding the file, then try again.
goto :failhint

:ok
rmdir /s /q "%TMP%" 2>nul
echo.
echo Node.js %NODE_VERSION% installed and verified.
"%TARGET%" -v
exit /b 0


rem ===========================================================================
rem what went wrong
rem ===========================================================================
:dlfail
echo.
echo ERROR: the download from nodejs.org did not finish.
echo        Check the internet connection on this computer and try again.
goto :failhint

:extractfail
echo.
echo ERROR: the downloaded package could not be unpacked.
echo        Windows may be missing its built-in unzip support.
goto :failhint

:failhint
rmdir /s /q "%TMP%" 2>nul
echo.
echo The kitchen bridge runs on Node.js, so it cannot start without it.
echo If this keeps happening, run check-env.bat and send the result.
pause
exit /b 1


rem ===========================================================================
rem helpers
rem ===========================================================================
rem :sha <file> <variable>  - puts the uppercase SHA256 hex in <variable>
:sha
set "%~2="
if not exist "%~1" exit /b 1
set "BELUCHIS_HASH_PATH=%~1"
for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "(Get-FileHash -LiteralPath $env:BELUCHIS_HASH_PATH -Algorithm SHA256).Hash" 2^>nul`) do set "%~2=%%H"
set "BELUCHIS_HASH_PATH="
exit /b 0

rem :download  - fetches %BELUCHIS_DL_URL% to %BELUCHIS_DL_OUT%
rem curl ships with Windows 10 and later. The PowerShell fallback is for the
rem older machines that may still be in the restaurant.
:download
set "DL_RC=0"
where curl.exe >nul 2>&1
if errorlevel 1 goto :dl_powershell
curl.exe -fL --retry 3 --retry-delay 3 --connect-timeout 20 -o "%BELUCHIS_DL_OUT%" "%BELUCHIS_DL_URL%"
set "DL_RC=!errorlevel!"
goto :dl_done
:dl_powershell
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile($env:BELUCHIS_DL_URL, $env:BELUCHIS_DL_OUT)"
set "DL_RC=!errorlevel!"
:dl_done
exit /b %DL_RC%

rem :extract  - unpacks %BELUCHIS_ZIP% into %BELUCHIS_WORK%
rem The built-in tar reads zips fine, but if it is missing or refuses the file
rem we fall back to Expand-Archive rather than giving up.
:extract
tar.exe -xf "%BELUCHIS_ZIP%" -C "%BELUCHIS_WORK%" >nul 2>&1
if not errorlevel 1 exit /b 0
powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:BELUCHIS_ZIP -DestinationPath $env:BELUCHIS_WORK -Force" >nul 2>&1
exit /b %errorlevel%
