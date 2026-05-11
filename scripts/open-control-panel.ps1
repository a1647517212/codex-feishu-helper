[CmdletBinding()]
param(
  # Repository root. Defaults to the parent directory of scripts.
  [string]$RepoRoot = "",

  # Bridge config path.
  [string]$ConfigPath = "$env:USERPROFILE\.feishu-codex\config.json"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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

function New-Button {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text,
    [Parameter(Mandatory = $true)]
    [scriptblock]$OnClick
  )
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Height = 34
  $button.Dock = [System.Windows.Forms.DockStyle]::Fill
  $button.Add_Click($OnClick)
  return $button
}

function Write-PanelLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message
  )
  $timestamp = (Get-Date).ToString("HH:mm:ss")
  $script:LogBox.AppendText("[$timestamp] $Message`r`n")
}

function Read-BridgeConfig {
  if (-not (Test-Path -LiteralPath $script:ConfigPathValue)) {
    return $null
  }
  return Get-Content -Raw -Encoding UTF8 -LiteralPath $script:ConfigPathValue | ConvertFrom-Json
}

function Get-BridgeProcesses {
  $all = @(Get-CimInstance Win32_Process)
  return @($all | Where-Object {
    $_.Name -ieq "node.exe" -and
    ([string]$_.CommandLine).Replace("\", "/") -match "dist/src/main\.js" -and
    ([string]$_.CommandLine) -match "\bserve\b"
  })
}

function Test-PipePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PipePath
  )
  try {
    return Test-Path -LiteralPath $PipePath
  } catch {
    return $false
  }
}

function Start-ExternalPowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,
    [string[]]$Arguments = @(),
    [switch]$Hidden
  )
  $quotedScript = "`"$ScriptPath`""
  $argumentLine = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $quotedScript) + $Arguments
  $windowStyle = if ($Hidden) { "Hidden" } else { "Normal" }
  Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -WorkingDirectory $script:RepoRootPath -WindowStyle $windowStyle | Out-Null
}

function Start-BridgeHidden {
  $bridgeScript = Join-Path $script:RepoRootPath "dist\src\main.js"
  if (-not (Test-Path -LiteralPath $bridgeScript)) {
    [System.Windows.Forms.MessageBox]::Show(
      "Build output is missing. Run Setup / Repair first.",
      "Codex Feishu Helper",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
    return
  }
  $existing = Get-BridgeProcesses
  if ($existing.Count -gt 0) {
    Write-PanelLog "Bridge is already running: pid=$($existing[0].ProcessId)"
    Refresh-Status
    return
  }
  $stateDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  $stdoutPath = Join-Path $stateDir "bridge.control-panel.stdout.log"
  $stderrPath = Join-Path $stateDir "bridge.control-panel.stderr.log"
  $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    [System.Windows.Forms.MessageBox]::Show(
      "Node.js was not found. Install Node.js 22.13 or newer.",
      "Codex Feishu Helper",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    return
  }
  $started = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList @("dist/src/main.js", "serve") `
    -WorkingDirectory $script:RepoRootPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Write-PanelLog "Started bridge: pid=$($started.Id)"
  Start-Sleep -Milliseconds 500
  Refresh-Status
}

function Open-ConfigFile {
  $configDirectory = Split-Path -Parent $script:ConfigPathValue
  New-Item -ItemType Directory -Force -Path $configDirectory | Out-Null
  if (-not (Test-Path -LiteralPath $script:ConfigPathValue)) {
    $example = Join-Path $script:RepoRootPath "config.example.json"
    Copy-Item -LiteralPath $example -Destination $script:ConfigPathValue
  }
  Start-Process -FilePath "notepad.exe" -ArgumentList "`"$script:ConfigPathValue`"" | Out-Null
}

function Open-LogDirectory {
  $stateDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".feishu-codex"
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
  Start-Process -FilePath "explorer.exe" -ArgumentList "`"$stateDir`"" | Out-Null
}

function Refresh-Status {
  try {
    $config = Read-BridgeConfig
    $bridgeProcesses = Get-BridgeProcesses
    $desktopProcesses = @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue)
    $buildPath = Join-Path $script:RepoRootPath "dist\src\main.js"
    $connectionMode = if ($config -and $config.codex -and $config.codex.connectionMode) { [string]$config.codex.connectionMode } else { "desktop_ipc" }
    $pipePath = if ($config -and $config.codex -and $config.codex.desktopIpcPipePath) { [string]$config.codex.desktopIpcPipePath } else { "\\.\pipe\codex-ipc" }

    $script:ConfigStatus.Text = if ($config) { "OK - $script:ConfigPathValue" } else { "Missing - open config first" }
    $script:BuildStatus.Text = if (Test-Path -LiteralPath $buildPath) { "OK - build output exists" } else { "Missing - run Setup / Repair" }
    $script:BridgeStatus.Text = if ($bridgeProcesses.Count -gt 0) { "Running - pid=$($bridgeProcesses[0].ProcessId)" } else { "Stopped" }
    $script:ConnectionModeStatus.Text = $connectionMode
    $script:IpcStatus.Text = if (Test-PipePath -PipePath $pipePath) { "Ready - $pipePath" } else { "Not found - open ordinary Codex Desktop first" }
    $script:DesktopStatus.Text = if ($desktopProcesses.Count -gt 0) { "Running - $($desktopProcesses.Count) process(es)" } else { "Not running" }
    Write-PanelLog "Status refreshed."
  } catch {
    Write-PanelLog "Refresh failed: $($_.Exception.Message)"
  }
}

