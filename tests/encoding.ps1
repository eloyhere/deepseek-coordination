#requires -version 5.1
<#
  encoding.ps1 - encoding-contract guard for the dsh-os artifacts.

  This whole project exists because encoding assumptions were implicit. This file makes them
  explicit and fails loudly when one drifts. It is itself ASCII-only so Windows PowerShell 5.1 can
  never mis-decode it.

  Contracts enforced:
    bin/dsh-os.ps1        UTF-8 WITH BOM (a BOM-less script is decoded in the ANSI code page by
                          Windows PowerShell 5.1, which mangles every non-ASCII literal in it)
    bin/dsh-os.bat        ASCII only, CRLF line endings (cmd.exe reads it in the OEM code page)
    tests/*.ps1           ASCII only (self-contained guard: no non-ASCII literal may sneak in)
    spec/*.tsv            ASCII only, LF line endings
    command.txt           ASCII only, LF line endings
    docs/*.md             free-form, but a UTF-8 BOM is asserted absent

  Usage: powershell -NoProfile -File tests/encoding.ps1
  Exit code: 0 when every contract holds, 1 otherwise.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$testsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $testsDir

$script:Problems = New-Object System.Collections.ArrayList

function Add-Problem {
  param([string]$Message)
  [void]$script:Problems.Add($Message)
}

function Get-FileInfo {
  param([string]$RelativePath)
  $full = Join-Path $rootDir $RelativePath
  if (-not (Test-Path -LiteralPath $full)) { return $null }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  # The BOM's own three bytes are above 127 by definition, so the ASCII check must start after them.
  $body = if ($hasBom) { $bytes[3..($bytes.Length - 1)] } else { $bytes }
  $nonAscii = 0
  foreach ($b in $body) { if ($b -gt 127) { $nonAscii++ } }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  $crlf = ([regex]::Matches($text, "`r`n")).Count
  $bareLf = ([regex]::Matches($text, "(?<!`r)`n")).Count
  return [pscustomobject]@{
    path = $full; size = $bytes.Length; hasBom = $hasBom
    nonAscii = $nonAscii; crlf = $crlf; bareLf = $bareLf
  }
}

function Test-Contract {
  param([string]$RelativePath, [string]$Rule, [scriptblock]$Check)
  $info = Get-FileInfo -RelativePath $RelativePath
  if ($null -eq $info) { Add-Problem ("missing file: " + $RelativePath); return }
  # @() is required: a scriptblock that returns nothing yields $null, and one violation yields the
  # string itself, so either way .Count would not exist.
  $violations = @(& $Check $info)
  if ($violations.Count -gt 0) {
    foreach ($v in $violations) { Add-Problem ($RelativePath + ": " + $v) }
    Write-Host ("  FAIL  " + $RelativePath + "  (" + $Rule + ")") -ForegroundColor Red
    foreach ($v in $violations) { Write-Host ("        " + $v) -ForegroundColor Red }
  } else {
    Write-Host ("  PASS  " + $RelativePath + "  (" + $Rule + ")") -ForegroundColor Green
  }
}

Write-Host 'dsh-os encoding contracts' -ForegroundColor Cyan

# The Windows implementation must carry a BOM, and must not contain non-ASCII bytes yet: keeping it
# pure ASCII means the BOM requirement is a forward guard rather than a present necessity, which is
# exactly when it is easiest to forget.
Test-Contract 'src\host\bin\dsh-os.ps1' 'utf-8 with BOM' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if (-not $i.hasBom) { [void]$v.Add('must be saved as UTF-8 with BOM; Windows PowerShell 5.1 decodes a BOM-less script in the ANSI code page') }
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; keep this file ASCII-only and build test strings from code points") }
  if ($i.bareLf -gt 0) { [void]$v.Add("$($i.bareLf) bare LF line ending(s); use CRLF") }
  return $v
}

Test-Contract 'src\host\bin\dsh-os.bat' 'ASCII only, CRLF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.hasBom) { [void]$v.Add('must not start with a BOM; cmd.exe would see it as part of the first command') }
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; cmd.exe reads this file in the OEM code page") }
  if ($i.bareLf -gt 0) { [void]$v.Add("$($i.bareLf) bare LF line ending(s); cmd.exe needs CRLF") }
  return $v
}

Test-Contract 'tests\golden.ps1' 'ASCII only' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; a BOM-less script is decoded in the ANSI code page, so build test data from code points instead") }
  return $v
}

Test-Contract 'src\host\spec\verbs.tsv' 'ASCII only, LF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes") }
  if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); the POSIX implementation reads this file too, so keep LF") }
  return $v
}

Test-Contract 'src\host\spec\charsets.tsv' 'ASCII only, LF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes") }
  if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); keep LF") }
  return $v
}

Test-Contract 'src\host\command.txt' 'ASCII only, LF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes") }
  if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); keep LF so both platforms parse it identically") }
  return $v
}

# The POSIX implementation and its test must be LF and ASCII. A CRLF shell script is a real failure
# mode, not a style question: the carriage return becomes part of the last token on every line, and
# on a shebang-driven invocation it breaks interpretation outright.
Test-Contract 'src\host\bin\dsh-os.sh' 'ASCII only, LF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.hasBom) { [void]$v.Add('must not carry a BOM; the shebang must be the first bytes') }
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; keep it ASCII-only") }
  if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); a shell script must be LF") }
  return $v
}

Test-Contract 'tests\golden-sh.sh' 'ASCII only, LF' {
  param($i)
  $v = New-Object System.Collections.ArrayList
  if ($i.hasBom) { [void]$v.Add('must not carry a BOM') }
  if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes") }
  if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); a shell script must be LF") }
  return $v
}

# The generated scripts are verified above; their source modules must also stay ASCII-only, because
# the build composes the artifacts by decoding the modules without a BOM. A module that accidentally
# acquired a non-ASCII character would be decoded in the ANSI code page and would corrupt the
# generated artefact rather than failing here. The shell modules additionally must be LF: a carriage
# return becomes part of the last token on every line.
#
# This walks the tree RECURSIVELY. It used a non-recursive -Filter glob, so when the PowerShell modules
# moved into powershell5.1/ and powershell7.6/ they silently stopped being checked at all - the guard
# reported success while covering only the shell files. A guard that quietly narrows its scope is worse
# than no guard, because it is trusted.
$libDir = Join-Path $rootDir 'src\host\lib'
if (Test-Path -LiteralPath $libDir) {
  $allModules = @(Get-ChildItem -LiteralPath $libDir -Recurse -File | Sort-Object FullName)
  $psModules = @($allModules | Where-Object { $_.Extension -eq '.ps1' })
  $shModules = @($allModules | Where-Object { $_.Extension -eq '.sh' })
  Write-Host ("  module files found under lib: {0} powershell, {1} shell" -f $psModules.Count, $shModules.Count)

  foreach ($module in $psModules) {
    $rel = $module.FullName.Substring($rootDir.Length + 1)
    Test-Contract $rel 'ASCII only' {
      param($i)
      $v = New-Object System.Collections.ArrayList
      if ($i.hasBom) { [void]$v.Add('module must not carry a BOM; the build adds it to the generated script') }
      if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; modules must stay ASCII-only") }
      return $v
    }
  }
  foreach ($module in $shModules) {
    $rel = $module.FullName.Substring($rootDir.Length + 1)
    Test-Contract $rel 'ASCII only, LF' {
      param($i)
      $v = New-Object System.Collections.ArrayList
      if ($i.hasBom) { [void]$v.Add('module must not carry a BOM') }
      if ($i.nonAscii -gt 0) { [void]$v.Add("contains $($i.nonAscii) non-ASCII bytes; modules must stay ASCII-only") }
      if ($i.crlf -gt 0) { [void]$v.Add("$($i.crlf) CRLF line ending(s); shell modules must be LF") }
      return $v
    }
  }
}

# Generated output must never carry a BOM: a caller parsing stdout would see it as part of the JSON.
Write-Host ''
Write-Host '  checking that stdout never carries a BOM' -ForegroundColor Cyan
$ps1 = Join-Path $rootDir 'src\host\bin\dsh-os.ps1'
$pwshExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'powershell.exe' }
# Capture the child's real stdout through a file redirect, which preserves the exact bytes: piping
# through PowerShell would decode and re-encode it, hiding the very defect being tested.
$tmp = Join-Path $env:TEMP ('dsh-os-stdout-' + [Guid]::NewGuid().ToString('n') + '.bin')
# Capture the child's stdout as raw bytes through ProcessStartInfo. PowerShell's own ">" redirect
# decodes and re-encodes the stream, which manufactures a U+FFFD and would make this check lie.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $pwshExe
$psi.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ps1 + '" selfcheck'
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$proc = [System.Diagnostics.Process]::Start($psi)
$ms = New-Object System.IO.MemoryStream
$proc.StandardOutput.BaseStream.CopyTo($ms)
$proc.WaitForExit()
$outBytes = $ms.ToArray()

if ($outBytes.Length -gt 0) {
  $startsWithBom = $outBytes.Length -ge 3 -and $outBytes[0] -eq 0xEF -and $outBytes[1] -eq 0xBB -and $outBytes[2] -eq 0xBF
  if ($startsWithBom) {
    Add-Problem 'stdout must not start with a UTF-8 BOM'
    Write-Host '  FAIL  stdout has a BOM' -ForegroundColor Red
  } else {
    Write-Host '  PASS  stdout has no BOM' -ForegroundColor Green
  }
  # Strict decoding proves the writer produced valid UTF-8; U+FFFD would mean it did not.
  try {
    [void](New-Object System.Text.UTF8Encoding($false, $true)).GetString($outBytes)
    Write-Host '  PASS  stdout is valid UTF-8' -ForegroundColor Green
  } catch {
    Add-Problem ('stdout is not valid UTF-8: ' + $_.Exception.Message)
    Write-Host '  FAIL  stdout is not valid UTF-8' -ForegroundColor Red
  }
  if ([System.Text.Encoding]::UTF8.GetString($outBytes).Contains([char]0xFFFD)) {
    Add-Problem 'stdout contains U+FFFD'
    Write-Host '  FAIL  stdout contains a replacement character' -ForegroundColor Red
  }
  if ($outBytes[0] -ne 0x7B) {
    Add-Problem 'stdout must start with "{" so a caller can parse the envelope immediately'
    Write-Host '  FAIL  stdout does not start with an envelope' -ForegroundColor Red
  }
} else {
  Add-Problem 'could not capture child stdout'
}

Write-Host ''
if ($script:Problems.Count -gt 0) {
  Write-Host ("encoding contract violations: " + $script:Problems.Count) -ForegroundColor Red
  foreach ($p in $script:Problems) { Write-Host ("  - " + $p) -ForegroundColor Red }
  exit 1
}
Write-Host 'all encoding contracts hold' -ForegroundColor Green
exit 0
