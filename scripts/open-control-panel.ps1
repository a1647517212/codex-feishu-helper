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
    if (-not $async.AsyncWaitHandle.WaitOne(500)) {
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

function Read-BridgeConfig {
  if (-not (Test-Path -LiteralPath $script:ConfigPathValue)) {
    return $null
  }
  return Get-Content -Raw -Encoding UTF8 -LiteralPath $script:ConfigPathValue | ConvertFrom-Json
}

function Get-CodexWebSocketUrl {
  param($Config)
  if ($Config -and $Config.codex -and $Config.codex.websocketUrl) {
    return [string]$Config.codex.websocketUrl
  }
  if ($Config -and $Config.codex -and $Config.codex.websocketListenUrl) {
    return [string]$Config.codex.websocketListenUrl
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
  return ""
}

function Get-BridgeProcesses {
  $all = @(Get-CimInstance Win32_Process)
  return @($all | Where-Object {
    $_.Name -ieq "node.exe" -and
    ([string]$_.CommandLine).Replace("\", "/") -match "dist/src/main\.js" -and
    ([string]$_.CommandLine) -match "\bserve\b"
  })
}

function Test-AppServerReady {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ReadyzUrl
  )
  if ([string]::IsNullOrWhiteSpace($ReadyzUrl)) {
    return $false
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $ReadyzUrl -TimeoutSec 2
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300)
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

function Invoke-DesktopWsPatch {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("status", "install", "restore")]
    [string]$Action
  )
  $patchScript = Join-Path $script:RepoRootPath "scripts\patch-codex-desktop-ws.ps1"
  if (-not (Test-Path -LiteralPath $patchScript)) {
    Write-PanelLog "Desktop WS patch script is missing."
    return $null
  }
  $nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Write-PanelLog "Node.js was not found. Cannot run Desktop WS patcher."
    return $null
  }
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patchScript -Action $Action -Json 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-PanelLog "Desktop WS patch $Action failed: $($output -join ' ')"
      return $null
    }
    return ($output -join "`n" | ConvertFrom-Json)
  } catch {
    Write-PanelLog "Desktop WS patch $Action failed: $($_.Exception.Message)"
    return $null
  }
}

function Invoke-PatchedDesktopCopy {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("status", "install", "remove")]
    [string]$Action
  )
  $copyScript = Join-Path $script:RepoRootPath "scripts\install-patched-codex-desktop-copy.ps1"
  if (-not (Test-Path -LiteralPath $copyScript)) {
    Write-PanelLog "Patched Desktop copy script is missing."
    return $null
  }
  try {
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copyScript -Action $Action -Json 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-PanelLog "Patched Desktop copy $Action failed: $($output -join ' ')"
      return $null
    }
    return ($output -join "`n" | ConvertFrom-Json)
  } catch {
    Write-PanelLog "Patched Desktop copy $Action failed: $($_.Exception.Message)"
    return $null
  }
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
    $webSocketUrl = Get-CodexWebSocketUrl -Config $config
    $readyzUrl = Convert-WebSocketToReadyzUrl -WebSocketUrl $webSocketUrl
    $socksHost = if ($config -and $config.codex -and $config.codex.desktopSocksProxyHost) { [string]$config.codex.desktopSocksProxyHost } else { "127.0.0.1" }
    $socksPort = if ($config -and $config.codex -and $config.codex.desktopSocksProxyPort) { [int]$config.codex.desktopSocksProxyPort } else { 1080 }
    $bridgeProcesses = Get-BridgeProcesses
    $desktopProcesses = @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue)
    $buildPath = Join-Path $script:RepoRootPath "dist\src\main.js"
    $desktopPatch = Invoke-DesktopWsPatch -Action "status"
    $patchedCopy = Invoke-PatchedDesktopCopy -Action "status"
    $desktopWsDirect = ($patchedCopy -and $patchedCopy.state -eq "patched") -or ($desktopPatch -and $desktopPatch.state -eq "patched")

    $script:ConfigStatus.Text = if ($config) { "OK - $script:ConfigPathValue" } else { "Missing - open config first" }
    $script:BuildStatus.Text = if (Test-Path -LiteralPath $buildPath) { "OK - build output exists" } else { "Missing - run Setup / Repair" }
    $script:BridgeStatus.Text = if ($bridgeProcesses.Count -gt 0) { "Running - pid=$($bridgeProcesses[0].ProcessId)" } else { "Stopped" }
    $script:AppServerStatus.Text = if (Test-AppServerReady -ReadyzUrl $readyzUrl) { "Ready - $webSocketUrl" } else { "Not ready - $webSocketUrl" }
    $script:SocksStatus.Text = if ($desktopWsDirect) {
      "Not required - WS direct patch installed"
    } elseif (Test-TcpPort -HostName $socksHost -Port $socksPort) {
      "Ready - ${socksHost}:$socksPort"
    } else {
      "Not ready - ${socksHost}:$socksPort"
    }
    $script:DesktopPatchStatus.Text = if ($patchedCopy -and $patchedCopy.state -eq "patched") {
      "patched copy - $($patchedCopy.patchedExe)"
    } elseif ($desktopPatch) {
      "$($desktopPatch.state) - $($desktopPatch.asarPath)"
    } else {
      "Unknown"
    }
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
$form.Size = New-Object System.Drawing.Size(820, 640)
$form.MinimumSize = New-Object System.Drawing.Size(720, 560)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = [System.Windows.Forms.DockStyle]::Fill
$root.ColumnCount = 1
$root.RowCount = 4
$root.Padding = New-Object System.Windows.Forms.Padding(14)
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 52))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 210))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 138))) | Out-Null
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
$statusGrid.RowCount = 7
$statusGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 120))) | Out-Null
$statusGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.Controls.Add($statusGrid, 0, 1)

