#requires -version 5.1
<#
  golden.ps1 - Windows golden-case runner for the dsh-os atomic command surface.

  Every case drives the real scripts through argv (never a shell string) and asserts on the JSON
  envelope plus the raw bytes on disk. Byte-level assertions matter here: the whole point of this
  layer is that BOM, EOL and encoding survive a round trip, and only bytes prove that.

  THIS FILE IS DELIBERATELY ASCII-ONLY. Windows PowerShell 5.1 decodes a script without a BOM using
  the ANSI code page, so any non-ASCII literal here would be mangled before a single assertion ran
  (a Chinese Windows install decodes UTF-8 bytes as GBK). Non-ASCII test data is therefore built
  from code points at runtime, e.g. [string][char]0x4E2D.

  Usage:
    powershell -NoProfile -File tests/golden.ps1                 # all cases
    powershell -NoProfile -File tests/golden.ps1 -Filter bom     # cases whose name matches
    powershell -NoProfile -File tests/golden.ps1 -KeepSandbox    # leave the fixture tree in place

  Exit code: 0 when every selected case passes, 1 otherwise.
#>
param(
  [string]$Filter = '',
  [switch]$KeepSandbox
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$testsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $testsDir
$ps1 = Join-Path $rootDir 'src\host\bin\dsh-os.ps1'
$pwshExe = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'powershell.exe' }
if (-not (Test-Path -LiteralPath $ps1)) { throw "cannot find $ps1" }

$sandbox = Join-Path $rootDir '.temporary\golden'
if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

# Test strings built from code points so this file stays pure ASCII.
$CN = [string]([char]0x4E2D + [char]0x6587 + [char]0x6D4B + [char]0x8BD5)   # "zhong wen ce shi"
$CN_DIR = [string]([char]0x4E2D + [char]0x6587)                                # "zhong wen"

$script:Passed = 0
$script:Failed = 0
$script:Failures = New-Object System.Collections.ArrayList

