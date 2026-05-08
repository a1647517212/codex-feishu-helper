[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$NodePath = "node",
  [string]$BridgeScript = "dist/src/main.js",
  [string]$BridgeCommand = "serve",
  [int]$MinBridgeAgeSecondsBeforeRestart = 60
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

function Test-AppServerDescendant {
  param(
    [Parameter(Mandatory = $true)]
    [array]$AllProcesses,
    [Parameter(Mandatory = $true)]
    $BridgeProcess
  )
  $children = Get-ProcessDescendants -AllProcesses $AllProcesses -RootProcessId ([int]$BridgeProcess.ProcessId)
  foreach ($child in $children) {
    $commandLine = [string]$child.CommandLine
    if ($commandLine -match "\bapp-server\b") {
      return $true
    }
  }
  return $false
}

function Get-ProcessAgeSeconds {
  param(
    [Parameter(Mandatory = $true)]
    $Process
  )
  if (-not $Process.CreationDate) {
    return [int]::MaxValue
  }
  $createdAt = [System.Management.ManagementDateTimeConverter]::ToDateTime($Process.CreationDate)
  return [int]((Get-Date) - $createdAt).TotalSeconds
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

$script:RepoRootPath = Resolve-RequiredPath -PathValue $RepoRoot
$script:BridgeScriptPath = Join-Path $script:RepoRootPath $BridgeScript
if (-not (Test-Path -LiteralPath $script:BridgeScriptPath)) {
  throw "Bridge script not found: $script:BridgeScriptPath"
}

$script:StateDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex"
New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
$script:LogPath = Join-Path $script:StateDir "watchdog.log"

try {
  $allProcesses = Get-ProcessTable
  $bridges = @($allProcesses | Where-Object { Test-BridgeProcess -Process $_ })

  if ($bridges.Count -eq 0) {
    Write-WatchdogLog "bridge process missing; starting bridge"
    Start-Bridge
    exit 0
  }

  foreach ($bridge in $bridges) {
    if (Test-AppServerDescendant -AllProcesses $allProcesses -BridgeProcess $bridge) {
      Write-WatchdogLog "healthy bridge pid=$($bridge.ProcessId); app-server descendant found"
      exit 0
    }
  }

  $oldEnough = $false
  foreach ($bridge in $bridges) {
    if ((Get-ProcessAgeSeconds -Process $bridge) -ge $MinBridgeAgeSecondsBeforeRestart) {
      $oldEnough = $true
    }
  }
  if (-not $oldEnough) {
    Write-WatchdogLog "bridge process exists but app-server is still starting; skip restart"
    exit 0
  }

  Write-WatchdogLog "bridge process exists but app-server descendant is missing; restarting bridge"
  foreach ($bridge in $bridges) {
    Stop-ProcessTree -AllProcesses $allProcesses -RootProcessId ([int]$bridge.ProcessId)
  }
  Start-Sleep -Seconds 2
  Start-Bridge
  exit 0
} catch {
  Write-WatchdogLog "watchdog failed: $($_.Exception.Message)"
  exit 1
}