$statusItems = @(
  @("Config", "ConfigStatus"),
  @("Build", "BuildStatus"),
  @("Bridge", "BridgeStatus"),
  @("App Server", "AppServerStatus"),
  @("SOCKS", "SocksStatus"),
  @("Desktop Patch", "DesktopPatchStatus"),
  @("Desktop", "DesktopStatus")
)
foreach ($item in $statusItems) {
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
  $row = $statusGrid.RowCount - $statusItems.Count + [array]::IndexOf($statusItems, $item)
  $statusGrid.Controls.Add($nameLabel, 0, $row)
  $statusGrid.Controls.Add($valueLabel, 1, $row)
}

$buttons = New-Object System.Windows.Forms.TableLayoutPanel
$buttons.Dock = [System.Windows.Forms.DockStyle]::Fill
$buttons.ColumnCount = 3
$buttons.RowCount = 3
for ($i = 0; $i -lt 3; $i++) {
  $buttons.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33.33))) | Out-Null
}
$buttons.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 33.33))) | Out-Null
$buttons.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 33.33))) | Out-Null
$buttons.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 33.33))) | Out-Null
$root.Controls.Add($buttons, 0, 2)

$setupScript = Join-Path $script:RepoRootPath "scripts\setup-windows.ps1"
$desktopScript = Join-Path $script:RepoRootPath "scripts\start-codex-desktop-canonical.ps1"
$watchdogScript = Join-Path $script:RepoRootPath "scripts\install-watchdog.ps1"
$desktopPatchScript = Join-Path $script:RepoRootPath "scripts\patch-codex-desktop-ws.ps1"
$desktopCopyScript = Join-Path $script:RepoRootPath "scripts\install-patched-codex-desktop-copy.ps1"

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
$buttons.Controls.Add((New-Button -Text "Launch Shared Desktop" -OnClick {
  Write-PanelLog "Opening shared Desktop launcher."
  Start-ExternalPowerShell -ScriptPath $desktopScript -Arguments @("-RepoRoot", "`"$script:RepoRootPath`"")
}), 1, 1)
$buttons.Controls.Add((New-Button -Text "Install Watchdog" -OnClick {
  Write-PanelLog "Opening watchdog installer."
  Start-ExternalPowerShell -ScriptPath $watchdogScript -Arguments @("-RepoRoot", "`"$script:RepoRootPath`"")
}), 2, 1)
$buttons.Controls.Add((New-Button -Text "Install Patched Desktop" -OnClick {
  Write-PanelLog "Installing patched Codex Desktop copy."
  Start-ExternalPowerShell -ScriptPath $desktopCopyScript -Arguments @("-Action", "install")
}), 0, 2)
$buttons.Controls.Add((New-Button -Text "Remove Patched Desktop" -OnClick {
  Write-PanelLog "Removing patched Codex Desktop copy."
  Start-ExternalPowerShell -ScriptPath $desktopCopyScript -Arguments @("-Action", "remove")
}), 1, 2)
$buttons.Controls.Add((New-Button -Text "Patch Status" -OnClick {
  $status = Invoke-DesktopWsPatch -Action "status"
  $copy = Invoke-PatchedDesktopCopy -Action "status"
  if ($status -or $copy) {
    if ($copy) { Write-PanelLog "Patched Desktop copy state: $($copy.state)" }
    if ($status) { Write-PanelLog "Store app.asar patch state: $($status.state)" }
    Refresh-Status
  }
}), 2, 2)

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
