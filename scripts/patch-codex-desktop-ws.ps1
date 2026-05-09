[CmdletBinding()]
param(
  # One of status/install/restore.
  [ValidateSet("status", "install", "restore")]
  [string]$Action = "status",

  # Optional explicit Codex Desktop app.asar path.
  [string]$AsarPath = "",

  # Optional backup directory. Defaults to %USERPROFILE%\.feishu-codex\codex-desktop-backups.
  [string]$BackupDir = "",

  # Allow restore even when current app.asar sha does not match the selected patch manifest.
  [switch]$Force,

  # Return JSON from the underlying Node patcher.
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Require-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Missing required command '$Name'. Install Node.js 22.13 or newer."
  }
  return $command.Source
}

$repoRoot = Resolve-RepoRoot
$patcher = Join-Path $repoRoot "scripts\patch-codex-desktop-ws.mjs"
if (-not (Test-Path -LiteralPath $patcher)) {
  throw "Patch script not found: $patcher"
}

$node = Require-Command -Name "node"
$arguments = @($patcher, $Action)
if (-not [string]::IsNullOrWhiteSpace($AsarPath)) {
  $arguments += @("--asar", $AsarPath)
}
if (-not [string]::IsNullOrWhiteSpace($BackupDir)) {
  $arguments += @("--backup-dir", $BackupDir)
}
if ($Force) {
  $arguments += "--force"
}
if ($Json) {
  $arguments += "--json"
}

& $node @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Codex Desktop WS patch action failed: $Action"
}
