#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Mark one published version of this package as deprecated on the npm registry.

.DESCRIPTION
    Reads the package name from the package.json next to this script, verifies
    that the requested version really is published, then calls:

        npm deprecate <name>@<version> "<message>"

    Deprecation is a registry write: it needs a token that may publish
    (a granular token with "bypass 2FA", or a session with an OTP). Use -DryRun
    to see the exact npm command without touching the registry.

.PARAMETER Version
    The published version to deprecate, for example 0.10.0. A leading "v" is
    accepted and stripped.

.PARAMETER Message
    Deprecation text that npm shows on install. Defaults to a message that
    points at the current latest release.

.PARAMETER Undo
    Remove the deprecation instead of setting one.

.PARAMETER Yes
    Do not ask for confirmation.

.PARAMETER DryRun
    Print the npm command and exit without changing anything.

.EXAMPLE
    ./deprecate.ps1 0.10.0
    Asks for confirmation, then deprecates 0.10.0.

.EXAMPLE
    ./deprecate.ps1 0.10.0 -Message "Broken host half; use 0.10.1" -Yes
    Non-interactive, explicit message.

.EXAMPLE
    ./deprecate.ps1 0.10.0 -Undo
    Clears the deprecation message of 0.10.0.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Version,

    [Parameter(Position = 1)]
    [string]$Message,

    [switch]$Undo,

    [switch]$Yes,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $PSScriptRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "package.json not found: $manifestPath"
}
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$name = $manifest.name
if ([string]::IsNullOrWhiteSpace($name)) {
    throw "package.json has no ""name"" field"
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    throw "npm was not found on PATH"
}

$target = $Version.Trim()
if ($target.StartsWith('v')) { $target = $target.Substring(1) }
if ([string]::IsNullOrWhiteSpace($target)) {
    throw "Version must not be empty"
}

# Fail early when the version is not published: deprecating it would 404.
$published = & npm view "$name@$target" version --json 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($published | Out-String).Trim())) {
    throw "$name@$target is not published (or the registry is unreachable)"
}

if ($Undo) {
    $Message = ''
} elseif ([string]::IsNullOrWhiteSpace($Message)) {
    $latest = (& npm view $name dist-tags.latest --json 2>$null | Out-String).Trim().Trim('"')
    $Message = if ($latest) {
        "$name@$target is deprecated; install $latest or newer."
    } else {
        "$name@$target is deprecated; install the latest release."
    }
}

$npmArgs = @('deprecate', "$name@$target", $Message)

if ($DryRun) {
    $shown = if ($Undo) { '<empty message>' } else { $Message }
    "dry run: npm deprecate $name@$target `"$shown`""
    return
}

if (-not $Yes) {
    $action = if ($Undo) { 'Clear the deprecation of' } else { 'Deprecate' }
    $answer = Read-Host "$action $name@$target ? [y/N]"
    if ($answer -notmatch '^(y|yes)$') {
        "aborted"
        exit 1
    }
}

& npm @npmArgs
if ($LASTEXITCODE -ne 0) {
    throw "npm deprecate failed with exit code $LASTEXITCODE"
}

$state = (& npm view "$name@$target" deprecated --json 2>$null | Out-String).Trim()
"$name@$target"
if ($Undo) {
    "  deprecation cleared"
} else {
    "  deprecated: $Message"
}
