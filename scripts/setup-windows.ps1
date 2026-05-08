[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:USERPROFILE\.feishu-codex\config.json",
  [switch]$SkipInstall
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
  npm install
}

Write-Step "Building project"
npm run build

Write-Step "Preparing config"
$configDirectory = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Copy-Item -LiteralPath (Join-Path $repoRoot "config.example.json") -Destination $ConfigPath
  Write-Host "Created config: $ConfigPath"
} else {
  Write-Host "Config already exists: $ConfigPath"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Edit config: notepad `"$ConfigPath`""
Write-Host "2. Fill feishu.appId, feishu.appSecret, feishu.defaultChatId, server.adminToken"
Write-Host "3. Start bridge: npm run start"
Write-Host "4. In Feishu group, send /doctor then /codex"
