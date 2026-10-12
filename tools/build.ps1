#requires -version 5.1
<#
  build.ps1 - assemble src/host/lib/*.ps1 into src/host/bin/dsh-os.ps1.

  Why a build step rather than dot-sourcing the modules at runtime:

    * The distributed script must stay a single self-contained file. It is invoked directly by the
      harness and by hand, it must carry UTF-8 with BOM so Windows PowerShell 5.1 parses it in the
      right code page, and it must run with no module resolution, no path assumptions and no loader.
    * Dot-sourcing would make every invocation depend on relative paths, and on PowerShell 5.1 a
      sourced file without a BOM is decoded in the ANSI code page, which is precisely the class of
      encoding fault this project exists to remove.
    * Concatenation keeps the readable, reviewable modules as the source of truth while the shipped
      artefact stays exactly one file.

  The build is byte-deterministic: the same modules always produce the same script, so a diff of
  bin/dsh-os.ps1 shows real changes rather than ordering noise.

  Usage: powershell -NoProfile -File tools/build.ps1 [-Check]
         -Check verifies the committed script matches the modules and fails if it does not.
#>
param(
  [switch]$Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $toolsDir
$libDir = Join-Path $rootDir 'src\host\lib'
$outFile = Join-Path $rootDir 'src\host\bin\dsh-os.ps1'

if (-not (Test-Path -LiteralPath $libDir)) { throw "module directory not found: $libDir" }

# Concatenation order is dependency order: every module may only use names defined above it.
$modules = @(
  '00-preamble.ps1',   # header comment, set-strictmode, encodings, layout discovery
  '01-json.ps1',       # JSON encoding and the envelope writer
  '02-command.ps1',    # argument parsing, named arguments, assertions, int coercion
  '03-charset.ps1',    # charset table, BOM policy, byte-level text model
  '04-native.ps1',     # Add-Type P/Invoke declarations and atomic replace
  '05-paths.ps1',      # path resolution and the protected-path boundary
  '06-file.ps1',       # file.*, file verify.*, file search
  '07-system.ps1',     # system.* queries
  '08-execute.ps1',    # execute.command / synchronous / asynchronous
  '09-task.ps1',       # task.*
  '10-environment.ps1',# environment.* and environment attribute.*
  '11-service.ps1',    # service.*
  '12-permission.ps1', # permission.* (read-only)
  '13-window.ps1',     # window.* / mouse.* / keyboard.* / clipboard.* / wait.* / observe
  '14-dispatch.ps1',   # selfcheck, verb table lookup, dispatch table
  '15-entry.ps1'       # entry point: run, emit, exit
)

$missing = @()
foreach ($m in $modules) { if (-not (Test-Path -LiteralPath (Join-Path $libDir $m))) { $missing += $m } }
if ($missing.Count -gt 0) { throw ("missing module(s): " + ($missing -join ', ')) }

$ascii = New-Object System.Text.UTF8Encoding($false)
$withBom = New-Object System.Text.UTF8Encoding($true)

$parts = New-Object System.Collections.ArrayList
$banner = @"
# dsh-os.ps1 - GENERATED FILE. Do not edit directly.
#
# Assembled by tools/build.ps1 from src/host/lib/*.ps1, which are the source of truth:
#
"@
[void]$parts.Add($banner)
foreach ($m in $modules) { [void]$parts.Add('#   ' + $m) }
[void]$parts.Add(@"
#
# The shipped script is deliberately a single self-contained file: it is invoked directly by the
# harness and by hand, it must carry UTF-8 with BOM so Windows PowerShell 5.1 decodes it in the right
# code page, and it must run without module resolution or relative-path assumptions.
"@)

foreach ($m in $modules) {
  $path = Join-Path $libDir $m
  $text = [System.IO.File]::ReadAllText($path, $ascii)
  # Modules are ASCII-only, so a BOM never survives here; strip one defensively anyway.
  $text = $text.TrimStart([char]0xFEFF)
  $text = $text -replace "`r`n", "`n"
  [void]$parts.Add("")
  [void]$parts.Add("# ===== " + $m + " " + ('=' * [Math]::Max(0, 60 - $m.Length)))
  [void]$parts.Add("")
  [void]$parts.Add($text.TrimEnd("`n"))
}
$assembled = ($parts -join "`n") + "`n"
# The generated script is CRLF: it is a PowerShell script consumed on Windows.
$assembled = $assembled -replace "`r`n", "`n" -replace "`n", "`r`n"
$bytes = $withBom.GetPreamble() + $withBom.GetBytes($assembled)

if ($Check) {
  if (-not (Test-Path -LiteralPath $outFile)) {
    Write-Host 'CHECK FAILED: generated script is missing; run tools/build.ps1' -ForegroundColor Red
    exit 1
  }
  $onDisk = [System.IO.File]::ReadAllBytes($outFile)
  if ($onDisk.Length -ne $bytes.Length) {
    Write-Host ("CHECK FAILED: bin/dsh-os.ps1 is {0} bytes, modules assemble to {1}; re-run tools/build.ps1" -f $onDisk.Length, $bytes.Length) -ForegroundColor Red
    exit 1
  }
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if ($onDisk[$i] -ne $bytes[$i]) {
      Write-Host ("CHECK FAILED: bin/dsh-os.ps1 differs from the modules at byte {0}; re-run tools/build.ps1" -f $i) -ForegroundColor Red
      exit 1
    }
  }
  Write-Host ("CHECK OK: bin/dsh-os.ps1 matches {0} modules ({1} bytes)" -f $modules.Count, $bytes.Length) -ForegroundColor Green
  exit 0
}

[System.IO.File]::WriteAllBytes($outFile, $bytes)
Write-Host ("built bin/dsh-os.ps1 from {0} modules ({1} bytes)" -f $modules.Count, $bytes.Length) -ForegroundColor Green
