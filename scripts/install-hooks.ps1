# ---------------------------------------------------------------------------
# Enable repository-level Git hooks (core.hooksPath -> versioned .githooks/)
#
# Usage:
#   pwsh -File scripts/install-hooks.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-hooks.ps1
#
# Note: core.hooksPath is local config and is not distributed by clone,
#       so run this once after cloning.
#
# Output is intentionally ASCII-only so that it renders correctly under
# Windows PowerShell 5.1 with legacy (GBK) console code pages.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$root = git rev-parse --show-toplevel
if (-not $root) { throw 'Not inside a Git repository.' }
Set-Location $root

if (-not (Test-Path '.githooks')) {
    throw '.githooks directory not found. Run this from the repository root.'
}

git config --local core.hooksPath .githooks

Write-Host '[OK] Repository Git hooks enabled: core.hooksPath=.githooks'
Write-Host '     Active hooks:'
Get-ChildItem '.githooks' -File | ForEach-Object { Write-Host "       - $($_.Name)" }
Write-Host ''
Write-Host '     Verify: git config --local --get core.hooksPath'
