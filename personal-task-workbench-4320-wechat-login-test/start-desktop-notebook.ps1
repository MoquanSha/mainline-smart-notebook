param([switch]$Quit)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"

if (-not (Test-Path -LiteralPath $electron)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "桌面版运行时尚未安装完成。请让 Codex 完成主线笔记可靠性测试版安装。",
    "主线笔记无法启动"
  ) | Out-Null
  exit 1
}

# The Electron single-instance lock keeps this test build separate from all
# old 4317/4320/4420 services. Quit uses the same lock and never kills by PID.
$arguments = @('"' + $root + '"')
if ($Quit) { $arguments += "--quit-reliability-instance" }
Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden
