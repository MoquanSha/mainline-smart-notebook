param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'personal-task-workbench-4320-wechat-login-test'
$identityPath = Join-Path $app 'shared/build-identity.json'
$packagePath = Join-Path $app 'package.json'
$electron = Join-Path $app 'node_modules/electron/dist/electron.exe'

$identity = Get-Content $identityPath -Raw | ConvertFrom-Json
$package = Get-Content $packagePath -Raw | ConvertFrom-Json
if ($package.version -ne $identity.version) {
  throw "测试版版本不一致：package.json=$($package.version)，build identity=$($identity.version)"
}
if (-not (Test-Path $electron)) {
  throw "缺少测试版 Electron：$electron"
}

$dataRoot = Join-Path $env:LOCALAPPDATA $identity.dataFolder
$env:MAINLINE_RELIABILITY_DATA_ROOT = $dataRoot
Write-Host "Product: Mainline Notebook Reliability Test"
Write-Host "Version: $($identity.version) / release: $($identity.releaseSet)"
Write-Host "Data folder: $dataRoot"
if ($VerifyOnly) { exit 0 }
& $electron $app
exit $LASTEXITCODE
