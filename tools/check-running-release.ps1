$ErrorActionPreference = 'SilentlyContinue'

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'personal-task-workbench-4320-wechat-login-test'
$identity = Get-Content (Join-Path $app 'shared/build-identity.json') -Raw | ConvertFrom-Json
$ports = @(4430, 4420)
$found = $false
$unexpected = $false

$rootProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'electron.exe' -and
  $_.ExecutablePath -and
  $_.ExecutablePath -like (Join-Path $app 'node_modules/electron/dist/electron.exe') -and
  $_.CommandLine -and
  $_.CommandLine -notmatch '--type='
}
foreach ($process in $rootProcesses) {
  $found = $true
  $window = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
  $title = if ($window) { $window.MainWindowTitle } else { '' }
  Write-Host "MATCH process=$($process.ProcessId) title=$title version=$($identity.version) release=$($identity.releaseSet)"
}

foreach ($port in $ports) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
    $found = $true
    $release = $health.build.releaseSet
    $version = $health.build.version
    if ($release -eq $identity.releaseSet -and $version -eq $identity.version) {
      Write-Host "MATCH port=$port version=$version release=$release"
    } else {
      $unexpected = $true
      $reported = if ($version) { $version } else { 'legacy-or-unknown' }
      Write-Host "UNEXPECTED port=$port version=$reported expected=$($identity.version)"
    }
  } catch {
    # A closed port is expected. The script is a read-only checker.
  }
}

if (-not $found) {
  Write-Host 'NO_RUNNING_MAINLINE_INSTANCE'
  exit 1
}
if ($unexpected) {
  Write-Host 'STALE_MAINLINE_INSTANCE_DETECTED close the legacy window before device acceptance'
  exit 2
}
