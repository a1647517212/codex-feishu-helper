[CmdletBinding()]
param(
  [string]$TaskName = "CodexFeishuWatchdog",
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$IntervalMinutes = 5
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue
  )
  return (Resolve-Path -LiteralPath $PathValue).Path
}

$repoRootPath = Resolve-RequiredPath -PathValue $RepoRoot
$watchdogPath = Join-Path $repoRootPath "scripts\watchdog.ps1"
if (-not (Test-Path -LiteralPath $watchdogPath)) {
  throw "Watchdog script not found: $watchdogPath"
}

$taskUser = "$env:USERDOMAIN\$env:USERNAME"
$startBoundary = (Get-Date).AddMinutes(1).ToString("s")
$author = [Security.SecurityElement]::Escape($taskUser)
$escapedRepoRoot = [Security.SecurityElement]::Escape($repoRootPath)
$escapedWatchdog = [Security.SecurityElement]::Escape($watchdogPath)
$escapedTaskName = [Security.SecurityElement]::Escape($TaskName)
$arguments = [Security.SecurityElement]::Escape("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`" -RepoRoot `"$repoRootPath`"")
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$author</Author>
    <Description>Every five minutes, silently keeps the Feishu Codex bridge and its Codex app-server child process alive.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT$($IntervalMinutes)M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$author</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$escapedRepoRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $escapedTaskName -Xml $taskXml -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Output "Installed scheduled task '$TaskName' for $taskUser. Interval: $IntervalMinutes minutes. Watchdog: $watchdogPath"
