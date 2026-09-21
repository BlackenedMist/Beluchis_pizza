@echo off
cd /d "%~dp0"
echo Node version:
"bin\node.exe" -v
echo.
echo NSSM version:
"bin\nssm.exe" version | findstr /i "NSSM"
pause