function Get-Hex {
  param([string]$FilePath)
  if (-not (Test-Path -LiteralPath $FilePath)) { return '<missing>' }
  return (([System.IO.File]::ReadAllBytes($FilePath)) | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Write-Bytes {
  param([string]$FilePath, [byte[]]$Bytes)
  $dir = Split-Path -Parent $FilePath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllBytes($FilePath, $Bytes)
}

# Invoke the script the way the harness does: an argv array handed to a child process, no shell.
function Invoke-Os {
  param([string[]]$Argv)
  $stdout = & $pwshExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ps1 @Argv 2>$null
  $exit = $LASTEXITCODE
  $text = ($stdout -join "`n")
  $parsed = $null
  try { $parsed = $text | ConvertFrom-Json } catch { }
  return [pscustomobject]@{ exit = $exit; json = $parsed; raw = $text }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$What)
  if ($Expected -ne $Actual) { throw ("$What`: expected '$Expected', got '$Actual'") }
}

function Assert-True {
  param($Condition, [string]$What)
  if (-not $Condition) { throw $What }
}

# Fails a case with the raw envelope when the call was expected to fail but succeeded, which is far
# more useful than a strict-mode error about a missing 'error' property.
function Assert-OsError {
  param($Result)
  if ($null -eq $Result.json -or $null -eq $Result.json.PSObject.Properties['error']) {
    throw ('expected a typed error, got: ' + $Result.raw)
  }
  return $Result.json.error
}

function Assert-Case {
  param([string]$Name, [scriptblock]$Body)
  if ($Filter -ne '' -and $Name -notlike "*$Filter*") { return }
  try {
    & $Body
    $script:Passed++
    Write-Host ("  PASS  " + $Name) -ForegroundColor Green
  } catch {
    $script:Failed++
    [void]$script:Failures.Add([pscustomobject]@{ name = $Name; error = $_.Exception.Message })
    Write-Host ("  FAIL  " + $Name) -ForegroundColor Red
    Write-Host ("        " + $_.Exception.Message) -ForegroundColor Red
  }
}

# ---------------------------------------------------------------------------
Write-Host 'dsh-os golden cases (win32)' -ForegroundColor Cyan
Write-Host ("  script:  " + $ps1)
Write-Host ("  sandbox: " + $sandbox)

# -- 1. spaces in the path --------------------------------------------------
Assert-Case 'path-with-spaces/create-charset-view' {
  $p = Join-Path $sandbox 'a b\c d.txt'
  $r = Invoke-Os @('file', 'create', $p, 'hello world', 'utf-8', '--allow')
  Assert-Equal 0 $r.exit 'create exit'
  Assert-Equal $true $r.json.ok 'create ok'
  Assert-Equal 'utf-8' (Invoke-Os @('file', 'charset', $p)).json.result.charset 'charset'
  Assert-Equal '1: hello world' (Invoke-Os @('file', 'view', $p)).json.result.text 'view text'
}

# -- 2. non-ASCII path and content -----------------------------------------
Assert-Case 'non-ascii/path-and-content' {
  $p = Join-Path $sandbox ($CN_DIR + ' dir\' + $CN + '.txt')
  $r = Invoke-Os @('file', 'create', $p, $CN, 'utf-8', '--allow')
  Assert-Equal 0 $r.exit 'create exit'
  Assert-Equal ("1: " + $CN) (Invoke-Os @('file', 'view', $p)).json.result.text 'view text'
}

# -- 3. UTF-8 with BOM: detected, and the BOM survives append --------------
Assert-Case 'bom/detected-and-preserved-on-append' {
  $p = Join-Path $sandbox 'bom\keep.txt'
  Invoke-Os @('file', 'create', $p, 'line1', 'utf-8-bom', '--allow') | Out-Null
  Assert-Equal 'efbbbf6c696e6531' (Get-Hex $p) 'bytes after create'
  Assert-Equal 0 (Invoke-Os @('file', 'append', $p, 'X', '--allow')).exit 'append exit'
  Assert-True ((Get-Hex $p).StartsWith('efbbbf')) 'BOM must survive append'
  $r = Invoke-Os @('file', 'charset', $p)
  Assert-Equal 'utf-8-bom' $r.json.result.charset 'charset'
  Assert-Equal $true $r.json.result.bom 'bom flag'
}

# -- 4. BOM must never leak into the text a caller sees --------------------
Assert-Case 'bom/never-leaks-into-view' {
  $p = Join-Path $sandbox 'bom\noleak.txt'
  Invoke-Os @('file', 'create', $p, 'abc', 'utf-8-bom', '--allow') | Out-Null
  $r = Invoke-Os @('file', 'view', $p)
  Assert-True (-not $r.json.result.text.Contains([char]0xFEFF)) 'view text must not contain U+FEFF'
  Assert-Equal '1: abc' $r.json.result.text 'view text'
}

# -- 5. plain UTF-8 must not gain a BOM ------------------------------------
Assert-Case 'bom/not-added-to-plain-utf8' {
  $p = Join-Path $sandbox 'bom\plain.txt'
  Invoke-Os @('file', 'create', $p, 'abc', 'utf-8', '--allow') | Out-Null
  Assert-Equal '616263' (Get-Hex $p) 'bytes'
  Assert-Equal $false (Invoke-Os @('file', 'charset', $p)).json.result.bom 'bom flag'
}

# -- 6. CRLF is detected and preserved across append -----------------------
Assert-Case 'eol/crlf-preserved-on-append' {
  $p = Join-Path $sandbox 'eol\crlf.txt'
  Invoke-Os @('file', 'create', $p, "x`ny", 'utf-8', '--eol', 'crlf', '--allow') | Out-Null
  Assert-Equal '780d0a79' (Get-Hex $p) 'bytes after create'
  Invoke-Os @('file', 'append', $p, "`nz", '--allow') | Out-Null
  Assert-Equal '780d0a790d0a7a' (Get-Hex $p) 'bytes after append'
  Assert-Equal 'crlf' (Invoke-Os @('file', 'information', $p)).json.result.eol 'eol'
}

# -- 7. LF file stays LF ---------------------------------------------------
Assert-Case 'eol/lf-preserved' {
  $p = Join-Path $sandbox 'eol\lf.txt'
  Invoke-Os @('file', 'create', $p, "x`ny", 'utf-8', '--allow') | Out-Null
  Assert-Equal '780a79' (Get-Hex $p) 'bytes'
  Invoke-Os @('file', 'append', $p, "`nz", '--allow') | Out-Null
  Assert-Equal '780a790a7a' (Get-Hex $p) 'bytes after append'
}

# -- 8. GBK detection and a lossless round trip ---------------------------
Assert-Case 'charset/gbk-detect-and-roundtrip' {
  $p = Join-Path $sandbox 'gbk\cn.txt'
  $original = 'd6d0cec4b2e2cad4'
  $utf8Hex = 'e4b8ade69687e6b58be8af95'
  Write-Bytes $p ([System.Text.Encoding]::GetEncoding(936).GetBytes($CN))
  Assert-Equal $original (Get-Hex $p) 'fixture must hold GBK bytes'
  Assert-Equal 'gbk' (Invoke-Os @('file', 'charset', $p)).json.result.charset 'detected charset'
  Assert-Equal ("1: " + $CN) (Invoke-Os @('file', 'view', $p)).json.result.text 'decoded text'
  Invoke-Os @('file', 'encode', $p, 'utf-8', '--allow') | Out-Null
  Assert-Equal $utf8Hex (Get-Hex $p) 'utf-8 bytes'
  Invoke-Os @('file', 'encode', $p, 'gbk', '--allow') | Out-Null
  Assert-Equal $original (Get-Hex $p) 'round trip must be byte-identical'
}

# -- 9. BOM policy on conversion ------------------------------------------
Assert-Case 'charset/bom-policy-on-convert' {
  $p = Join-Path $sandbox 'conv\b16.txt'
  Invoke-Os @('file', 'create', $p, 'abc', 'utf-8-bom', '--allow') | Out-Null
  Invoke-Os @('file', 'encode', $p, 'utf-16le', '--allow') | Out-Null
  Assert-Equal 'fffe610062006300' (Get-Hex $p) 'utf-16le with kept BOM'
  Invoke-Os @('file', 'encode', $p, 'utf-8-bom', '--allow') | Out-Null
  Assert-Equal 'efbbbf616263' (Get-Hex $p) 'back to utf-8 with BOM'

  $q = Join-Path $sandbox 'conv\plain16.txt'
  Invoke-Os @('file', 'create', $q, 'abc', 'utf-8', '--allow') | Out-Null
  Invoke-Os @('file', 'encode', $q, 'utf-16le', '--allow') | Out-Null
  Assert-Equal '610062006300' (Get-Hex $q) 'no-BOM source stays BOM-less'

  $r = Invoke-Os @('file', 'encode', (Join-Path $sandbox 'conv\b16.txt'), 'latin1', '--bom', 'add', '--allow')
  Assert-Equal 'E_BOM_INVALID' $r.json.error.code 'latin1 has no BOM to add'
}

# -- 10. byte offset boundaries -------------------------------------------
Assert-Case 'offset/character-boundary-enforced' {
  $p = Join-Path $sandbox 'offset\cn.txt'
  # U+4E2D is 3 bytes in UTF-8: e4b8ad
  Invoke-Os @('file', 'create', $p, ($CN.Substring(0, 1) + 'abc'), 'utf-8', '--allow') | Out-Null
  Assert-Equal 'e4b8ad616263' (Get-Hex $p) 'fixture bytes'
  $bad = Invoke-Os @('file', 'insert', $p, 'X', '1', '--allow')
  Assert-Equal 2 $bad.exit 'exit code for a mid-character offset'
  Assert-Equal 'E_BOUNDARY' $bad.json.error.code 'error code'
  Assert-Equal 'e4b8ad616263' (Get-Hex $p) 'file must be untouched'
  Assert-Equal 0 (Invoke-Os @('file', 'insert', $p, 'X', '3', '--allow')).exit 'boundary offset accepted'
  Assert-Equal 'e4b8ad58616263' (Get-Hex $p) 'X spliced after the first character'
  # --charset is an assertion, not an instruction, and must not shift the offset argument.
  Assert-Equal 'E_CHARSET_MISMATCH' (Invoke-Os @('file', 'insert', $p, 'Y', '3', '--charset', 'gbk', '--allow')).json.error.code 'charset assertion'
  Assert-Equal 0 (Invoke-Os @('file', 'insert', $p, 'Y', '3', '--charset', 'utf-8', '--allow')).exit 'matching charset assertion'
  Assert-Equal 'e4b8ad5958616263' (Get-Hex $p) 'Y spliced at the same offset'
}

# -- 11. create never overwrites ------------------------------------------
Assert-Case 'create/exists-fails-without-touching' {
  $p = Join-Path $sandbox 'exists\f.txt'
  Invoke-Os @('file', 'create', $p, 'first', 'utf-8', '--allow') | Out-Null
  $before = Get-Hex $p
  $r = Invoke-Os @('file', 'create', $p, 'second', 'utf-8', '--allow')
  Assert-Equal 5 $r.exit 'exit code'
  Assert-Equal 'E_EXISTS' $r.json.error.code 'error code'
  Assert-Equal $before (Get-Hex $p) 'content must be unchanged'
}

# -- 12. permission gate --------------------------------------------------
Assert-Case 'permission/mutating-verbs-require-allow' {
  $p = Join-Path $sandbox 'perm\f.txt'
  $r = Invoke-Os @('file', 'create', $p, 'x', 'utf-8')
  Assert-Equal 3 $r.exit 'exit code'
  Assert-Equal 'E_PERMISSION' $r.json.error.code 'error code'
  Assert-True (-not (Test-Path -LiteralPath $p)) 'no side effect may happen'
}

Assert-Case 'permission/read-only-verbs-never-require-allow' {
  $p = Join-Path $sandbox 'perm\ro.txt'
  Invoke-Os @('file', 'create', $p, 'x', 'utf-8', '--allow') | Out-Null
  $cases = @(
    @('file', 'charset', $p),
    @('file', 'length', $p),
    @('file', 'information', $p),
    @('file', 'view', $p),
    @('file', 'list', (Join-Path $sandbox 'perm'))
  )
  foreach ($argv in $cases) {
    $r = Invoke-Os $argv
    Assert-Equal 0 $r.exit ("read-only verb " + ($argv[0..1] -join ' ') + " -> " + $r.raw)
  }
}

# -- 13. typed errors for guards -----------------------------------------
Assert-Case 'errors/typed-codes' {
  $dir = Join-Path $sandbox 'errors'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $bin = Join-Path $dir 'bin.dat'
  Write-Bytes $bin ([byte[]](1, 2, 0, 3, 4))

  Assert-Equal 'E_BINARY_CONTENT' (Invoke-Os @('file', 'charset', $bin)).json.error.code 'binary content'
  Assert-Equal 'E_NOT_A_FILE' (Invoke-Os @('file', 'charset', $dir)).json.error.code 'directory used as a file'
  Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('file', 'view', (Join-Path $dir 'nope.txt'))).json.error.code 'missing path'
  Assert-Equal 'E_NOT_A_DIR' (Invoke-Os @('file', 'list', $bin)).json.error.code 'file used as a directory'
  Assert-Equal 'E_CHARSET_UNKNOWN' (Invoke-Os @('file', 'encode', $bin, 'no-such-charset', '--allow')).json.error.code 'unknown charset'
  Assert-Equal 'E_USAGE' (Invoke-Os @('file', 'create')).json.error.code 'missing arguments'
  Assert-Equal 'E_USAGE' (Invoke-Os @('file', 'charset')).json.error.code 'missing path'
  Assert-Equal 'E_USAGE' (Invoke-Os @('file', 'charset', $bin, '--nonsense-flag')).json.error.code 'unknown flag'
}

# -- 14. charset assertion -------------------------------------------------
Assert-Case 'charset/assertion-mismatch' {
  $p = Join-Path $sandbox 'assert\f.txt'
  Invoke-Os @('file', 'create', $p, 'abc', 'utf-8', '--allow') | Out-Null
  Assert-Equal 'E_CHARSET_MISMATCH' (Invoke-Os @('file', 'view', $p, 'gbk')).json.error.code 'assertion mismatch'
  Assert-Equal 0 (Invoke-Os @('file', 'view', $p, 'utf-8')).exit 'matching assertion'
}

# -- 15. view byte range ---------------------------------------------------
Assert-Case 'view/byte-range' {
  $p = Join-Path $sandbox 'range\f.txt'
  Invoke-Os @('file', 'create', $p, 'abcdef', 'utf-8', '--allow') | Out-Null
  $r = Invoke-Os @('file', 'view', $p, 'utf-8', '1', '4')
  Assert-Equal '1: bcd' $r.json.result.text 'sliced text'
  Assert-Equal 1 $r.json.result.start 'start'
  Assert-Equal 4 $r.json.result.end 'end'
}

# -- 16. length and list ---------------------------------------------------
Assert-Case 'length-and-list' {
  $d = Join-Path $sandbox 'len'
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  Write-Bytes (Join-Path $d 'a.txt') ([byte[]](1, 2, 3))
  Write-Bytes (Join-Path $d 'b.txt') ([byte[]](4, 5))
  $r = Invoke-Os @('file', 'length', $d)
  Assert-Equal 5 $r.json.result.bytes 'recursive bytes'
  Assert-Equal 2 $r.json.result.files 'file count'
  Assert-Equal 2 (Invoke-Os @('file', 'list', $d)).json.result.count 'entry count'
}

# -- 17. move / copy / mkdir ----------------------------------------------
Assert-Case 'move-copy-mkdir' {
  $d = Join-Path $sandbox 'mv'
  $src = Join-Path $d 'src.txt'
  Write-Bytes $src ([byte[]](0x41, 0x42))
  $dst = Join-Path $d 'moved.txt'
  Assert-Equal 0 (Invoke-Os @('file', 'move', $src, $dst, '--allow')).exit 'move'
  Assert-True (-not (Test-Path -LiteralPath $src)) 'source gone'
  Assert-True (Test-Path -LiteralPath $dst) 'destination present'
  Assert-Equal 'E_EXISTS' (Invoke-Os @('file', 'move', $dst, $dst, '--allow')).json.error.code 'move onto an existing target'
  $copy = Join-Path $d 'copy.txt'
  Assert-Equal 0 (Invoke-Os @('file', 'copy', $dst, $copy, '--allow')).exit 'copy'
  Assert-Equal (Get-Hex $dst) (Get-Hex $copy) 'copy content'
  $deep = Join-Path $d 'x\y\z'
  Assert-Equal 'E_NO_PARENT' (Invoke-Os @('file', 'mkdir', $deep, '--allow')).json.error.code 'missing parents'
  Assert-Equal 0 (Invoke-Os @('file', 'mkdir', $deep, '--parents', '--allow')).exit 'mkdir --parents'
  Assert-True (Test-Path -LiteralPath $deep) 'directory created'
}

# -- 18. delete recycles by default ---------------------------------------
Assert-Case 'delete/default-is-recycle' {
  $p = Join-Path $sandbox 'del\f.txt'
  Write-Bytes $p ([byte[]](0x41))
  $r = Invoke-Os @('file', 'delete', $p, '--allow')
  Assert-Equal 0 $r.exit 'delete exit'
  Assert-Equal 'recycle' $r.json.result.operation 'operation'
  Assert-True (-not (Test-Path -LiteralPath $p)) 'file removed from its path'
}

# -- 19. execute passes argv without a shell ------------------------------
Assert-Case 'execute/argv-not-shell' {
  $r = Invoke-Os @('execute', 'command', 'cmd.exe', '/c', 'echo', 'a b c')
  if ($r.exit -ne 0 -and $r.json.error.code -eq 'E_NOT_SUPPORTED') { return }
  Assert-Equal 0 $r.exit ('execute exit: ' + $r.raw)
}

# -- 20. envelopes are always parseable JSON ------------------------------
Assert-Case 'envelope/always-json' {
  $cases = @(
    @('file', 'view', (Join-Path $sandbox 'nope.txt')),
    @('file', 'create'),
    @('bogus', 'verb'),
    @('file', 'charset', 'a"b')
  )
  foreach ($argv in $cases) {
    $r = Invoke-Os $argv
    Assert-True ($null -ne $r.json) ("envelope must parse for: " + ($argv -join ' '))
    Assert-True ($null -ne $r.json.ok) 'ok field present'
    Assert-True ($null -ne $r.json.meta) 'meta field present'
  }
}

# -- 21. selfcheck lists the whole verb table -----------------------------
Assert-Case 'selfcheck/verb-table' {
  $r = Invoke-Os @('selfcheck')
  Assert-Equal 0 $r.exit 'exit'
  Assert-True ($r.json.result.verbCount -ge 46) 'verb count'
  Assert-Equal 'win32' $r.json.result.capabilities.platform 'platform'
}

# -- 22. stdout is UTF-8 without a BOM ------------------------------------
Assert-Case 'stdout/no-bom-and-valid-utf8' {
  $p = Join-Path $sandbox 'stdout\cn.txt'
  Invoke-Os @('file', 'create', $p, $CN, 'utf-8', '--allow') | Out-Null
  $stdout = & $pwshExe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ps1 @('file', 'view', $p) 2>$null
  $r = Invoke-Os @('file', 'view', $p)
  # A leading U+FEFF here would be a leaked preamble; a U+FFFD would be a decoding failure.
  Assert-True (-not $r.json.result.text.Contains([char]0xFFFD)) 'no replacement character in the decoded text'
  Assert-True ($r.raw.StartsWith('{')) 'stdout must start with the envelope'
}

# -- 23. the authorization file cannot be modified by any verb -----------------
# This is the load-bearing security property: authorization changes may only come from a
# user-accepted dialog in the consent delegate, never from a scripted call.
Assert-Case 'permission/protected-path-cannot-be-modified' {
  $protected = Join-Path $rootDir 'permission.json'
  $before = if (Test-Path -LiteralPath $protected) { Get-Hex $protected } else { '<absent>' }
  $attempts = @(
    @('file', 'delete', $protected, '--allow'),
    @('file', 'create', $protected, '{}', 'utf-8', '--allow'),
    @('file', 'append', $protected, 'x', '--allow'),
    @('file', 'insert', $protected, 'x', '0', '--allow'),
    @('file', 'encode', $protected, 'utf-8', '--allow'),
    @('file', 'move', $protected, (Join-Path $sandbox 'stolen.json'), '--allow'),
    @('file', 'copy', $protected, (Join-Path $sandbox 'leak.json'), '--allow'),
    @('file', 'move', (Join-Path $rootDir 'src\host\bin\dsh-os.ps1'), (Join-Path $sandbox 'stolen.ps1'), '--allow'),
    @('file', 'delete', (Join-Path $rootDir 'src\host\spec\verbs.tsv'), '--allow')
  )
  foreach ($argv in $attempts) {
    $r = Invoke-Os $argv
    Assert-Equal 3 $r.exit ("exit class for: " + ($argv -join ' '))
    Assert-Equal 'E_PERMISSION_PROTECTED_PATH' $r.json.error.code ("code for: " + ($argv -join ' '))
  }
  $after = if (Test-Path -LiteralPath $protected) { Get-Hex $protected } else { '<absent>' }
  Assert-Equal $before $after 'the authorization file must be byte-identical afterwards'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $sandbox 'stolen.json'))) 'no move may leak it'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $sandbox 'leak.json'))) 'no copy may leak it'
  # Reading it must still work, otherwise the rules could not be inspected at all.
  Assert-Equal 0 (Invoke-Os @('permission', 'list')).exit 'permission list stays readable'
}

