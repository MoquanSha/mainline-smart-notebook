@echo off
set "SCRIPT=%~dp0check-running-release.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
