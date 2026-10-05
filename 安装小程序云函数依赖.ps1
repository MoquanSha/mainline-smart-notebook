$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$mini = Join-Path $repo 'wechat-mini-program-0.10.37-login-copy-20260905'
$node = if ($env:MAINLINE_NODE_PATH) { $env:MAINLINE_NODE_PATH } elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { "$env:ProgramFiles\nodejs\node.exe" } elseif (Test-Path "$env:LOCALAPPDATA\Programs\nodejs\node.exe") { "$env:LOCALAPPDATA\Programs\nodejs\node.exe" } else { '' }
if (-not $node) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('未找到 Node.js 22 或更高版本。请先安装 Node.js，再重新运行。', '主线笔记'); exit 1 }
$npm = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npm)) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('当前 Node.js 没有附带 npm，无法安装云函数依赖。', '主线笔记'); exit 1 }
$functions = Get-ChildItem -LiteralPath (Join-Path $mini 'cloudfunctions') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
foreach ($function in $functions) {
  Write-Host "安装 $($function.Name) 依赖..."
  & $node $npm install --prefix $function.FullName --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "云函数 $($function.Name) 依赖安装失败。" }
}
Write-Host '全部云函数依赖已安装。'
Read-Host '按回车关闭'
