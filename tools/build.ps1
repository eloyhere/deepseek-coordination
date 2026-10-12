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
$outPs1 = Join-Path $rootDir 'src\host\bin\dsh-os.ps1'
$outSh = Join-Path $rootDir 'src\host\bin\dsh-os.sh'

if (-not (Test-Path -LiteralPath $libDir)) { throw "module directory not found: $libDir" }

# Concatenation order is dependency order: every module may only use names defined above it.
$modulesPs1 = @(
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

# The shell modules mirror the PowerShell ones by concern. Their order here is SOURCE order, which
# is not the same as the numeric names suggest: the shell file defines the path helpers before the
# document helpers, so 05-paths precedes 03-charset. Reordering them would change behaviour because
# some top-level state is initialised at first use.
$modulesSh = @(
  '00-preamble.sh',    # locale, layout discovery, repository root
  '01-json.sh',        # jstr/emit_envelope, error model, fail
  '02-command.sh',     # argument parsing, named arguments, assertions
  '04-native.sh',      # native primitives (no POSIX declarations needed)
  '05-paths.sh',       # protected-path boundary
  '03-charset.sh',     # charset table, detection, byte-level document model
  '06-file.sh',        # file.*, file verify.*, file search
  '07-system.sh',      # system.*
  '08-execute.sh',     # execute.* (not implemented on POSIX)
  '09-task.sh',        # task.list / task.query
  '10-environment.sh', # environment.* and environment attribute.*
  '11-service.sh',     # service.* (not implemented on POSIX)
  '12-permission.sh',  # permission.list and selfcheck
  '13-window.sh',      # window/mouse/keyboard (not implemented on POSIX)
  '14-dispatch.sh',    # verb resolution and the dispatch table
  '15-entry.sh'        # main and the run/emit/exit block
)

$ascii = New-Object System.Text.UTF8Encoding($false)
$withBom = New-Object System.Text.UTF8Encoding($true)

# Assemble one module list into bytes. LF is used throughout and converted per artifact, so a module
# authored on either platform produces the identical result.
function Get-AssembledBytes {
  param(
    [string[]]$Modules,
    [string]$Header,
    [string]$Footer,
    [string]$Eol,
    [bool]$Bom
  )
  $parts = New-Object System.Collections.ArrayList
  # Header, then the module list, then the footer. The footer must come last: passing header+footer as
  # one string and appending the list afterwards produced a stray "##" line and a header that read as
  # if the footer text were a module.
  [void]$parts.Add($Header)
  foreach ($m in $Modules) { [void]$parts.Add('#   ' + $m) }
  [void]$parts.Add($Footer)
  [void]$parts.Add('')
  foreach ($m in $Modules) {
    $path = Join-Path $libDir $m
    if (-not (Test-Path -LiteralPath $path)) { throw "missing module: $m" }
    $text = [System.IO.File]::ReadAllText($path, $ascii)
    # Modules are ASCII-only, so a BOM never survives here; strip one defensively anyway.
    $text = $text.TrimStart([char]0xFEFF)
    $text = $text -replace "`r`n", "`n"
    [void]$parts.Add('')
    [void]$parts.Add('# ===== ' + $m + ' ' + ('=' * [Math]::Max(0, 60 - $m.Length)))
    [void]$parts.Add('')
    [void]$parts.Add($text.TrimEnd("`n"))
  }
  $assembled = ($parts -join "`n") + "`n"
  if ($Eol -eq 'crlf') { $assembled = $assembled -replace "`r`n", "`n" -replace "`n", "`r`n" }
  if ($Bom) { return $withBom.GetPreamble() + $withBom.GetBytes($assembled) }
  return $ascii.GetBytes($assembled)
}

$ps1Header = @'
# dsh-os.ps1 - GENERATED FILE. Do not edit directly.
#
# Assembled by tools/build.ps1 from src/host/lib/*.ps1, which are the source of truth:
#
'@
$ps1Footer = @'
#
# The shipped script is deliberately a single self-contained file: it is invoked directly by the
# harness and by hand, it must carry UTF-8 with BOM so Windows PowerShell 5.1 decodes it in the right
# code page, and it must run without module resolution or relative-path assumptions.
'@
$shHeader = @'
#!/usr/bin/env bash
# dsh-os.sh - GENERATED FILE. Do not edit directly.
#
# Assembled by tools/build.ps1 from src/host/lib/*.sh, which are the source of truth:
#
'@
$shFooter = @'
#
# The shipped script is deliberately a single self-contained file, LF-terminated and BOM-free: the
# shebang must be the very first bytes, and a carriage return would become part of the last token on
# every line.
'@

$ps1Bytes = Get-AssembledBytes -Modules $modulesPs1 -Header $ps1Header -Footer $ps1Footer -Eol 'crlf' -Bom $true
$shBytes = Get-AssembledBytes -Modules $modulesSh -Header $shHeader -Footer $shFooter -Eol 'lf' -Bom $false

if ($Check) {
  $failures = 0
  foreach ($pair in @(
    @{ path = $outPs1; bytes = $ps1Bytes; label = 'src/host/bin/dsh-os.ps1' },
    @{ path = $outSh;  bytes = $shBytes;  label = 'src/host/bin/dsh-os.sh' }
  )) {
    if (-not (Test-Path -LiteralPath $pair.path)) {
      Write-Host ("CHECK FAILED: {0} is missing; run tools/build.ps1" -f $pair.label) -ForegroundColor Red
      $failures++
      continue
    }
    $onDisk = [System.IO.File]::ReadAllBytes($pair.path)
    $expected = $pair.bytes
    if ($onDisk.Length -ne $expected.Length) {
      Write-Host ("CHECK FAILED: {0} is {1} bytes, modules assemble to {2}; run tools/build.ps1" -f $pair.label, $onDisk.Length, $expected.Length) -ForegroundColor Red
      $failures++
      continue
    }
    for ($i = 0; $i -lt $expected.Length; $i++) {
      if ($onDisk[$i] -ne $expected[$i]) {
        Write-Host ("CHECK FAILED: {0} differs from the modules at byte {1}; run tools/build.ps1" -f $pair.label, $i) -ForegroundColor Red
        $failures++
        break
      }
    }
  }
  if ($failures -gt 0) { exit 1 }
  Write-Host ("CHECK OK: both generated scripts match their modules ({0} + {1} bytes)" -f $ps1Bytes.Length, $shBytes.Length) -ForegroundColor Green
  exit 0
}

[System.IO.File]::WriteAllBytes($outPs1, $ps1Bytes)
[System.IO.File]::WriteAllBytes($outSh, $shBytes)
Write-Host ("built bin/dsh-os.ps1 from {0} modules ({1} bytes)" -f $modulesPs1.Count, $ps1Bytes.Length) -ForegroundColor Green
Write-Host ("built bin/dsh-os.sh  from {0} modules ({1} bytes)" -f $modulesSh.Count, $shBytes.Length) -ForegroundColor Green
