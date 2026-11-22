# Rollback for dsh-dialog-plugin.
#
# Removes the plugin from the desktop profile and puts it back, by editing the
# one file DSH reads to decide which bundles a profile mounts:
#
#     C:\Users\30823\.dsh\profiles\desktop\package.json
#       dsh.profile.bundles          <- the bundle list that mounts it
#       dependencies["dsh-dialog-plugin"]  <- the link: entry pnpm installs from
#
# Both places are edited together, so the file never claims a dependency the
# bundle list does not mount. Every write is preceded by a timestamped copy of
# the live file, so a wrong edit is one Copy-Item away from undone.
#
# Modes:
#   status   (default) report only, write nothing, exit 0 = installed, 1 = not
#   remove   take the plugin out of the profile
#   restore  put it back, the way it was installed (link: to the checkout)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Mode remove
#   powershell -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Mode restore
#
# The script does not touch node_modules: the junction there is inert once the
# dependency entry is gone, and leaving it alone means restore needs no install.
# It also does not run pnpm. DSH resolves the link: dependency itself.
#
# This file is deliberately ASCII-only. A .ps1 with non-ASCII text and no BOM is
# decoded as ANSI by PowerShell 5.1, which turns every Chinese string in it into
# mojibake in the console. Explanations in Chinese live in docs/DETAIL.md.

[CmdletBinding()]
param(
    [ValidateSet('status', 'remove', 'restore')]
    [string] $Mode = 'status'
)

$ErrorActionPreference = 'Stop'

$BundleName = 'dsh-dialog-plugin'
$PackageName = 'dsh-dialog-plugin'
$CheckoutDir = 'D:\WB\dsh-dialog-plugin\dsh-dialog-plugin'
$LinkSpec = 'link:D:/WB/dsh-dialog-plugin/dsh-dialog-plugin'

$ProfileDir = if ($env:DSH_PROFILE_DIR) {
    $env:DSH_PROFILE_DIR
} else {
    Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
}

$Manifest = Join-Path $ProfileDir 'package.json'
$BackupDir = Join-Path $ProfileDir 'rollback-backup'
$EvidenceLog = Join-Path $env:USERPROFILE '.dsh\dsh-dialog-plugin\inbox.log'

