[CmdletBinding()]
param(
  [ValidateSet("status", "install", "remove")]
  [string]$Action = "status",

  # Optional source Codex Desktop app directory. It should contain Codex.exe and resources\app.asar.
  [string]$SourceAppDir = "",

  # Writable install root for the patched Desktop copy.
  [string]$InstallRoot = "$env:LOCALAPPDATA\CodexFeishuHelper\CodexDesktopPatched",

  # Re-copy the Desktop app even if a patched copy already exists.
  [switch]$Force,

  # Return JSON for scripts/control panel.
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Write-JsonResult {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 8
}

function Resolve-RepoRoot {
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Resolve-SourceAppDir {
  if (-not [string]::IsNullOrWhiteSpace($SourceAppDir)) {
    return (Resolve-Path -LiteralPath $SourceAppDir).Path
  }

  $running = Get-CimInstance Win32_Process -Filter "name = 'Codex.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ([string]$_.ExecutablePath).EndsWith("\app\Codex.exe", [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if ($running -and $running.ExecutablePath) {
    return (Split-Path -Parent $running.ExecutablePath)
  }

  $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($package -and $package.InstallLocation) {
    $candidate = Join-Path $package.InstallLocation "app"
    if (Test-Path -LiteralPath (Join-Path $candidate "Codex.exe")) {
      return $candidate
    }
  }

  $command = Get-Command "Codex.exe" -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    $candidate = Split-Path -Parent $command.Source
    if (Test-Path -LiteralPath (Join-Path $candidate "resources\app.asar")) {
      return $candidate
    }
  }

  throw "Codex Desktop app directory was not found. Pass -SourceAppDir explicitly."
}

function Get-DirectoryVersionName {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  $versionPath = Join-Path $PathValue "version"
  if (Test-Path -LiteralPath $versionPath) {
    $version = (Get-Content -Raw -Encoding UTF8 -LiteralPath $versionPath).Trim()
    if (-not [string]::IsNullOrWhiteSpace($version)) {
      return "Codex-$version"
    }
  }
  return "Codex"
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$PathValue)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $PathValue).Hash.ToLowerInvariant()
}

function Resolve-InstallInfo {
  $source = Resolve-SourceAppDir
  $sourceAsar = Join-Path $source "resources\app.asar"
  if (-not (Test-Path -LiteralPath $sourceAsar)) {
    throw "Source app.asar was not found: $sourceAsar"
  }
  $versionName = Get-DirectoryVersionName -PathValue $source
  $installRootPath = [System.IO.Path]::GetFullPath($InstallRoot)
  $installDir = Join-Path $installRootPath $versionName
  return [pscustomobject]@{
    SourceAppDir = $source
    SourceAsar = $sourceAsar
    SourceAsarSha256 = Get-Sha256 -PathValue $sourceAsar
    InstallRoot = $installRootPath
    InstallDir = $installDir
    PatchedExe = Join-Path $installDir "Codex.exe"
    PatchedAsar = Join-Path $installDir "resources\app.asar"
    ManifestPath = Join-Path $installDir "codex-feishu-patched-desktop.json"
    BackupDir = Join-Path $installRootPath "backups"
  }
}

function Test-PathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  $childFull = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $childFull.StartsWith($parentFull + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-NodeJson {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $node = Get-Command "node" -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js was not found. Install Node.js 22.13 or newer."
  }
  $repoRoot = Resolve-RepoRoot
  $patcher = Join-Path $repoRoot "scripts\patch-codex-desktop-ws.mjs"
  $output = & $node.Source $patcher @Arguments --json 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($output -join "`n")
  }
  return ($output -join "`n" | ConvertFrom-Json)
}

function Get-CopyStatus {
  $info = Resolve-InstallInfo
  $exists = (Test-Path -LiteralPath $info.PatchedExe) -and (Test-Path -LiteralPath $info.PatchedAsar)
  $patchStatus = $null
  $manifest = $null
  if ($exists) {
    $patchStatus = Invoke-NodeJson -Arguments @("status", "--asar", $info.PatchedAsar, "--backup-dir", $info.BackupDir)
    if (Test-Path -LiteralPath $info.ManifestPath) {
      $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $info.ManifestPath | ConvertFrom-Json
    }
  }
  $state = if (-not $exists) { "missing" } elseif ($patchStatus.state -eq "patched") { "patched" } else { [string]$patchStatus.state }
  return [pscustomobject]@{
    ok = $true
    action = "status"
    state = $state
    sourceAppDir = $info.SourceAppDir
    sourceAsar = $info.SourceAsar
    sourceAsarSha256 = $info.SourceAsarSha256
    installRoot = $info.InstallRoot
    installDir = $info.InstallDir
    patchedExe = if ($exists) { $info.PatchedExe } else { $null }
    patchedAsar = if ($exists) { $info.PatchedAsar } else { $null }
    patchState = if ($patchStatus) { $patchStatus.state } else { $null }
    manifest = $manifest
  }
}

