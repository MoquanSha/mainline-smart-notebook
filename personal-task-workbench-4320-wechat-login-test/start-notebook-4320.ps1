$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Legacy 4320 shortcut. It cannot attach to an arbitrary service or launch a
# disconnected server.mjs; the Electron test build owns sync and identity.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "start-desktop-notebook.ps1")
