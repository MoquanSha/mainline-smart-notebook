$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Ask this exact Electron identity to quit through its single-instance lock.
# Generic node/server PID matching could terminate an old 4317/4320/4420 app.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "start-desktop-notebook.ps1") -Quit
