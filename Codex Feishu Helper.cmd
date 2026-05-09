@echo off
setlocal
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\open-control-panel.ps1" -RepoRoot "%ROOT%"
if errorlevel 1 pause
