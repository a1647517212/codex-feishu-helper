[CmdletBinding()]
param(
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

function New-DesktopShortcut {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [string]$Description = ""
  )
  $desktopPath = [Environment]::GetFolderPath("Desktop")
  $shortcutPath = Join-Path $desktopPath "$Name.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.WindowStyle = 1
  $shortcut.Description = $Description
  $iconCandidates = @(
    "C:\Program Files\WindowsApps\OpenAI.Codex_26.506.2212.0_x64__2p2nqsd0c76g0\app\resources\icon.ico",
    (Join-Path $WorkingDirectory "codex.ico")
  )
  foreach ($candidate in $iconCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      $shortcut.IconLocation = $candidate
      break
    }
  }
  $shortcut.Save()
  return $shortcutPath
}

$repoRootPath = Resolve-RequiredPath -PathValue (Resolve-DefaultRepoRoot)
$controlPanelPath = Join-Path $repoRootPath "scripts\open-control-panel.ps1"
$desktopLauncherPath = Join-Path $repoRootPath "scripts\start-codex-desktop-canonical.ps1"

if (-not (Test-Path -LiteralPath $controlPanelPath)) {
  throw "Control panel script not found: $controlPanelPath"
}
if (-not (Test-Path -LiteralPath $desktopLauncherPath)) {
  throw "Desktop launcher script not found: $desktopLauncherPath"
}

$controlPanelArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$controlPanelPath`" -RepoRoot `"$repoRootPath`""
$desktopArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$desktopLauncherPath`" -RepoRoot `"$repoRootPath`""
if ($ForceRestartShortcut) {
  $desktopArgs += " -ForceRestart"
}

$controlShortcut = New-DesktopShortcut `
  -Name "Codex Feishu Helper" `
  -Arguments $controlPanelArgs `
  -WorkingDirectory $repoRootPath `
  -Description "Open Codex Feishu Helper control panel"

$desktopShortcut = New-DesktopShortcut `
  -Name "Codex Shared Server" `
  -Arguments $desktopArgs `
  -WorkingDirectory $repoRootPath `
  -Description "Start Codex Desktop with the bridge-owned canonical app-server"

Write-Output "Installed shortcut: $controlShortcut"
Write-Output "Installed shortcut: $desktopShortcut"
