[CmdletBinding()]
param(
  # Repository root. The launcher uses it to start the bridge when the bridge is not running.
  [string]$RepoRoot = "",

  # Bridge config path. The launcher reads codex.websocketUrl/websocketListenUrl and SOCKS settings from this file.
  [string]$ConfigPath = "$env:USERPROFILE\.feishu-codex\config.json",

  # Optional Codex Desktop executable path. Leave empty to auto-detect the Microsoft Store installation.
  [string]$CodexExe = "",

  # Close existing Codex Desktop processes without asking. Use only from a trusted shortcut or automation.
  [switch]$ForceRestart,

  # Do not start the bridge automatically. Useful when another supervisor already owns the bridge process.
  [switch]$SkipBridgeStart,

  # Maximum time to wait for bridge WebSocket /readyz and SOCKS readiness.
  [int]$ReadyTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )
  Write-Host "==> $Message"
}

function Resolve-DefaultRepoRoot {
  if (-not [string]::IsNullOrWhiteSpace($RepoRoot)) {
    return $RepoRoot
  }
  if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    return Split-Path -Parent $PSScriptRoot
  }
  return (Get-Location).Path
}

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )
  return (Resolve-Path -LiteralPath $PathValue).Path
}

function Read-BridgeConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )
  if (-not (Test-Path -LiteralPath $PathValue)) {
    throw "Config file not found: $PathValue"
  }
  return Get-Content -Raw -Encoding UTF8 -LiteralPath $PathValue | ConvertFrom-Json
}

function Get-CodexWebSocketUrl {
  param(
    [Parameter(Mandatory = $true)]
    $Config
  )
  $codex = $Config.codex
  if ($codex.websocketUrl) {
    return [string]$codex.websocketUrl
  }
  if ($codex.websocketListenUrl) {
    return [string]$codex.websocketListenUrl
  }
  return "ws://127.0.0.1:47931"
}

function Convert-WebSocketToReadyzUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WebSocketUrl
  )
  $uri = [Uri]$WebSocketUrl
  if ($uri.Scheme -eq "ws") {
    return "http://$($uri.Authority)$($uri.AbsolutePath.TrimEnd('/'))/readyz"
  }
  if ($uri.Scheme -eq "wss") {
    return "https://$($uri.Authority)$($uri.AbsolutePath.TrimEnd('/'))/readyz"
  }
  throw "Unsupported Codex app-server URL scheme: $($uri.Scheme)"
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [Parameter(Mandatory = $true)]
    [int]$Port
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-ForReadyz {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ReadyzUrl,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $ReadyzUrl -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Codex app-server is not ready: $ReadyzUrl"
}

function Wait-ForTcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort -HostName $HostName -Port $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "TCP port is not ready: ${HostName}:$Port"
}