function Copy-DesktopApp {
  param([Parameter(Mandatory = $true)]$Info)
  if (-not (Test-PathInside -Child $Info.InstallDir -Parent $Info.InstallRoot)) {
    throw "Refusing to copy outside install root: $($Info.InstallDir)"
  }
  New-Item -ItemType Directory -Force -Path $Info.InstallRoot | Out-Null
  if (Test-Path -LiteralPath $Info.InstallDir) {
    Remove-Item -LiteralPath $Info.InstallDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Info.InstallDir | Out-Null
  $logPath = Join-Path $Info.InstallRoot "robocopy.log"
  & robocopy.exe $Info.SourceAppDir $Info.InstallDir /E /COPY:DAT /R:2 /W:1 /NFL /NDL /NP /LOG:$logPath | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "robocopy failed with exit code $exitCode. Log: $logPath"
  }
}

function Install-Copy {
  $info = Resolve-InstallInfo
  $current = Get-CopyStatus
  $needsCopy = $Force -or $current.state -eq "missing"
  if (-not $needsCopy -and $current.manifest -and $current.manifest.sourceAsarSha256 -ne $info.SourceAsarSha256) {
    $needsCopy = $true
  }
  if ($needsCopy) {
    Copy-DesktopApp -Info $info
  }
  $patchStatus = Invoke-NodeJson -Arguments @("install", "--asar", $info.PatchedAsar, "--backup-dir", $info.BackupDir)
  $manifest = [pscustomobject]@{
    kind = "codex-feishu-patched-desktop-copy"
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceAppDir = $info.SourceAppDir
    sourceAsar = $info.SourceAsar
    sourceAsarSha256 = $info.SourceAsarSha256
    installDir = $info.InstallDir
    patchedExe = $info.PatchedExe
    patchedAsar = $info.PatchedAsar
    patchState = $patchStatus.state
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $info.ManifestPath -Encoding UTF8
  return [pscustomobject]@{
    ok = $true
    action = "install"
    state = "patched"
    changed = $true
    copied = $needsCopy
    sourceAppDir = $info.SourceAppDir
    installDir = $info.InstallDir
    patchedExe = $info.PatchedExe
    patchedAsar = $info.PatchedAsar
    patchStatus = $patchStatus
  }
}

function Remove-Copy {
  $info = Resolve-InstallInfo
  if (-not (Test-Path -LiteralPath $info.InstallDir)) {
    return [pscustomobject]@{
      ok = $true
      action = "remove"
      state = "missing"
      changed = $false
      installDir = $info.InstallDir
    }
  }
  if (-not (Test-PathInside -Child $info.InstallDir -Parent $info.InstallRoot)) {
    throw "Refusing to remove outside install root: $($info.InstallDir)"
  }
  Remove-Item -LiteralPath $info.InstallDir -Recurse -Force
  return [pscustomobject]@{
    ok = $true
    action = "remove"
    state = "missing"
    changed = $true
    installDir = $info.InstallDir
  }
}

try {
  $result = switch ($Action) {
    "status" { Get-CopyStatus }
    "install" { Install-Copy }
    "remove" { Remove-Copy }
  }
  if ($Json) {
    Write-JsonResult -Value $result
  } else {
    Write-Host "Action: $($result.action)"
    Write-Host "State: $($result.state)"
    if ($result.sourceAppDir) { Write-Host "Source: $($result.sourceAppDir)" }
    if ($result.installDir) { Write-Host "Install: $($result.installDir)" }
    if ($result.patchedExe) { Write-Host "Patched Codex.exe: $($result.patchedExe)" }
  }
} catch {
  $result = [pscustomobject]@{
    ok = $false
    action = $Action
    error = $_.Exception.Message
  }
  if ($Json) {
    Write-JsonResult -Value $result
  } else {
    Write-Error $_
  }
  exit 1
}
