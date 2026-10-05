@echo off
set "SCRIPT=%~dp0open-packaged-reliability.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