Assert-Case 'permission/protected-path-evasion-attempts' {
  $root = $rootDir
  $evasions = @(
    (Join-Path $root '.\permission.json'),
    (Join-Path $root 'sub\..\permission.json'),
    (Join-Path $root 'PERMISSION.JSON'),
    (Join-Path $root 'permission.json.'),
    (Join-Path $root 'permission.json.tmp')
  )
  foreach ($path in $evasions) {
    $r = Invoke-Os @('file', 'delete', $path, '--allow')
    Assert-Equal 'E_PERMISSION_PROTECTED_PATH' $r.json.error.code ("evasion must fail: " + $path)
  }
}

# -- 24. file verify ----------------------------------------------------------
Assert-Case 'file-verify/charset-encoding-completion' {
  $p = Join-Path $sandbox 'verify\f.txt'
  Invoke-Os @('file', 'create', $p, "abc`ndef", 'utf-8', '--allow') | Out-Null
  $size = (Get-Item -LiteralPath $p).Length

  $r = Invoke-Os @('file', 'verify', 'charset', $p, 'utf-8')
  Assert-Equal $true $r.json.result.match 'charset match'
  $r2 = Invoke-Os @('file', 'verify', 'charset', $p, 'gbk')
  Assert-Equal $false $r2.json.result.match 'charset mismatch is reported, not thrown'
  Assert-Equal 'utf-8' $r2.json.result.observed 'observed charset'

  $r3 = Invoke-Os @('file', 'verify', 'encoding', $p, 'utf-8')
  Assert-Equal $true $r3.json.result.legal 'utf-8 bytes are legal'
  Assert-Equal 0 $r3.json.result.replacementChars 'no replacement characters'

  # A GBK byte pair is not valid UTF-8, so the round trip must fail.
  $q = Join-Path $sandbox 'verify\gbk.bin'
  Write-Bytes $q ([System.Text.Encoding]::GetEncoding(936).GetBytes($CN))
  $r4 = Invoke-Os @('file', 'verify', 'encoding', $q, 'utf-8')
  Assert-Equal $false $r4.json.result.legal 'GBK bytes are not legal utf-8'
  Assert-Equal $true (Invoke-Os @('file', 'verify', 'encoding', $q, 'gbk')).json.result.legal 'GBK bytes are legal gbk'

  $r5 = Invoke-Os @('file', 'verify', 'completion', $p, '--length', "$size")
  Assert-Equal $true $r5.json.result.complete 'length assertion passes'
  $r6 = Invoke-Os @('file', 'verify', 'completion', $p, '--length', '999999')
  Assert-Equal $false $r6.json.result.complete 'wrong length is reported'
  $r7 = Invoke-Os @('file', 'verify', 'completion', $p)
  Assert-Equal $false $r7.json.result.asserted 'no expectation means no assertion'
}

