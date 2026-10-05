param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'personal-task-workbench-4320-wechat-login-test'
$unpacked = Join-Path $app 'release-1.1.63-reliability.3\win-unpacked'
$exe = Join-Path $unpacked '主线笔记可靠性测试版.exe'
$identityPath = Join-Path $unpacked 'resources\app\shared\build-identity.json'
$packagePath = Join-Path $unpacked 'resources\app\package.json'

if (!(Test-Path -LiteralPath $exe)) { throw "Packaged executable not found: $exe" }
if (!(Test-Path -LiteralPath $identityPath)) { throw "Packaged build identity not found: $identityPath" }
$identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
if ($package.version -ne $identity.version) { throw "Packaged version mismatch: package.json=$($package.version), build identity=$($identity.version)" }

$dataRoot = Join-Path $env:LOCALAPPDATA $identity.dataFolder
$env:MAINLINE_RELIABILITY_DATA_ROOT = $dataRoot
$legacyListener = @(Get-NetTCPConnection -LocalPort 4420 -State Listen -ErrorAction SilentlyContinue)
if ($legacyListener.Count -gt 0) {
  throw '检测到旧版主线笔记仍在 4420 端口运行，请先关闭旧窗口再启动可靠性测试版。'
}
Write-Host "Product: Mainline Notebook Reliability Test"
Write-Host "Version: $($identity.version) / release: $($identity.releaseSet)"
Write-Host "Packaged executable: $exe"
Write-Host "Data folder: $dataRoot"
if ($VerifyOnly) { exit 0 }
& $exe
exit $LASTEXITCODE
