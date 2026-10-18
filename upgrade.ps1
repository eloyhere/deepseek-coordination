#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Increment the version field of a package.json by one step.

.DESCRIPTION
    Reads the package.json next to this script (or -Path), parses its top-level
    "version" field and raises it by one semantic-version step:

        patch : 0.10.1 -> 0.10.2      (default)
        minor : 0.10.1 -> 0.11.0
        major : 0.10.1 -> 1.0.0

    Only the version value is rewritten. The surrounding text, key order,
    indentation and line endings are left byte-for-byte intact, so the diff is
    a single line. A pre-release suffix (0.10.1-rc.2) is dropped and the patch
    number is raised (0.10.2).

    package-lock.json is NOT touched. To re-sync it afterwards run:
        npm install --package-lock-only

.PARAMETER Part
    Which component to raise: patch (default), minor or major.

.PARAMETER Path
    package.json to update. Defaults to the one beside this script.

.PARAMETER DryRun
    Print the planned change without writing the file.

.EXAMPLE
    ./upgrade.ps1
    0.10.1 -> 0.10.2

.EXAMPLE
    ./upgrade.ps1 -Part minor -DryRun
    dry run: 0.10.1 -> 0.11.0
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Part = 'patch',

    [string]$Path,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not $Path) { $Path = Join-Path $PSScriptRoot 'package.json' }
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "package.json not found: $Path"
}

$raw = [System.IO.File]::ReadAllText($Path)

# Match the top-level "version" line only; nested objects are not considered.
$pattern = '(?m)^(?<head>[ \t]*"version"[ \t]*:[ \t]*")(?<ver>[^"]+)(?<tail>")'
$match = [regex]::Match($raw, $pattern)
if (-not $match.Success) {
    throw "No top-level ""version"" field found in $Path"
}

$current = $match.Groups['ver'].Value
$core = ($current -split '-', 2)[0]
$fields = $core -split '\.'
if ($fields.Count -ne 3 -or ($fields | Where-Object { $_ -notmatch '^\d+$' })) {
    throw "Unsupported version format: '$current' (expected MAJOR.MINOR.PATCH[-prerelease])"
}

[int]$major = $fields[0]
[int]$minor = $fields[1]
[int]$patch = $fields[2]

switch ($Part) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
}

$next = "$major.$minor.$patch"
if ($next -eq $current) {
    throw "Version was not raised: $current -> $next"
}

$prefix = $raw.Substring(0, $match.Groups['ver'].Index)
$suffix = $raw.Substring($match.Groups['ver'].Index + $current.Length)
$updated = $prefix + $next + $suffix

if ($DryRun) {
    "dry run: $current -> $next ($Path)"
    return
}

# UTF-8 without BOM keeps the file identical apart from the version digits.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Path, $updated, $utf8)

"$Path"
"  version: $current -> $next ($Part)"
"  hint: run 'npm install --package-lock-only' to re-sync package-lock.json"
