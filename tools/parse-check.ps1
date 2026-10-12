# parse-check.ps1 - parse-check PowerShell files under the current runtime, and report ASCII/BOM state.
#
# Written as a script rather than an inline -Command because the inline form has to survive shell
# quoting from the caller, which broke a backslash-containing path when this was first attempted.
#
# Usage: pwsh -NoProfile -File tools/parse-check.ps1 [-Path <dir-or-file>] ...
#        With no -Path it checks every .ps1 in src/host/lib/powershell7.6.
param(
  [string[]]$Path
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Path -or $Path.Count -eq 0) {
  $Path = @(Join-Path $root 'src\host\lib\powershell7.6')
}

$files = @()
foreach ($p in $Path) {
  $resolved = if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $root $p }
  if (Test-Path -LiteralPath $resolved -PathType Container) {
    $files += @(Get-ChildItem -LiteralPath $resolved -Recurse -File -Filter '*.ps1')
  } elseif (Test-Path -LiteralPath $resolved -PathType Leaf) {
    $files += @(Get-Item -LiteralPath $resolved)
  } else {
    Write-Host ("MISSING: {0}" -f $resolved) -ForegroundColor Red
  }
}

# Only the dsh-os modules are checked for ASCII-only and BOM-free.
#
# tools/build.ps1 concatenates an explicit module list, and those modules must be plain ASCII so the
# assembler can decode them without a BOM. Other .ps1 files may legitimately live beside them -- for
# example a standalone interactive tool that is deliberately NOT part of the module list, is never
# concatenated, and is free to carry non-ASCII prose. Failing such a file here would be a false alarm:
# it would report a contract violation where no contract applies to it.
$moduleSet = @(
  'preamble', 'json', 'command', 'charset', 'native', 'paths', 'file', 'system', 'execute',
  'task', 'environment', 'service', 'permission', 'window', 'dispatch', 'entry'
)
$nonModules = @($files | Where-Object { $moduleSet -notcontains $_.BaseName })
$files = @($files | Where-Object { $moduleSet -contains $_.BaseName })
if ($nonModules.Count -gt 0) {
  Write-Host ("skipping {0} non-module file(s): {1}" -f $nonModules.Count, (($nonModules | ForEach-Object { $_.Name }) -join ', ')) -ForegroundColor DarkGray
}

Write-Host ("runtime: PowerShell {0} ({1})" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
$bad = 0
foreach ($f in ($files | Sort-Object FullName)) {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errors) | Out-Null
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $nonAscii = @($bytes | Where-Object { $_ -gt 127 }).Count
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $funcs = @(Select-String -LiteralPath $f.FullName -Pattern '^function ([A-Za-z][A-Za-z0-9-]*)' |
    ForEach-Object { $_.Matches[0].Groups[1].Value })

  $problems = @()
  if ($errors -and $errors.Count -gt 0) { $problems += ("{0} parse error(s)" -f $errors.Count) }
  if ($nonAscii -gt 0) { $problems += ("{0} non-ASCII byte(s)" -f $nonAscii) }
  if ($hasBom) { $problems += 'has a BOM' }

  if ($problems.Count -eq 0) {
    Write-Host ("  PASS  {0,-18} {1,3} function(s)" -f $f.Name, $funcs.Count) -ForegroundColor Green
  } else {
    $bad++
    Write-Host ("  FAIL  {0,-18} {1}" -f $f.Name, ($problems -join '; ')) -ForegroundColor Red
    if ($errors) {
      $errors | Select-Object -First 5 | ForEach-Object {
        Write-Host ("          line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) -ForegroundColor DarkGray
      }
    }
  }
}

Write-Host ''
if ($bad -gt 0) {
  Write-Host ("{0} file(s) with problems" -f $bad) -ForegroundColor Red
  exit 1
}
Write-Host ("all {0} file(s) parse cleanly, are ASCII-only and carry no BOM" -f $files.Count) -ForegroundColor Green
exit 0
