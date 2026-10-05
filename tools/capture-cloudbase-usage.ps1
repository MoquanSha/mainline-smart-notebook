param(
  [Parameter(Mandatory = $true)]
  [string]$EnvId,
  [Parameter(Mandatory = $true)]
  [string]$StartDate,
  [Parameter(Mandatory = $true)]
  [string]$EndDate,
  [Parameter(Mandatory = $true)]
  [string]$Output,
  [double]$WindowHours = 0,
  [switch]$MigrationOnly
)

$ErrorActionPreference = 'Stop'
$node = $env:MAINLINE_NODE_PATH
$cli = $env:CLOUDBASE_CLI_PATH

if ([string]::IsNullOrWhiteSpace($node)) { throw '请设置 MAINLINE_NODE_PATH 指向 node.exe' }
if ([string]::IsNullOrWhiteSpace($cli)) { throw '请设置 CLOUDBASE_CLI_PATH 指向 CloudBase CLI' }

if (!(Test-Path -LiteralPath $node)) { throw "固定 Node 运行时不存在: $node" }
if (!(Test-Path -LiteralPath $cli)) { throw "CloudBase CLI 不存在: $cli" }

function Invoke-CloudBaseJson([string[]]$Arguments) {
  # Windows PowerShell turns the CLI's progress messages on stderr into
  # NativeCommandError records when ErrorActionPreference is Stop. Keep those
  # messages in the captured text so the final JSON payload can still be parsed.
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& $node $cli @Arguments 2>&1)
    $raw = ($lines | ForEach-Object { $_.ToString() }) -join "`n"
  }
  finally { $ErrorActionPreference = $previousErrorAction }
  $match = [regex]::Match($raw, '(?s)(\{.*\})\s*$')
  if (!$match.Success) { throw "CloudBase CLI 没有返回 JSON。`n$raw" }
  try { return ($match.Groups[1].Value | ConvertFrom-Json) }
  catch { throw "CloudBase CLI JSON 无法解析。`n$raw" }
}

function Get-Metric($Info, [string]$Module, [string]$MetricName) {
  $moduleData = @($Info.data.modules | Where-Object { $_.module -eq $Module })
  $detail = @($moduleData.details | Where-Object { $_.metricName -eq $MetricName }) | Select-Object -First 1
  if ($null -eq $detail) { return 0 }
  return [double]$detail.value
}

function Has-Metric($Info, [string]$Module, [string]$MetricName) {
  $moduleData = @($Info.data.modules | Where-Object { $_.module -eq $Module })
  $detail = @($moduleData.details | Where-Object { $_.metricName -eq $MetricName }) | Select-Object -First 1
  return $null -ne $detail
}

$usage = Invoke-CloudBaseJson @('env', 'usage', '--env-id', $EnvId, '--json', '--yes')
$info = Invoke-CloudBaseJson @('env', 'info', '--env-id', $EnvId, '--start', $StartDate, '--end', $EndDate, '--json', '--yes')
$capturedAt = (Get-Date).ToUniversalTime().ToString('o')

$metrics = [ordered]@{
  apiCalls = Get-Metric $info 'APIInvocation' 'CloudBase API call count'
  miniProgramApiCalls = Get-Metric $info 'APIInvocation' 'Mini Program API call count'
  noSqlReadRequests = Get-Metric $info 'FLEXDB' 'ReadRequests'
  noSqlWriteRequests = Get-Metric $info 'FLEXDB' 'WriteRequests'
  cloudFunctionInvocations = Get-Metric $info 'SCF' 'Cloud Functions - invocation count'
  storageReadRequests = Get-Metric $info 'COS' 'Cloud storage read requests'
  storageWriteRequests = Get-Metric $info 'COS' 'Cloud storage write requests'
  trafficBytes = (Get-Metric $info 'COS' 'CDN origin traffic') + (Get-Metric $info 'COS' 'CDN traffic (cloud storage traffic)')
  idleActivity = 0
}

# CloudBase's billing snapshot can report FLEXDB credits while a narrow
# `env info` period still returns zero request counters.  Keep this ambiguity
# explicit so a zero is never mistaken for a zero-traffic observation.
$flexUsage = @($usage.data.usages | Where-Object { $_.module -eq 'FLEXDB' } | Select-Object -First 1)
$flexCredits = if ($flexUsage.Count -gt 0) { [double]$flexUsage[0].creditsValue } else { 0 }
$coverageWarnings = New-Object System.Collections.Generic.List[string]
$requiredMetrics = @(
  @('APIInvocation', 'CloudBase API call count'),
  @('FLEXDB', 'ReadRequests'),
  @('FLEXDB', 'WriteRequests'),
  @('SCF', 'Cloud Functions - invocation count')
)
foreach ($requiredMetric in $requiredMetrics) {
  if (!(Has-Metric $info $requiredMetric[0] $requiredMetric[1])) {
    $coverageWarnings.Add("env info did not return metric $($requiredMetric[0])/$($requiredMetric[1]) for this period.")
  }
}
if ($flexCredits -gt 0 -and [double]$metrics.noSqlReadRequests -eq 0 -and [double]$metrics.noSqlWriteRequests -eq 0) {
  $coverageWarnings.Add('FLEXDB billing credits are non-zero but env info returned zero read/write requests for this period; repeat with a complete billing-cycle range before using as release evidence.')
}
$metricCoverage = [ordered]@{
  complete = ($coverageWarnings.Count -eq 0)
  warnings = @($coverageWarnings)
  infoPeriod = $info.data.period
  billingUsageFlexdbCredits = $flexCredits
  source = 'CloudBase billing usage cross-check against env info metrics'
}

$result = [ordered]@{
  capturedAt = $capturedAt
  environmentId = $EnvId
  period = [ordered]@{ startDate = $StartDate; endDate = $EndDate }
  windowHours = $WindowHours
  migrationOnly = [bool]$MigrationOnly
  metrics = $metrics
  metricCoverage = $metricCoverage
  usage = $usage.data
  info = $info.data
  source = 'CloudBase CLI env usage and env info read-only query'
  note = if ($WindowHours -ge 24 -and !$MigrationOnly) { 'Candidate evidence; release preflight still checks environment and metrics fields.' } else { 'Starting snapshot only; do not use as final 24-hour release evidence.' }
}

$parent = Split-Path -Parent $Output
if ($parent -and !(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$json = $result | ConvertTo-Json -Depth 40
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Output, $json + [Environment]::NewLine, $utf8NoBom)
Get-Content -Raw -LiteralPath $Output