# -- 25. system queries never fail the whole answer ---------------------------
Assert-Case 'system/queries-degrade-per-field' {
  $brand = Invoke-Os @('system', 'brand')
  Assert-Equal 0 $brand.exit 'brand exit'
  Assert-Equal 'windows' $brand.json.result.platform 'brand platform'
  Assert-Equal 0 (Invoke-Os @('system', 'cpu')).exit 'cpu exit'
  Assert-Equal 0 (Invoke-Os @('system', 'version')).exit 'version exit'
  # A machine without a GPU driver legitimately reports an empty adapter list.
  $gpu = Invoke-Os @('system', 'gpu')
  Assert-Equal 0 $gpu.exit 'gpu exit'
  Assert-True ($null -ne $gpu.json.result.adapters) 'gpu adapters key present'
  Assert-Equal 0 (Invoke-Os @('system', 'info')).exit 'info exit'
}

# -- 26. task and environment queries ----------------------------------------
Assert-Case 'task/list-and-query' {
  $list = Invoke-Os @('task', 'list', '--limit', '5')
  Assert-Equal 0 $list.exit 'task list exit'
  Assert-True ($list.json.result.count -ge 1) 'at least one process'
  Assert-True ($list.json.result.count -le 5) 'limit respected'
  $mine = Invoke-Os @('task', 'query', "$PID")
  Assert-Equal 0 $mine.exit 'task query exit'
  Assert-Equal $PID $mine.json.result.pid 'queried our own pid'
  Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('task', 'query', '999999')).json.error.code 'absent pid'
}

