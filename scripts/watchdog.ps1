[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$NodePath = "node",
  [string]$BridgeScript = "dist/src/main.js",
  [string]$BridgeCommand = "serve",
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )
  return (Resolve-Path -LiteralPath $PathValue).Path
}

function Write-WatchdogLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )
  $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
  Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value "[$timestamp] $Message"
}

function Get-ProcessTable {
  return @(Get-CimInstance Win32_Process)
}

function Test-BridgeProcess {
  param(
    [Parameter(Mandatory = $true)]
    $Process
  )
  $commandLine = [string]$Process.CommandLine
  $normalized = $commandLine.Replace("\", "/")
  return ($Process.Name -ieq "node.exe" -and $normalized -match "dist/src/main\.js" -and $normalized -match "\bserve\b")
}

function Get-ProcessDescendants {
  param(
    [Parameter(Mandatory = $true)]
    [array]$AllProcesses,
  [Parameter(Mandatory = $true)]
    [int]$RootProcessId
  )
  $descendants = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $current = [int]$queue.Dequeue()
    foreach ($child in @($AllProcesses | Where-Object { [int]$_.ParentProcessId -eq $current })) {
      [void]$descendants.Add($child)
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return @($descendants)
}

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [array]$AllProcesses,
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId
  )
  $children = Get-ProcessDescendants -AllProcesses $AllProcesses -RootProcessId $RootProcessId
  foreach ($child in @($children | Sort-Object ProcessId -Descending)) {
    try {
      Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
      Write-WatchdogLog "stopped child process pid=$($child.ProcessId) name=$($child.Name)"
    } catch {
      Write-WatchdogLog "failed to stop child process pid=$($child.ProcessId): $($_.Exception.Message)"
    }
  }
  try {
    Stop-Process -Id $RootProcessId -Force -ErrorAction Stop
    Write-WatchdogLog "stopped bridge process pid=$RootProcessId"
  } catch {
    Write-WatchdogLog "failed to stop bridge process pid=${RootProcessId}: $($_.Exception.Message)"
  }
}

