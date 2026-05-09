[CmdletBinding()]
param(
  # Shortcut name shown on the desktop.
  [string]$ShortcutName = "Codex Shared Server",

  # Repository root. Defaults to the parent directory of scripts.
  [string]$RepoRoot = "",

  # Create a shortcut that restarts Codex Desktop without prompting.
  [switch]$ForceRestartShortcut
)

$ErrorActionPreference = "Stop"

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

$repoRootPath = Resolve-RequiredPath -PathValue (Resolve-DefaultRepoRoot)
$launcherPath = Join-Path $repoRootPath "scripts\start-codex-desktop-canonical.ps1"
if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Launcher script not found: $launcherPath"
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -RepoRoot `"$repoRootPath`""
if ($ForceRestartShortcut) {
  $arguments += " -ForceRestart"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $repoRootPath
$shortcut.WindowStyle = 1
$shortcut.Description = "Start Codex Desktop with Codex Feishu Helper canonical app-server"

$iconCandidates = @(
  "C:\Program Files\WindowsApps\OpenAI.Codex_26.506.2212.0_x64__2p2nqsd0c76g0\app\resources\icon.ico",
  (Join-Path $repoRootPath "codex.ico")
)
foreach ($candidate in $iconCandidates) {
  if (Test-Path -LiteralPath $candidate) {
    $shortcut.IconLocation = $candidate
    break
  }
}

$shortcut.Save()

Write-Output "Installed shortcut: $shortcutPath"
Write-Output "Target: powershell.exe $arguments"