Assert-Case 'environment/scoped-queries' {
  $list = Invoke-Os @('environment', 'list', '--scope', 'process')
  Assert-Equal 0 $list.exit 'environment list exit'
  Assert-Equal 'process' $list.json.result.scope 'scope echoed back'
  Assert-Equal 0 (Invoke-Os @('environment', 'get', 'PATH', '--scope', 'process')).exit 'environment get exit'
  $attr = Invoke-Os @('environment', 'attr', 'get', 'PATH', '--scope', 'process')
  Assert-Equal 0 $attr.exit 'attr get exit'
  Assert-True ($attr.json.result.count -ge 1) 'PATH has entries'
  Assert-Equal ';' $attr.json.result.separator 'Windows joins list attributes with a semicolon'
  Assert-Equal 0 $attr.json.result.entries[0].index 'entries are indexed from zero'
  $catalog = Invoke-Os @('environment', 'attr', 'list', '--scope', 'process')
  Assert-Equal 0 $catalog.exit 'attr list exit'
  Assert-True ($catalog.json.result.count -ge 1) 'at least PATH is discoverable as an attribute'
  Assert-Equal 'E_USAGE' (Invoke-Os @('environment', 'list', '--scope', 'nonsense')).json.error.code 'bad scope'
  Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('environment', 'get', 'DSH_OS_NO_SUCH_VAR', '--scope', 'process')).json.error.code 'absent variable'
}