function Start-Bridge {
  $nodeExecutable = $script:NodePath
  if (-not (Test-Path -LiteralPath $nodeExecutable)) {
    $nodeExecutable = "node"
  }
  $stdoutPath = Join-Path $script:StateDir "bridge.watchdog.stdout.log"
  $stderrPath = Join-Path $script:StateDir "bridge.watchdog.stderr.log"
  $started = Start-Process `
    -FilePath $nodeExecutable `
    -ArgumentList @($script:BridgeScriptPath, $script:BridgeCommand) `
    -WorkingDirectory $script:RepoRootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Write-WatchdogLog "started bridge pid=$($started.Id) node=$nodeExecutable script=$script:BridgeScriptPath"
}

function Expand-ConfigPath {
  param(
    [string]$PathValue
  )
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    $PathValue = $env:FEISHU_CODEX_CONFIG
  }
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    $PathValue = $env:CODEX_FEISHU_CONFIG
  }
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    $PathValue = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex\config.json"
  }
  if ($PathValue.StartsWith("~/") -or $PathValue.StartsWith("~\")) {
    return (Join-Path ([Environment]::GetFolderPath("UserProfile")) $PathValue.Substring(2))
  }
  return $PathValue
}

function Expand-EnvPlaceholders {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )
  return [regex]::Replace($Value, '\$\{([^}:]+)(?::-([^}]+))?\}', {
    param($match)
    $envValue = [Environment]::GetEnvironmentVariable($match.Groups[1].Value)
    if (-not [string]::IsNullOrEmpty($envValue)) {
      return $envValue
    }
    return $match.Groups[2].Value
  })
}

function Get-DesktopIpcPipePath {
  $resolvedConfig = Expand-ConfigPath -PathValue $script:ConfigPath
  if (-not (Test-Path -LiteralPath $resolvedConfig)) {
    return "\\.\pipe\codex-ipc"
  }
  try {
    $raw = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8
    $expanded = Expand-EnvPlaceholders -Value $raw
    $config = $expanded | ConvertFrom-Json
    if ($config.codex -and $config.codex.desktopIpcPipePath) {
      return [string]$config.codex.desktopIpcPipePath
    }
  } catch {
    Write-WatchdogLog "failed to parse config for desktop ipc probe: $($_.Exception.Message)"
  }
  return "\\.\pipe\codex-ipc"
}

function Write-DesktopIpcFrame {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Stream]$Stream,
    [Parameter(Mandatory = $true)]
    [object]$Payload
  )
  $json = $Payload | ConvertTo-Json -Depth 10 -Compress
  $body = [System.Text.Encoding]::UTF8.GetBytes($json)
  $header = [System.BitConverter]::GetBytes([uint32]$body.Length)
  $Stream.Write($header, 0, $header.Length)
  $Stream.Write($body, 0, $body.Length)
  $Stream.Flush()
}

function Read-ExactBytes {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Stream]$Stream,
    [Parameter(Mandatory = $true)]
    [int]$Length,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutMs
  )
  $buffer = New-Object byte[] $Length
  $offset = 0
  while ($offset -lt $Length) {
    $async = $Stream.BeginRead($buffer, $offset, $Length - $offset, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      throw "Desktop IPC read timed out after ${TimeoutMs}ms"
    }
    $read = $Stream.EndRead($async)
    if ($read -le 0) {
      throw "Desktop IPC stream closed before reading $Length bytes"
    }
    $offset += $read
  }
  return $buffer
}

function Read-DesktopIpcFrame {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.Stream]$Stream,
    [int]$TimeoutMs = 5000
  )
  $header = Read-ExactBytes -Stream $Stream -Length 4 -TimeoutMs $TimeoutMs
  $length = [System.BitConverter]::ToUInt32($header, 0)
  if ($length -le 0 -or $length -gt 268435456) {
    throw "Desktop IPC frame length is invalid: $length"
  }
  $body = Read-ExactBytes -Stream $Stream -Length ([int]$length) -TimeoutMs $TimeoutMs
  return ([System.Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json)
}

function Test-DesktopIpcHealth {
  $pipePath = Get-DesktopIpcPipePath
  $prefix = "\\.\pipe\"
  if (-not $pipePath.StartsWith($prefix)) {
    Write-WatchdogLog "desktop ipc probe skipped for non-Windows pipe path: $pipePath"
    return $true
  }
  $pipeName = $pipePath.Substring($prefix.Length)
  $client = $null
  try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(3000)
    $requestId = "watchdog-" + [Guid]::NewGuid().ToString("N")
    Write-DesktopIpcFrame -Stream $client -Payload @{
      type = "request"
      requestId = $requestId
      sourceClientId = "feishu-codex-watchdog"
      version = 0
      method = "initialize"
      params = @{ clientType = "feishu-codex-watchdog" }
    }
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline) {
      $remainingMs = [Math]::Max(1, [int](($deadline - (Get-Date)).TotalMilliseconds))
      $message = Read-DesktopIpcFrame -Stream $client -TimeoutMs $remainingMs
      if ($message.type -eq "response" -and $message.requestId -eq $requestId) {
        if ($message.resultType -eq "error" -or $message.error) {
          throw "Desktop IPC initialize returned error: $($message.error | ConvertTo-Json -Compress)"
        }
        $clientId = $null
        if ($message.result -and $message.result.clientId) {
          $clientId = [string]$message.result.clientId
        }
        Write-WatchdogLog "desktop ipc healthy pipe=$pipePath clientId=$clientId"
        return $true
      }
    }
    throw "Desktop IPC initialize response timed out"
  } catch {
    Write-WatchdogLog "desktop ipc unhealthy pipe=$pipePath error=$($_.Exception.Message)"
    return $false
  } finally {
    if ($client) {
      $client.Dispose()
    }
  }
}

$script:RepoRootPath = Resolve-RequiredPath -PathValue $RepoRoot
$script:ConfigPath = $ConfigPath
$script:BridgeScriptPath = Join-Path $script:RepoRootPath $BridgeScript
if (-not (Test-Path -LiteralPath $script:BridgeScriptPath)) {
  throw "Bridge script not found: $script:BridgeScriptPath"
}

$script:StateDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex"
New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
$script:LogPath = Join-Path $script:StateDir "watchdog.log"

try {
  $allProcesses = Get-ProcessTable
  $bridges = @($allProcesses | Where-Object { Test-BridgeProcess -Process $_ } | Sort-Object ProcessId)

  if ($bridges.Count -eq 0) {
    Write-WatchdogLog "bridge process missing; starting bridge"
    Start-Bridge
    exit 0
  }

  if ($bridges.Count -gt 1) {
    $primary = $bridges[0]
    Write-WatchdogLog "multiple bridge processes detected; keeping pid=$($primary.ProcessId) and stopping duplicates"
    foreach ($bridge in @($bridges | Select-Object -Skip 1)) {
      Stop-ProcessTree -AllProcesses $allProcesses -RootProcessId ([int]$bridge.ProcessId)
    }
    exit 0
  }

  if (-not (Test-DesktopIpcHealth)) {
    Write-WatchdogLog "bridge process is alive but Desktop IPC probe failed; restarting pid=$($bridges[0].ProcessId)"
    Stop-ProcessTree -AllProcesses $allProcesses -RootProcessId ([int]$bridges[0].ProcessId)
    Start-Bridge
    exit 0
  }

  Write-WatchdogLog "healthy bridge pid=$($bridges[0].ProcessId)"
  exit 0
} catch {
  Write-WatchdogLog "watchdog failed: $($_.Exception.Message)"
  exit 1
}
