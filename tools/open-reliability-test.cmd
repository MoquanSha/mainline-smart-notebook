@echo off
set "SCRIPT=%~dp0open-reliability-test.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