# -- 28. environment variables: the full add/set/delete/get lifecycle ---------
# User scope is the only scope where a change survives between invocations (each invocation is a
# fresh process), so that is what proves persistence. The variable is removed again afterwards.
Assert-Case 'environment/crud-lifecycle-at-user-scope' {
  $var = 'DSH_OS_GOLDEN_LIFECYCLE'
  [System.Environment]::SetEnvironmentVariable($var, $null, 'User')
  try {
    Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('environment', 'get', $var, '--scope', 'user')).json.error.code 'clean start'

    $r = Invoke-Os @('environment', 'add', $var, 'one', '--scope', 'user', '--allow')
    Assert-Equal 0 $r.exit 'add'
    Assert-Equal 'add' $r.json.result.operation 'add operation'
    Assert-Equal $false $r.json.result.visibleToRunningProcesses 'a user-scope write is not visible to running processes'

    # add is create-only, so a second add must refuse rather than silently overwrite.
    Assert-Equal 'E_EXISTS' (Invoke-Os @('environment', 'add', $var, 'two', '--scope', 'user', '--allow')).json.error.code 'second add'

    $s = Invoke-Os @('environment', 'set', $var, 'three', '--scope', 'user', '--allow')
    Assert-Equal 0 $s.exit 'set'
    Assert-Equal 'one' $s.json.result.previous 'set reports the previous value'
    Assert-Equal 'three' (Invoke-Os @('environment', 'get', $var, '--scope', 'user')).json.result.value 'value after set'

    # set is update-only, so it must not create.
    Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('environment', 'set', 'DSH_OS_GOLDEN_ABSENT', 'x', '--scope', 'user', '--allow')).json.error.code 'set on an absent variable'

    $d = Invoke-Os @('environment', 'delete', $var, '--scope', 'user', '--allow')
    Assert-Equal 0 $d.exit 'delete'
    Assert-Equal 'three' $d.json.result.previous 'delete reports what it removed'
    Assert-Equal 'E_NOT_FOUND' (Invoke-Os @('environment', 'get', $var, '--scope', 'user')).json.error.code 'gone after delete'

    # Writing without authorization must leave no trace at all.
    Assert-Equal 'E_PERMISSION' (Invoke-Os @('environment', 'add', $var, 'x', '--scope', 'user')).json.error.code 'no --allow'
    Assert-Equal $null ([System.Environment]::GetEnvironmentVariable($var, 'User')) 'no side effect without --allow'
  } finally {
    [System.Environment]::SetEnvironmentVariable($var, $null, 'User')
  }
}

