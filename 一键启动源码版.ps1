$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $repoRoot 'personal-task-workbench-4320-wechat-login-test'
if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
  $root = $repoRoot
}
$nodeCandidates = @(
  $env:MAINLINE_NODE_PATH,
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    '没有找到 Node.js 22。请先安装 Node.js 22，或设置 MAINLINE_NODE_PATH 指向 node.exe。',
    '主线笔记无法启动'
  ) | Out-Null
  exit 1
}

$version = (& $node --version).Trim()
if ($version -notmatch '^v(\d+)' -or [int]$Matches[1] -lt 22) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "当前 Node.js 版本为 $version，需要 Node.js 22 或更高版本。",
    '主线笔记无法启动'
  ) | Out-Null
  exit 1
}

$npm = Join-Path (Split-Path -Parent $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npm)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    '没有找到 npm。请重新安装 Node.js 22。',
    '主线笔记无法启动'
  ) | Out-Null
  exit 1
}

Set-Location -LiteralPath $root
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Write-Host '第一次启动，正在安装依赖。之后启动会跳过这一步。'
  & $node $npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host '正在构建并启动主线笔记桌面端。'
& $node $npm run desktop:dev
exit $LASTEXITCODE