function Get-BridgeProcesses {
  $all = @(Get-CimInstance Win32_Process)
  return @($all | Where-Object {
    $_.Name -ieq "node.exe" -and
    ([string]$_.CommandLine).Replace("\", "/") -match "dist/src/main\.js" -and
    ([string]$_.CommandLine) -match "\bserve\b"
  })
}

function Start-BridgeIfNeeded {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRootPath
  )
  $bridges = Get-BridgeProcesses
  if ($bridges.Count -gt 0) {
    Write-Host "Bridge already running: pid=$($bridges[0].ProcessId)"
    return
  }
  if ($SkipBridgeStart) {
    throw "Bridge is not running, and -SkipBridgeStart was specified."
  }

  $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw "node command not found. Install Node.js 22.13 or newer."
  }
  $stateDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $stdoutPath = Join-Path $stateDir "bridge.desktop-launcher.stdout.log"
  $stderrPath = Join-Path $stateDir "bridge.desktop-launcher.stderr.log"
  $started = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @("dist/src/main.js", "serve") `
    -WorkingDirectory $RepoRootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Write-Host "Started bridge: pid=$($started.Id)"
}

function Resolve-CodexDesktopExecutable {
  param(
    [string]$ExplicitPath
  )
  if ($ExplicitPath) {
    return Resolve-RequiredPath -PathValue $ExplicitPath
  }

  $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq "Codex.exe" -and ([string]$_.CommandLine) -match "\\app\\Codex\.exe" } |
    Select-Object -First 1
  if ($running -and $running.ExecutablePath -and (Test-Path -LiteralPath $running.ExecutablePath)) {
    return $running.ExecutablePath
  }

  $windowsApps = "C:\Program Files\WindowsApps"
  if (Test-Path -LiteralPath $windowsApps) {
    $candidate = Get-ChildItem -Directory -ErrorAction SilentlyContinue -LiteralPath $windowsApps -Filter "OpenAI.Codex_*" |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Join-Path $_.FullName "app\Codex.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($candidate) {
      return $candidate
    }
  }

  $command = Get-Command "Codex.exe" -ErrorAction SilentlyContinue
  if ($command -and (Test-Path -LiteralPath $command.Source)) {
    return $command.Source
  }

  throw "Codex Desktop executable was not found. Pass -CodexExe explicitly."
}

function Get-CodexDesktopProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DesktopExe
  )
  $desktopRoot = Split-Path -Parent $DesktopExe
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq "Codex.exe" -and
    $_.ExecutablePath -and
    ([string]$_.ExecutablePath).StartsWith($desktopRoot, [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-CodexDesktop {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DesktopExe
  )
  $processes = Get-CodexDesktopProcesses -DesktopExe $DesktopExe
  if ($processes.Count -eq 0) {
    return
  }

  if (-not $ForceRestart) {
    Write-Host ""
    Write-Host "Detected running Codex Desktop processes. They must be restarted to use the shared app-server."
    $answer = Read-Host "Close and restart Codex Desktop now? [Y/N]"
    if ($answer -notmatch "^(y|Y|yes|YES)$") {
      throw "Cancelled. Codex Desktop was not restarted."
    }
  }

  $mainProcesses = @($processes | Where-Object { [int]$_.ParentProcessId -notin @($processes | ForEach-Object { [int]$_.ProcessId }) })
  if ($mainProcesses.Count -eq 0) {
    $mainProcesses = $processes
  }
  foreach ($process in $mainProcesses) {
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
  }
  Start-Sleep -Seconds 2
}

function Start-CodexDesktopWithCanonicalServer {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DesktopExe,
    [Parameter(Mandatory = $true)]
    [string]$WebSocketUrl
  )
  $oldValue = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "Process")
  try {
    [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $WebSocketUrl, "Process")
    $started = Start-Process -FilePath $DesktopExe -PassThru
    Write-Host "Started Codex Desktop: pid=$($started.Id)"
  } finally {
    [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $oldValue, "Process")
  }
}

function Wait-ForDesktopSocksConnection {
  param(
    [Parameter(Mandatory = $true)]
    [int]$SocksPort,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $line = netstat -ano -p tcp | Select-String -Pattern ":$SocksPort\s+.*ESTABLISHED" | Select-Object -First 1
    if ($line) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Desktop has not connected to SOCKS yet. It may still be starting; check /doctor if needed."
}

$repoRootPath = Resolve-RequiredPath -PathValue (Resolve-DefaultRepoRoot)
$config = Read-BridgeConfig -PathValue $ConfigPath
$webSocketUrl = Get-CodexWebSocketUrl -Config $config
$readyzUrl = Convert-WebSocketToReadyzUrl -WebSocketUrl $webSocketUrl
$socksHost = if ($config.codex.desktopSocksProxyHost) { [string]$config.codex.desktopSocksProxyHost } else { "127.0.0.1" }
$socksPort = if ($config.codex.desktopSocksProxyPort) { [int]$config.codex.desktopSocksProxyPort } else { 1080 }
$desktopSocksEnabled = [bool]$config.codex.desktopSocksProxyEnabled

Write-Step "Checking bridge"
Start-BridgeIfNeeded -RepoRootPath $repoRootPath

Write-Step "Waiting for canonical app-server"
Wait-ForReadyz -ReadyzUrl $readyzUrl -TimeoutSeconds $ReadyTimeoutSeconds
Write-Host "Canonical app-server ready: $webSocketUrl"

if (-not $desktopSocksEnabled) {
  Write-Host "Warning: desktopSocksProxyEnabled is false. Current Codex Desktop builds need 127.0.0.1:1080 SOCKS for CODEX_APP_SERVER_WS_URL."
}

Write-Step "Waiting for Desktop SOCKS proxy"
Wait-ForTcpPort -HostName $socksHost -Port $socksPort -TimeoutSeconds $ReadyTimeoutSeconds
Write-Host "Desktop SOCKS ready: ${socksHost}:$socksPort"

Write-Step "Resolving Codex Desktop"
$desktopExe = Resolve-CodexDesktopExecutable -ExplicitPath $CodexExe
Write-Host "Codex Desktop: $desktopExe"

Write-Step "Restarting Codex Desktop into shared server mode"
Stop-CodexDesktop -DesktopExe $desktopExe
Start-CodexDesktopWithCanonicalServer -DesktopExe $desktopExe -WebSocketUrl $webSocketUrl

Write-Step "Checking Desktop connection"
Wait-ForDesktopSocksConnection -SocksPort $socksPort -TimeoutSeconds 20
Write-Host ""
Write-Host "Done. Codex Desktop should now use the bridge-owned app-server:"
Write-Host "  $webSocketUrl"