# -- 29. environment attributes: the same five operations over a list ---------
Assert-Case 'environment/attribute-crud-lifecycle' {
  $var = 'DSH_OS_GOLDEN_ATTR'
  $sep = ';'
  $original = [System.Environment]::GetEnvironmentVariable($var, 'Process')
  # Each Invoke-Os call is a fresh child process. A child inherits the parent's real environment
  # block, and only SetEnvironmentVariable(..., 'Process') writes that block; assigning $env:NAME
  # updates the provider view but not the block the child receives. Getting this wrong makes the
  # fixture invisible and every count assertion misleading, so it is written explicitly.
  [System.Environment]::SetEnvironmentVariable($var, ('a' + $sep + 'b' + $sep + 'c'), 'Process')
  try {
    $g = Invoke-Os @('environment', 'attr', 'get', $var, '--attr', $var, '--scope', 'process')
    Assert-Equal 0 $g.exit 'attr get'
    Assert-Equal 3 $g.json.result.count 'three entries'
    Assert-Equal 'a' $g.json.result.entries[0].value 'entry order is preserved'
    Assert-Equal 1 $g.json.result.entries[1].index 'entries carry their index'

    # The unique-entry rule needs state that persists between invocations, so it is checked at user
    # scope where each call observes the previous call's write.
    $uvar = 'DSH_OS_GOLDEN_ATTR_USER'
    [System.Environment]::SetEnvironmentVariable($uvar, $null, 'User')
    try {
      Assert-Equal 0 (Invoke-Os @('environment', 'attr', 'add', $uvar, 'd', '--attr', $uvar, '--scope', 'user', '--allow')).exit 'first add at user scope'
      Assert-Equal 'E_EXISTS' (Assert-OsError (Invoke-Os @('environment', 'attr', 'add', $uvar, 'd', '--attr', $uvar, '--scope', 'user', '--allow'))).code 'a duplicate entry is refused'
      Assert-Equal 1 (Invoke-Os @('environment', 'attr', 'get', $uvar, '--attr', $uvar, '--scope', 'user')).json.result.count 'the first add is visible to the next invocation'
    } finally {
      [System.Environment]::SetEnvironmentVariable($uvar, $null, 'User')
    }

    $s = Invoke-Os @('environment', 'attr', 'set', $var, '1', 'B', '--attr', $var, '--scope', 'process', '--allow')
    Assert-Equal 0 $s.exit ('attr set: ' + $s.raw)
    Assert-Equal 'b' $s.json.result.previous 'attr set reports the replaced entry'

    $afterSet = Invoke-Os @('environment', 'attr', 'get', $var, '--attr', $var, '--scope', 'process')
    Assert-Equal 'B' $afterSet.json.result.entries[1].value 'replacement took effect in the child that wrote it'

    Assert-Equal 'E_RANGE' (Assert-OsError (Invoke-Os @('environment', 'attr', 'set', $var, '99', 'x', '--attr', $var, '--scope', 'process', '--allow'))).code 'index out of range'

    $d = Invoke-Os @('environment', 'attr', 'delete', $var, '--index', '0', '--attr', $var, '--scope', 'process', '--allow')
    Assert-Equal 0 $d.exit 'attr delete by index'
    Assert-Equal 'a' $d.json.result.removed 'reports the removed entry'
    Assert-Equal 2 $d.json.result.count 'the child started from the three-entry fixture'

    $dv = Invoke-Os @('environment', 'attr', 'delete', $var, '--value', 'c', '--attr', $var, '--scope', 'process', '--allow')
    Assert-Equal 0 $dv.exit 'attr delete by value'
    Assert-Equal 'c' $dv.json.result.removed 'removed by value'
    Assert-Equal 'E_NOT_FOUND' (Assert-OsError (Invoke-Os @('environment', 'attr', 'delete', $var, '--value', 'zzz', '--attr', $var, '--scope', 'process', '--allow'))).code 'absent value'
    Assert-Equal 'E_USAGE' (Assert-OsError (Invoke-Os @('environment', 'attr', 'delete', $var, '--attr', $var, '--scope', 'process', '--allow'))).code 'neither index nor value'
  } finally {
    if ($null -eq $original) {
      [System.Environment]::SetEnvironmentVariable($var, $null, 'Process')
    } else {
      [System.Environment]::SetEnvironmentVariable($var, $original, 'Process')
    }
  }
}

