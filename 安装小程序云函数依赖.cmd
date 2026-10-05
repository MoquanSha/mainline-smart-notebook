@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装小程序云函数依赖.ps1"
if errorlevel 1 pause
