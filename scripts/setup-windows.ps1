[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:USERPROFILE\.feishu-codex\config.json",
  [switch]$SkipInstall,
  [switch]$SkipShortcuts,
  [switch]$InstallWatchdog
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )
  Write-Host "==> $Message"
}

function Require-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$InstallHint
  )
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Missing required command '$Name'. $InstallHint"
  }
  return $command.Source
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$Arguments = @()
  )
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
  }
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

Write-Step "Checking Node.js"
$nodePath = Require-Command -Name "node" -InstallHint "Install Node.js 22.13 or newer."
$nodeVersion = (& $nodePath --version).Trim()
if ($nodeVersion -notmatch "^v(\d+)\.") {
  throw "Unable to parse Node.js version: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = 0
$nodePatch = 0
if ($nodeVersion -match "^v\d+\.(\d+)\.(\d+)") {
  $nodeMinor = [int]$Matches[1]
  $nodePatch = [int]$Matches[2]
}
if (
  $nodeMajor -lt 22 -or
  ($nodeMajor -eq 22 -and $nodeMinor -lt 13)
) {
  throw "Node.js 22.13 or newer is required. Current version: $nodeVersion"
}
Write-Host "Node.js: $nodeVersion"

Write-Step "Checking npm"
$npmPath = Require-Command -Name "npm" -InstallHint "Install npm with Node.js."
Write-Host "npm: $((& $npmPath --version).Trim())"

Write-Step "Checking Codex CLI"
$codexPath = Require-Command -Name "codex" -InstallHint "Install Codex CLI and run 'codex login'."
Write-Host "codex: $((& $codexPath --version).Trim())"

if (-not $SkipInstall) {
  Write-Step "Installing npm dependencies"
  Invoke-CheckedCommand -FilePath $npmPath -Arguments @("install")
}

Write-Step "Building project"
Invoke-CheckedCommand -FilePath $npmPath -Arguments @("run", "build")

Write-Step "Preparing config"
$configDirectory = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Copy-Item -LiteralPath (Join-Path $repoRoot "config.example.json") -Destination $ConfigPath
  Write-Host "Created config: $ConfigPath"
} else {
  Write-Host "Config already exists: $ConfigPath"
}

if (-not $SkipShortcuts) {
  Write-Step "Installing desktop shortcuts"
  Invoke-CheckedCommand -FilePath "powershell.exe" -Arguments @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $repoRoot "scripts\install-user-shortcuts.ps1"),
    "-RepoRoot",
    $repoRoot
  )
}

if ($InstallWatchdog) {
  Write-Step "Installing watchdog scheduled task"
  Invoke-CheckedCommand -FilePath "powershell.exe" -Arguments @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Join-Path $repoRoot "scripts\install-watchdog.ps1"),
    "-RepoRoot",
    $repoRoot
  )
}

Write-Host ""
Write-Host "Ready."
Write-Host "1. Open the desktop shortcut: Codex Feishu Helper"
Write-Host "2. Click Open Config, fill feishu.appId, feishu.appSecret, feishu.defaultChatId, and server.adminToken"
Write-Host "3. Open ordinary Codex Desktop and keep it logged in"
Write-Host "4. Click Start Bridge"
Write-Host "5. In Feishu group, send /doctor then /tasks or /codex"
