$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Legacy shortcut alias. It uses the same isolated reliability test identity.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "start-desktop-notebook.ps1")
