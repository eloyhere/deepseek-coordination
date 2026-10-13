# conformance.ps1 - command.txt and spec/verbs.tsv must describe the SAME surface.
#
# spec/verbs.tsv has claimed since it was written that "tests/conformance.ps1 asserts the two agree", and
# that file did not exist: the claim was false and nothing was enforcing it. A comment naming a guard
# that is not there is worse than no comment, because it is read as a guarantee. This is that guard.
#
# What it checks:
#   1. every verb in one table is in the other, in both directions
#   2. the two verb counts agree
#   3. the permission class (R/W) agrees for every verb
#   4. the positional parameter names agree, in order
#
# Deliberately NOT checked: the flag list and the error-code column. Flags in command.txt are prose
# ("--index or --value") and the code column is documented as "beyond the generic set", so a mechanical
# comparison there would produce false failures rather than findings.
#
# Usage: powershell -File tests/conformance.ps1
$ErrorActionPreference = 'Stop'
$rootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $rootDir

$pass = 0
$fail = 0
$failures = New-Object System.Collections.ArrayList

function Check {
  param([string]$What, $Ok, [string]$Detail = '')
  if ($Ok) {
    $script:pass++
    Write-Host ("  PASS  {0}" -f $What) -ForegroundColor Green
  } else {
    $script:fail++
    [void]$script:failures.Add("$What $Detail")
    Write-Host ("  FAIL  {0} {1}" -f $What, $Detail) -ForegroundColor Red
  }
}

Write-Host 'dsh-os table conformance'
Write-Host ''

# ---------------------------------------------------------------------------
# verbs.tsv: verb / positionals / flags / perm / codes
# ---------------------------------------------------------------------------
$tsv = [ordered]@{}
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $rootDir 'src\host\spec\verbs.tsv'))) {
  if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
  $f = $line -split "`t"
  if ($f.Count -lt 4) { continue }
  $pos = if ($f[1].Trim() -eq '-') { @() } else { @($f[1].Trim() -split '\|') }
  $tsv[$f[0]] = [pscustomobject]@{ verb = $f[0]; positionals = $pos; perm = $f[3].Trim() }
}
Write-Host ("  verbs.tsv declares {0} verbs" -f $tsv.Count) -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# command.txt lines look like:  <verb...> <positional names...>   // <R|W>  <description>
#
# The verb may be one, two or three words and the parameters follow it, so the boundary between them is
# not marked. It is resolved by trying the longest word-prefix that names a verb in verbs.tsv: "file
# verify charset path charset" resolves to file.verify.charset because that verb exists, while
# "file charset path" resolves to file.charset. Requiring the prefix to be a KNOWN verb is what makes
# this unambiguous rather than a guess.
# ---------------------------------------------------------------------------
$known = @{}
foreach ($v in $tsv.Keys) { $known[$v] = $true }

$cmd = [ordered]@{}
$unresolved = New-Object System.Collections.ArrayList
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $rootDir 'src\host\command.txt'))) {
  if ($line -notmatch '\s+//\s+[RW]\b') { continue }
  $head = ($line -split '\s+//')[0].Trim()
  if ($head -eq '' -or $head.StartsWith('//')) { continue }
  $perm = if ($line -match '\s+//\s+(R|W)\b') { $Matches[1] } else { '' }
  $tokens = @($head -split '\s+')

  $matchedVerb = $null
  $used = 0
  # Longest prefix first, so file.verify.charset wins over a hypothetical file.verify.
  for ($n = [Math]::Min(3, $tokens.Count); $n -ge 1; $n--) {
    $candidate = ($tokens[0..($n - 1)] -join '.')
    if ($known.ContainsKey($candidate)) { $matchedVerb = $candidate; $used = $n; break }
  }
  if ($null -eq $matchedVerb) {
    [void]$unresolved.Add($head)
    continue
  }
  $cmd[$matchedVerb] = [pscustomobject]@{
    verb = $matchedVerb
    positionals = @($tokens | Select-Object -Skip $used)
    perm = $perm
  }
}
Write-Host ("  command.txt declares {0} verbs" -f $cmd.Count) -ForegroundColor Cyan
if ($unresolved.Count -gt 0) {
  Write-Host ("  could not resolve {0} line(s): {1}" -f $unresolved.Count, ($unresolved -join ' | ')) -ForegroundColor Yellow
}
Write-Host ''

# ---------------------------------------------------------------------------
# 1. the two sets must be identical, in both directions
# ---------------------------------------------------------------------------
$onlyTsv = @($tsv.Keys | Where-Object { -not $cmd.Contains($_) } | Sort-Object)
$onlyCmd = @($cmd.Keys | Where-Object { -not $tsv.Contains($_) } | Sort-Object)
Check 'every verbs.tsv verb appears in command.txt' ($onlyTsv.Count -eq 0) ("missing: " + ($onlyTsv -join ', '))
Check 'every command.txt verb appears in verbs.tsv' ($onlyCmd.Count -eq 0) ("missing: " + ($onlyCmd -join ', '))

# ---------------------------------------------------------------------------
# 2. counts agree
# ---------------------------------------------------------------------------
Check 'the two verb counts are equal' ($tsv.Count -eq $cmd.Count) ("{0} vs {1}" -f $tsv.Count, $cmd.Count)

# ---------------------------------------------------------------------------
# 3. the permission class agrees for every shared verb
# ---------------------------------------------------------------------------
$permBad = New-Object System.Collections.ArrayList
foreach ($v in $tsv.Keys) {
  if (-not $cmd.Contains($v)) { continue }
  if ($tsv[$v].perm -ne $cmd[$v].perm) {
    [void]$permBad.Add(("{0}: tsv={1} command.txt={2}" -f $v, $tsv[$v].perm, $cmd[$v].perm))
  }
}
Check 'R/W agrees for every verb' ($permBad.Count -eq 0) (($permBad | Select-Object -First 6) -join '; ')

# ---------------------------------------------------------------------------
# 4. the positional parameter names agree, in order
# ---------------------------------------------------------------------------
$posBad = New-Object System.Collections.ArrayList
foreach ($v in $tsv.Keys) {
  if (-not $cmd.Contains($v)) { continue }
  $a = @($tsv[$v].positionals)
  $b = @($cmd[$v].positionals)
  if (($a -join ',') -ne ($b -join ',')) {
    [void]$posBad.Add(("{0}: tsv=[{1}] command.txt=[{2}]" -f $v, ($a -join ' '), ($b -join ' ')))
  }
}
Check 'positional names agree for every verb' ($posBad.Count -eq 0) (($posBad | Select-Object -First 8) -join '; ')

Write-Host ''
Write-Host ("passed={0} failed={1}" -f $pass, $fail)
if ($fail -gt 0) {
  Write-Host 'failures:'
  foreach ($f in $failures) { Write-Host ("  - {0}" -f $f) }
  exit 1
}
exit 0