$script:RepoRootPath = Resolve-RequiredPath -PathValue (Resolve-DefaultRepoRoot)
$script:ConfigPathValue = $ConfigPath

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Codex Feishu Helper"
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Size = New-Object System.Drawing.Size(820, 600)
$form.MinimumSize = New-Object System.Drawing.Size(720, 520)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.ColumnCount = 1
$root.RowCount = 4
$root.Padding = New-Object System.Windows.Forms.Padding(14)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 52))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 180))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 96))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$form.Controls.Add($root)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Codex Feishu Helper Control Panel"
$title.Dock = [System.Windows.Forms.DockStyle]::Fill
$title.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$title.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$root.Controls.Add($title, 0, 0)

$statusGrid = New-Object System.Windows.Forms.TableLayoutPanel
$statusGrid.Dock = [System.Windows.Forms.DockStyle]::Fill
$statusGrid.ColumnCount = 2
$statusGrid.RowCount = 6
$statusGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 150))) | Out-Null
$statusGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.Controls.Add($statusGrid, 0, 1)

$statusItems = @(
  @("Config", "ConfigStatus"),
  @("Build", "BuildStatus"),
  @("Bridge", "BridgeStatus"),
  @("Connection Mode", "ConnectionModeStatus"),
  @("Desktop IPC", "IpcStatus"),
  @("Desktop", "DesktopStatus")
)
for ($index = 0; $index -lt $statusItems.Count; $index++) {
  $item = $statusItems[$index]
  $nameLabel = New-Object System.Windows.Forms.Label
  $nameLabel.Text = $item[0]
  $nameLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $nameLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $nameLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
  $valueLabel = New-Object System.Windows.Forms.Label
  $valueLabel.Text = "Checking..."
  $valueLabel.Dock = [System.Windows.Forms.DockStyle]::Fill
  $valueLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $valueLabel.AutoEllipsis = $true
  Set-Variable -Name $item[1] -Scope Script -Value $valueLabel
  $statusGrid.Controls.Add($nameLabel, 0, $index)
  $statusGrid.Controls.Add($valueLabel, 1, $index)
}

$buttons = New-Object System.Windows.Forms.TableLayoutPanel
$buttons.Dock = [System.Windows.Forms.DockStyle]::Fill
$buttons.ColumnCount = 3
$buttons.RowCount = 2
for ($i = 0; $i -lt 3; $i++) {
  $buttons.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33.33))) | Out-Null
}
$buttons.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$buttons.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$root.Controls.Add($buttons, 0, 2)

$setupScript = Join-Path $script:RepoRootPath "scripts\setup-windows.ps1"
$watchdogScript = Join-Path $script:RepoRootPath "scripts\install-watchdog.ps1"

$buttons.Controls.Add((New-Button -Text "Setup / Repair" -OnClick {
  Write-PanelLog "Opening setup window."
  Start-ExternalPowerShell -ScriptPath $setupScript
}), 0, 0)
$buttons.Controls.Add((New-Button -Text "Open Config" -OnClick {
  Open-ConfigFile
  Write-PanelLog "Opened config file."
}), 1, 0)
$buttons.Controls.Add((New-Button -Text "Refresh" -OnClick {
  Refresh-Status
}), 2, 0)
$buttons.Controls.Add((New-Button -Text "Start Bridge" -OnClick {
  Start-BridgeHidden
}), 0, 1)
$buttons.Controls.Add((New-Button -Text "Install Watchdog" -OnClick {
  Write-PanelLog "Opening watchdog installer."
  Start-ExternalPowerShell -ScriptPath $watchdogScript -Arguments @("-RepoRoot", "`"$script:RepoRootPath`"")
}), 1, 1)
$buttons.Controls.Add((New-Button -Text "Open Logs" -OnClick {
  Open-LogDirectory
}), 2, 1)

$script:LogBox = New-Object System.Windows.Forms.TextBox
$script:LogBox.Multiline = $true
$script:LogBox.ReadOnly = $true
$script:LogBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$script:LogBox.Dock = [System.Windows.Forms.DockStyle]::Fill
$script:LogBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$root.Controls.Add($script:LogBox, 0, 3)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openLogsItem = $menu.Items.Add("Open log directory")
$openLogsItem.Add_Click({
  Open-LogDirectory
})
$script:LogBox.ContextMenuStrip = $menu

$form.Add_Shown({
  Write-PanelLog "Repo: $script:RepoRootPath"
  Write-PanelLog "Config: $script:ConfigPathValue"
  Refresh-Status
})

[void]$form.ShowDialog()