# -- 27. the verb parser handles one, two and three token verbs ---------------
Assert-Case 'parser/one-two-three-token-verbs' {
  Assert-Equal 0 (Invoke-Os @('selfcheck')).exit 'one token'
  Assert-Equal 0 (Invoke-Os @('file', 'length', (Join-Path $sandbox 'verify'))).exit 'two tokens'
  Assert-Equal 0 (Invoke-Os @('file', 'verify', 'charset', (Join-Path $sandbox 'verify\f.txt'), 'utf-8')).exit 'three tokens'
  Assert-Equal 0 (Invoke-Os @('environment', 'attr', 'list', '--scope', 'process')).exit 'three tokens in another group'
  # A path argument that happens to start with a word must not be eaten as part of the verb.
  $dirCase = Invoke-Os @('file', 'charset', (Join-Path $sandbox 'verify'))
  Assert-Equal 'file.charset' $dirCase.json.verb 'path stays a path argument'
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("passed: " + $script:Passed + "   failed: " + $script:Failed) -ForegroundColor Cyan
if ($script:Failed -gt 0) {
  Write-Host 'failures:' -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host ("  - " + $f.name + ": " + $f.error) -ForegroundColor Red }
}

if (-not $KeepSandbox -and (Test-Path -LiteralPath $sandbox)) {
  Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:Failed -gt 0) { exit 1 }
exit 0