function Write-Step([string] $Message) {
    Write-Host ''
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Write-Ok([string] $Message) { Write-Host "   $Message" -ForegroundColor Green }
function Write-Warn([string] $Message) { Write-Host "   $Message" -ForegroundColor Yellow }
function Write-Bad([string] $Message) { Write-Host "   $Message" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile directory not found: $ProfileDir" }
if (-not (Test-Path -LiteralPath $Manifest)) { throw "profile manifest not found: $Manifest" }

# Read the manifest and expose the three facts the script edits.
function Read-Manifest {
    Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
}

function Save-Manifest($data) {
    if (-not (Test-Path -LiteralPath $BackupDir)) {
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $BackupDir "package.json.$stamp.bak"
    Copy-Item -LiteralPath $Manifest -Destination $backup -Force
    Write-Ok "backed up to $backup"
    $json = $data | ConvertTo-Json -Depth 32
    # DSH writes this file without a BOM; keep it that way.
    [System.IO.File]::WriteAllText($Manifest, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "wrote $Manifest"
}

function Get-Bundles($data) {
    if ($null -eq $data.dsh -or $null -eq $data.dsh.profile -or $null -eq $data.dsh.profile.bundles) {
        return @()
    }
    return @($data.dsh.profile.bundles)
}

function Get-HasDependency($data) {
    if ($null -eq $data.dependencies) { return $false }
    return ($null -ne $data.dependencies.PSObject.Properties[$PackageName])
}

Write-Step 'Profile'
Write-Ok $ProfileDir

Write-Step 'Current state'
$data = Read-Manifest
$inBundles = (Get-Bundles $data) -contains $BundleName
$hasDependency = Get-HasDependency $data
$linkPath = Join-Path $ProfileDir "node_modules\$PackageName"
$hasLink = Test-Path -LiteralPath $linkPath
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$patchMentions = $false
if (Test-Path -LiteralPath $patchFile) {
    $patchMentions = Select-String -LiteralPath $patchFile -Pattern $BundleName -SimpleMatch -Quiet
}

Write-Ok ("bundles list:      " + $(if ($inBundles) { 'includes ' + $BundleName } else { 'does not include ' + $BundleName }))
Write-Ok ("dependencies:      " + $(if ($hasDependency) { 'has ' + $PackageName + ' -> ' + $data.dependencies.$PackageName } else { 'has no ' + $PackageName }))
Write-Ok ("node_modules:      " + $(if ($hasLink) { 'junction present (inert without the dependency entry)' } else { 'no junction' }))
Write-Ok ("cordis.patch.yml:  " + $(if ($patchMentions) { 'mentions the plugin' } else { 'does not mention it (the bundle patch carries the row)' }))
Write-Ok ("installed state:   " + $(if ($inBundles -and $hasDependency) { 'installed' } else { 'not installed' }))
if ($hasLink -and -not (Test-Path -LiteralPath (Join-Path $CheckoutDir 'package.json'))) {
    Write-Bad "the junction points at a checkout that no longer exists: $CheckoutDir"
}

if ($Mode -eq 'status') {
    Write-Step 'Nothing written (status mode)'
    Write-Host '   Use -Mode remove or -Mode restore to change the profile.'
    if ($inBundles -and $hasDependency) { exit 0 } else { exit 1 }
}

if ($Mode -eq 'remove') {
    if (-not $inBundles -and -not $hasDependency) {
        Write-Step 'Already removed'
        Write-Ok 'The profile does not name the plugin; nothing to do.'
        exit 0
    }
    Write-Step 'Remove'
    if ($hasDependency) {
        $data.dependencies.PSObject.Properties.Remove($PackageName)
        Write-Ok "dropped dependencies['$PackageName']"
    }
    $kept = @(Get-Bundles $data | Where-Object { $_ -ne $BundleName })
    $data.dsh.profile.bundles = $kept
    Write-Ok ("bundles list now has " + $kept.Count + " entries, without " + $BundleName)
    Save-Manifest $data

    $check = Read-Manifest
    if (((Get-Bundles $check) -contains $BundleName) -or (Get-HasDependency $check)) {
        Write-Bad 'the write did not take effect; the manifest still names the plugin'
        exit 1
    }
    Write-Step 'Done'
    Write-Ok 'Reload DSH (F5): the composer buttons and the right-hand tab entry go away.'
    Write-Warn 'A tab already open from the plugin stays as an empty pane until it is closed; that is the sidebar rendering a kind with no registrant.'
    exit 0
}

if ($Mode -eq 'restore') {
    if ($inBundles -and $hasDependency) {
        Write-Step 'Already installed'
        Write-Ok 'Nothing to do.'
        exit 0
    }
    if (-not (Test-Path -LiteralPath (Join-Path $CheckoutDir 'package.json'))) {
        Write-Bad "the checkout is missing: $CheckoutDir"
        exit 1
    }
    Write-Step 'Restore'
    $data = Read-Manifest
    if (-not (Get-HasDependency $data)) {
        $existing = if ($null -eq $data.dependencies) { [pscustomobject]@{} } else { $data.dependencies }
        $existing | Add-Member -NotePropertyName $PackageName -NotePropertyValue $LinkSpec -Force
        $data.dependencies = $existing
        Write-Ok "added dependencies['$PackageName'] = $LinkSpec"
    }
    $bundles = @(Get-Bundles $data)
    if (-not ($bundles -contains $BundleName)) {
        $bundles += $BundleName
        Write-Ok "appended $BundleName to the bundle list"
    }
    $data.dsh.profile.bundles = $bundles
    Save-Manifest $data

    $linkPath = Join-Path $ProfileDir "node_modules\$PackageName"
    if (-not (Test-Path -LiteralPath $linkPath)) {
        New-Item -ItemType Junction -Path $linkPath -Target $CheckoutDir -ErrorAction Stop | Out-Null
        Write-Ok "recreated the junction $linkPath -> $CheckoutDir"
    } else {
        Write-Ok 'junction already present'
    }

    $check = Read-Manifest
    if (-not ((Get-Bundles $check) -contains $BundleName)) {
        Write-Bad 'the write did not take effect; the bundle list still lacks the plugin'
        exit 1
    }
    Write-Step 'Done'
    Write-Ok 'Reload DSH (F5): the buttons come back in the composer row.'
    Write-Warn 'If the buttons do not appear, the profile may still carry an enabled:false record for include:dsh-dialog-plugin. From a DSH session run:'
    Write-Host '       plugin_manager action=set_plugin target=include:dsh-dialog-plugin enabled=true'
    exit 0
}
