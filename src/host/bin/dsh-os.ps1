#requires -version 5.1
<#
  dsh-os.ps1 - Windows implementation of the dsh-os atomic command surface.

  Contract: command.txt (authoritative), docs/os-spec.md (full spec), spec/verbs.tsv (verb table),
            spec/charsets.tsv (charset table).

  Design rules honoured here:
    * Values arrive as separate argv elements. This script never re-parses a command line and never
      assembles one; arguments come from $args, which PowerShell populates without a shell layer.
    * File content is only ever read through [System.IO.File]::ReadAllBytes and written through
      [System.IO.File]::WriteAllBytes with an explicit Encoding object, so BOM and EOL handling is
      deliberate. Get-Content/Set-Content are never used for file content.
    * stdout carries exactly one UTF-8 (no BOM) JSON envelope. stderr carries human diagnostics only.
    * Read-only verbs never require --allow; mutating verbs do.
    * Native calls use Add-Type P/Invoke only - no koffi, no third-party module.

  SAVE THIS FILE AS UTF-8 WITH BOM. Without the BOM, Windows PowerShell 5.1 decodes it as ANSI and
  mangles the non-ASCII literals inside it.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Console encoding: pin UTF-8 without BOM on every stream before anything else.
# ---------------------------------------------------------------------------
$script:NoBom = New-Object System.Text.UTF8Encoding($false)
$script:BomUtf8 = New-Object System.Text.UTF8Encoding($true)
try {
  [Console]::InputEncoding = $script:NoBom
  [Console]::OutputEncoding = $script:NoBom
  $OutputEncoding = $script:NoBom
} catch {
  # A redirected/hostless console can refuse these; the envelopes below still write raw UTF-8 bytes.
}

# Layout: <repo>/src/host/bin/dsh-os.ps1
#   HostDir = <repo>/src/host   - spec tables, command.txt, the other entry points
#   RepoDir = <repo>            - permission.json and the protected-path boundary
#
# The repository root is located by walking upward for a marker rather than by counting ".."
# levels from $MyInvocation. When this script is launched as a child process with -File, that path
# is RELATIVE to the caller's working directory ("src\host\bin\dsh-os.ps1"), so Split-Path walks up
# from the CWD and silently produces a wrong root. That failure is invisible at runtime and
# disarmed the protected-path guard completely, so the marker search is the load-bearing part.
function Find-RepoDir {
  param([string]$StartDir)
  $dir = $StartDir
  for ($i = 0; $i -lt 8 -and $dir; $i++) {
    # A directory holding a package.json and src/host is the project root.
    if ((Test-Path -LiteralPath (Join-Path $dir 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $dir 'src\host'))) {
      return $dir
    }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  # Fall back to the historical two-level assumption so a relocated script still runs.
  return (Split-Path -Parent (Split-Path -Parent $StartDir))
}

$script:ScriptPath = $MyInvocation.MyCommand.Path
if (-not [System.IO.Path]::IsPathRooted($script:ScriptPath)) {
  $script:ScriptPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $script:ScriptPath))
}
$script:ScriptDir = Split-Path -Parent $script:ScriptPath
$script:HostDir = Split-Path -Parent $script:ScriptDir
$script:RepoDir = Find-RepoDir -StartDir $script:ScriptDir
# RootDir is the repository root: it is where permission.json lives, so it must never be derived by
# counting levels alone.
$script:RootDir = $script:RepoDir

# ---------------------------------------------------------------------------
# Error model. Every failure is an OsError; exit codes are a coarse class and
# error.code is authoritative (callers must branch on the code, never the message).
# ---------------------------------------------------------------------------
$script:ExitByCode = @{
  E_USAGE = 1; E_TYPE = 2; E_PERMISSION = 3
  E_NOT_SUPPORTED = 4; E_ACCESSIBILITY_DENIED = 4; E_ACCESSIBILITY_UNAVAILABLE = 4; E_NO_DISPLAY = 4
  E_ELEVATION_REQUIRED = 3
  E_NOT_FOUND = 5; E_NOT_A_FILE = 5; E_NOT_A_DIR = 5; E_IS_A_DIR = 5; E_EXISTS = 5
  E_NO_PARENT = 5; E_CHARSET_UNKNOWN = 2; E_CHARSET_MISMATCH = 5; E_ENCODING_INVALID = 5
  E_BOM_INVALID = 5; E_BINARY_CONTENT = 5; E_NOT_TEXT = 5; E_BOUNDARY = 2; E_RANGE = 2
  E_TRUNCATED = 5; E_PARTIAL_WRITE = 5; E_WINDOW_NOT_FOUND = 5; E_WINDOW_AMBIGUOUS = 2
  E_WINDOW_CLOSED = 5; E_IO = 5; E_TIMEOUT = 6; E_ABORTED = 7; E_INTERNAL = 7
  # Authorization-layer codes share exit class 3 so a caller can treat every authorization refusal
  # uniformly, while error.code still says exactly which rule applied.
  E_PERMISSION_DENIED_BY_RULE = 3; E_PERMISSION_PROTECTED_PATH = 3; E_PERMISSION_DELEGATE_ONLY = 3
  E_PERMISSION_FILE_UNTRUSTED = 3; E_PERMISSION_NO_ANSWERER = 3
}

function New-OsError {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Hint
  )
  $e = New-Object System.Exception($Message)
  $e | Add-Member -NotePropertyName OsCode -NotePropertyValue $Code -Force
  $e | Add-Member -NotePropertyName Hint -NotePropertyValue $Hint -Force
  return $e
}

function Get-ErrorCode {
  param($ErrorRecord)
  $ex = $ErrorRecord
  if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ex = $ErrorRecord.Exception }
  if ($null -ne $ex -and $null -ne $ex.PSObject.Properties['OsCode']) { return [string]$ex.OsCode }
  return 'E_INTERNAL'
}

function Get-ErrorHint {
  param($ErrorRecord)
  $ex = $ErrorRecord
  if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ex = $ErrorRecord.Exception }
  if ($null -ne $ex -and $null -ne $ex.PSObject.Properties['Hint']) { return [string]$ex.Hint }
  return $null
}

function Get-ExitCode {
  param([string]$Code)
  if ($script:ExitByCode.ContainsKey($Code)) { return [int]$script:ExitByCode[$Code] }
  return 7
}

# ---------------------------------------------------------------------------
# JSON. ConvertTo-Json in PowerShell 5.1 emits \uXXXX only for some control
# characters and is depth-limited, so the envelope is serialised by hand.
# ---------------------------------------------------------------------------
function ConvertTo-JsonString {
  param([string]$Value)
  if ($null -eq $Value) { return 'null' }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $Value.ToCharArray()) {
    $c = [int][char]$ch
    switch ($ch) {
      '"' { [void]$sb.Append('\"'); continue }
      '\' { [void]$sb.Append('\\'); continue }
      "`b" { [void]$sb.Append('\b'); continue }
      "`f" { [void]$sb.Append('\f'); continue }
      "`n" { [void]$sb.Append('\n'); continue }
      "`r" { [void]$sb.Append('\r'); continue }
      "`t" { [void]$sb.Append('\t'); continue }
      default {
        if ($c -lt 0x20 -or $c -eq 0x7F) { [void]$sb.Append('\u' + $c.ToString('x4')) }
        elseif ($c -eq 0xFFFE -or $c -eq 0xFFFF) { [void]$sb.Append('\u' + $c.ToString('x4')) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ConvertTo-JsonValue {
  param($Value, [int]$Depth = 0)
  if ($null -eq $Value) { return 'null' }
  if ($Depth -gt 24) { return '"<max-depth>"' }
  if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
  if ($Value -is [string]) { return (ConvertTo-JsonString -Value $Value) }
  if ($Value -is [char]) { return (ConvertTo-JsonString -Value ([string]$Value)) }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte]) { return ([string]$Value) }
  if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) {
    $d = [double]$Value
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }
    return $d.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($k in $Value.Keys) {
      [void]$parts.Add((ConvertTo-JsonString -Value ([string]$k)) + ':' + (ConvertTo-JsonValue -Value $Value[$k] -Depth ($Depth + 1)))
    }
    return '{' + ($parts -join ',') + '}'
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $parts = New-Object System.Collections.ArrayList
    foreach ($item in $Value) { [void]$parts.Add((ConvertTo-JsonValue -Value $item -Depth ($Depth + 1))) }
    return '[' + ($parts -join ',') + ']'
  }
  $ordered = [ordered]@{}
  foreach ($p in $Value.PSObject.Properties) { $ordered[$p.Name] = $p.Value }
  return (ConvertTo-JsonValue -Value $ordered -Depth ($Depth + 1))
}

function ConvertTo-PrettyJson {
  param([string]$Json)
  # Cheap structural indenter for --pretty. Deliberately does not touch string contents.
  $sb = New-Object System.Text.StringBuilder
  $indent = 0
  $inString = $false
  $escaped = $false
  for ($i = 0; $i -lt $Json.Length; $i++) {
    $ch = $Json[$i]
    if ($inString) {
      [void]$sb.Append($ch)
      if ($escaped) { $escaped = $false }
      elseif ($ch -eq '\') { $escaped = $true }
      elseif ($ch -eq '"') { $inString = $false }
      continue
    }
    switch ($ch) {
      '"' { $inString = $true; [void]$sb.Append($ch) }
      '{' { [void]$sb.Append($ch); $indent++; [void]$sb.Append("`n" + ('  ' * $indent)) }
      '[' { [void]$sb.Append($ch); $indent++; [void]$sb.Append("`n" + ('  ' * $indent)) }
      '}' { $indent--; [void]$sb.Append("`n" + ('  ' * $indent) + $ch) }
      ']' { $indent--; [void]$sb.Append("`n" + ('  ' * $indent) + $ch) }
      ',' { [void]$sb.Append($ch); [void]$sb.Append("`n" + ('  ' * $indent)) }
      ':' { [void]$sb.Append(': ') }
      ' ' { }
      default { [void]$sb.Append($ch) }
    }
  }
  return $sb.ToString()
}

$script:Envelope = [ordered]@{ ok = $true; verb = $null; result = $null }
$script:Pretty = $false
$script:Quiet = $false

function Write-Envelope {
  param([string]$Verb, $Result, $ErrorObject, [int]$DurationMs)
  $env = [ordered]@{}
  if ($null -eq $ErrorObject) {
    $env['ok'] = $true
  } else {
    $env['ok'] = $false
  }
  $env['verb'] = $Verb
  if ($null -eq $ErrorObject) {
    $env['result'] = $Result
  } else {
    $env['error'] = $ErrorObject
  }
  $env['meta'] = [ordered]@{ durationMs = $DurationMs; platform = 'win32'; shell = 'pwsh' }

  if ($script:Quiet -and $null -eq $ErrorObject) {
    $json = ConvertTo-JsonValue -Value $Result
  } elseif ($script:Quiet -and $null -ne $ErrorObject) {
    $json = ConvertTo-JsonValue -Value $ErrorObject
  } else {
    $json = ConvertTo-JsonValue -Value $env
  }
  if ($script:Pretty -and -not $script:Quiet) { $json = ConvertTo-PrettyJson -Json $json }

  $bytes = $script:NoBom.GetBytes($json + "`n")
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function New-ErrorObject {
  param([string]$Code, [string]$Message, [string]$Hint)
  $o = [ordered]@{ code = $Code; message = $Message }
  if (-not [string]::IsNullOrEmpty($Hint)) { $o['hint'] = $Hint }
  return $o
}

# ---------------------------------------------------------------------------
# Argument parsing.
#   positionals: every token that is not a flag and not a flag value.
#   flags:       --name, or --name value when the name is a known value-taking flag.
# Unknown flags are a usage error so typos cannot silently become positionals.
# ---------------------------------------------------------------------------
$script:ValueFlags = @(
  'encoding', 'eol', 'button', 'count', 'space', 'out', 'screen', 'format',
  'workdir', 'env', 'stdin', 'timeout', 'interval', 'method', 'pid', 'regex',
  'name', 'max-bytes', 'max-chars', 'depth', 'source', 'bom', 'text', 'charset',
  # round 2
  'length', 'sha256', 'limit', 'filter', 'scope', 'index', 'decision', 'delegate', 'args',
  # round 3: environment attributes
  'attr', 'value'
)

# Every accepted flag, value-taking or boolean. Kept next to ValueFlags so a new verb cannot add a
# flag without registering it here; spec/verbs.tsv is the documented counterpart.
$script:KnownFlags = @(
  $script:ValueFlags +
  'allow', 'pretty', 'quiet', 'json', 'backup', 'permanent', 'parents', 'no-recursive',
  'no-numbers', 'force', 'hold', 'clearmodifiers', 'exact', 'absent', 'z-order', 'shell',
  'background'
)

function Parse-Arguments {
  param([string[]]$Argv)
  $positionals = New-Object System.Collections.ArrayList
  $flags = @{}
  $i = 0
  while ($i -lt $Argv.Length) {
    $tok = $Argv[$i]
    if ($tok.Length -ge 2 -and $tok.StartsWith('--')) {
      $name = $tok.Substring(2)
      if ($name -eq '') { throw (New-OsError -Code 'E_USAGE' -Message 'empty flag "--"' ) }
      if (-not ($script:KnownFlags -contains $name)) {
        # A typo such as --alow must not silently become a no-op: it would look like a successful
        # call that did nothing, which is exactly the class of failure this layer exists to remove.
        throw (New-OsError -Code 'E_USAGE' -Message ("unknown flag --{0}" -f $name) `
            -Hint 'run: dsh-os selfcheck   (lists every accepted flag)')
      }
      if ($script:ValueFlags -contains $name) {
        if ($i + 1 -ge $Argv.Length) {
          throw (New-OsError -Code 'E_USAGE' -Message ("flag --{0} requires a value" -f $name))
        }
        $val = $Argv[$i + 1]
        if ($flags.ContainsKey($name)) { $flags[$name] = @($flags[$name]) + $val } else { $flags[$name] = $val }
        $i += 2
      } else {
        $flags[$name] = $true
        $i += 1
      }
    } else {
      [void]$positionals.Add($tok)
      $i += 1
    }
  }
  return @{ positionals = $positionals.ToArray(); flags = $flags }
}

function Get-Positional {
  param($Parsed, [int]$Index, [string]$Name, [switch]$Optional, [string]$Default)
  if ($Index -lt $Parsed.positionals.Length) {
    $v = $Parsed.positionals[$Index]
    if ($v -eq '' -and $Optional) { return $Default }
    return $v
  }
  if ($Optional) { return $Default }
  throw (New-OsError -Code 'E_USAGE' -Message ("missing required argument <{0}>" -f $Name))
}

function Get-FlagValue {
  param($Parsed, [string]$Name, [string]$Default)
  if ($Parsed.flags.ContainsKey($Name)) { return [string]$Parsed.flags[$Name] }
  return $Default
}

function Test-HasFlag {
  param($Parsed, [string]$Name)
  return $Parsed.flags.ContainsKey($Name)
}

function Assert-NoExtra {
  param($Parsed, [int]$Expected)
  if ($Parsed.positionals.Length -gt $Expected) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$Expected]))
  }
}

function Assert-MinPositionals {
  param($Parsed, [int]$Min, [string]$Verb)
  if ($Parsed.positionals.Length -lt $Min) {
    throw (New-OsError -Code 'E_USAGE' -Message ("{0} requires {1} argument(s), got {2}" -f $Verb, $Min, $Parsed.positionals.Length) `
        -Hint 'run: dsh-os selfcheck   (lists every verb with its arguments and flags)')
  }
}

function Assert-Allowed {
  param($Parsed, [string]$Verb, [string]$Perm, [int]$Positionals = -1)
  if ($Perm -ne 'W') { return }
  # Arity is decided before authorization: a malformed call is a usage error, and reporting
  # E_PERMISSION for it would hide the real problem and ask for consent to a call that could not
  # have run anyway.
  if ($Positionals -ge 0 -and $Parsed.positionals.Length -gt $Positionals) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$Positionals]))
  }
  if (-not (Test-HasFlag -Parsed $Parsed -Name 'allow')) {
    throw (New-OsError -Code 'E_PERMISSION' `
        -Message ("{0} is a mutating operation and requires user authorization" -f $Verb) `
        -Hint 're-run with --allow after the user has accepted the requested operation')
  }
}

function Get-IntArg {
  param([string]$Text, [string]$Name, [switch]$AllowNegative)
  $out = 0
  $ok = [int]::TryParse($Text, [ref]$out)
  if (-not $ok) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must be an integer, got '{1}'" -f $Name, $Text))
  }
  if (-not $AllowNegative -and $out -lt 0) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must not be negative, got {1}" -f $Name, $out))
  }
  return $out
}

# ---------------------------------------------------------------------------
# Charset table. spec/charsets.tsv is the single source of truth.
# ---------------------------------------------------------------------------
$script:Charsets = $null

function Get-CharsetTable {
  if ($null -ne $script:Charsets) { return $script:Charsets }
  $path = Join-Path $script:HostDir 'spec\charsets.tsv'
  $table = @{}
  if (Test-Path -LiteralPath $path) {
    $lines = [System.IO.File]::ReadAllLines($path, $script:NoBom)
    foreach ($line in $lines) {
      if ($line -eq '' -or $line.StartsWith('#')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 6 -or $f[0] -eq 'iana') { continue }
      $entry = [ordered]@{
        iana = $f[0]; dotnet = $f[2]; bom = $f[4]; fixed = ($f[5] -eq 'yes')
        aliases = @($f[1] -split '\|')
      }
      $table[$f[0]] = $entry
      foreach ($a in $entry.aliases) { if ($a -ne '-') { $table[$a] = $entry } }
    }
  }
  $script:Charsets = $table
  return $table
}

function Resolve-Charset {
  param([string]$Name, [switch]$Bom)
  if ([string]::IsNullOrEmpty($Name)) { $Name = 'utf-8' }
  $key = $Name.ToLowerInvariant()
  if ($Bom -and $key -eq 'utf-8') { $key = 'utf-8-bom' }
  $table = Get-CharsetTable
  if (-not $table.ContainsKey($key)) {
    $known = ($table.Keys | Sort-Object -Unique) -join ', '
    throw (New-OsError -Code 'E_CHARSET_UNKNOWN' -Message ("unknown charset '{0}'" -f $Name) `
        -Hint ("supported names: {0}" -f $known))
  }
  return $table[$key]
}

function Get-EncodingObject {
  param($Charset)
  try {
    return [System.Text.Encoding]::GetEncoding([int]$Charset.dotnet)
  } catch {
    throw (New-OsError -Code 'E_CHARSET_UNKNOWN' -Message ("charset '{0}' is not available in this runtime" -f $Charset.iana))
  }
}

function Get-BomBytes {
  param($Charset)
  # The unary comma matters: PowerShell enumerates a returned array, so a bare `return @()` becomes
  # $null at the call site and $bom.Length then throws for every charset without a BOM (gbk,
  # shift_jis, latin1, ...). Returning a one-element wrapper keeps the array intact.
  $bytes = New-Object System.Collections.ArrayList
  if ($Charset.bom -ne '-') {
    $hex = $Charset.bom
    for ($i = 0; $i -lt $hex.Length; $i += 2) {
      [void]$bytes.Add([Convert]::ToByte($hex.Substring($i, 2), 16))
    }
  }
  return , $bytes.ToArray()
}

function Resolve-BomPolicy {
  param([string]$Policy, [bool]$SourceHasBom, $Target)
  # 'keep' means literally "the result carries a byte order mark exactly when the source did", not
  # "force a BOM because the target encoding has one". The opposite reading demanded a GBK BOM just
  # because a UTF-8 file was converted, which no such encoding has.
  switch ($Policy) {
    'keep' { return $SourceHasBom }
    'add' {
      if ($Target.bom -eq '-') {
        throw (New-OsError -Code 'E_BOM_INVALID' -Message ("charset '{0}' has no byte order mark to add" -f $Target.iana))
      }
      return $true
    }
    'strip' { return $false }
    default {
      throw (New-OsError -Code 'E_USAGE' -Message ("--bom must be keep, strip or add, got '{0}'" -f $Policy))
    }
  }
}

function Get-WithBomBytes {
  param([byte[]]$Payload, $Charset, [bool]$WithBom)
  # Assemble the preamble and the payload into one byte array. Kept in one place so the length
  # arithmetic and the empty-preamble case are handled identically for create/encode/append.
  if (-not $WithBom) { return , $Payload }
  $bom = Get-BomBytes -Charset $Charset
  if ($null -eq $bom -or $bom.Length -eq 0) {
    throw (New-OsError -Code 'E_BOM_INVALID' -Message ("charset '{0}' has no byte order mark" -f $Charset.iana))
  }
  $out = New-Object byte[] ($bom.Length + $Payload.Length)
  [Array]::Copy($bom, 0, $out, 0, $bom.Length)
  [Array]::Copy($Payload, 0, $out, $bom.Length, $Payload.Length)
  return , $out
}

function Test-IsValidEncoding {
  param([byte[]]$Bytes, $Charset)
  if ($Charset.iana -eq 'utf-8' -or $Charset.iana -eq 'utf-8-bom') {
    # Only the throwing decoder detects a byte sequence that is not valid UTF-8; the default
    # replacement fallback returns U+FFFD and would accept anything.
    try { [void](New-Object System.Text.UTF8Encoding($false, $true)).GetString($Bytes); return $true } catch { return $false }
  }
  # Decode through Encoding.GetString rather than Decoder.GetChars: Windows PowerShell 5.1 cannot
  # bind the 3-argument GetChars overload, so that probe threw for every candidate charset and the
  # detector silently fell through to latin1.
  try { [void](Get-EncodingObject -Charset $Charset).GetString($Bytes); return $true } catch { return $false }
}

function Remove-BomChar {
  param([string]$Text)
  # A payload that still carries the preamble decodes to a leading U+FEFF. It is never content.
  if ($Text.Length -gt 0 -and [int][char]$Text[0] -eq 0xFEFF) { return $Text.Substring(1) }
  return $Text
}

# ---------------------------------------------------------------------------
# Byte-level text model. A TextDoc records everything needed to write the file
# back exactly as it was, apart from the intended semantic change.
# ---------------------------------------------------------------------------
$script:MaxReadBytes = 33554432  # 32 MiB guard for whole-file views

function Read-TextDoc {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot read '{0}': not found" -f $Path))
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    throw (New-OsError -Code 'E_NOT_A_FILE' -Message ("cannot read '{0}': not a regular file" -f $Path))
  }
  $fi = Get-Item -LiteralPath $Path -Force
  if ($fi.Length -gt $script:MaxReadBytes) {
    throw (New-OsError -Code 'E_TRUNCATED' -Message ("cannot read '{0}': {1} bytes exceeds the {2}-byte limit" -f $Path, $fi.Length, $script:MaxReadBytes))
  }
  $bytes = [System.IO.File]::ReadAllBytes($Path)

  $charset = $null
  $bomLen = 0
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $charset = (Get-CharsetTable)['utf-8-bom']; $bomLen = 3
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE -and -not ($bytes.Length -ge 4 -and $bytes[2] -eq 0 -and $bytes[3] -eq 0)) {
    $charset = (Get-CharsetTable)['utf-16le']; $bomLen = 2
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
    $charset = (Get-CharsetTable)['utf-16be']; $bomLen = 2
  } elseif ($bytes.Length -ge 4 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE -and $bytes[2] -eq 0 -and $bytes[3] -eq 0) {
    $charset = (Get-CharsetTable)['utf-32le']; $bomLen = 4
  } elseif ($bytes.Length -ge 4 -and $bytes[0] -eq 0 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0xFE -and $bytes[3] -eq 0xFF) {
    $charset = (Get-CharsetTable)['utf-32be']; $bomLen = 4
  }

  # Binary detection on the sample that excludes the BOM.
  $sampleLen = [Math]::Min(8192, [Math]::Max(0, $bytes.Length - $bomLen))
  for ($i = $bomLen; $i -lt $bomLen + $sampleLen; $i++) {
    if ($bytes[$i] -eq 0) {
      if ($null -eq $charset -or ($charset.iana -ne 'utf-16le' -and $charset.iana -ne 'utf-16be')) {
        throw (New-OsError -Code 'E_BINARY_CONTENT' -Message ("cannot read '{0}' as text: the content looks binary" -f $Path))
      }
    }
  }

  $payload = New-Object byte[] ($bytes.Length - $bomLen)
  [Array]::Copy($bytes, $bomLen, $payload, 0, $payload.Length)

  if ($null -eq $charset) {
    if (Test-IsValidEncoding -Bytes $payload -Charset ((Get-CharsetTable)['utf-8'])) {
      $charset = (Get-CharsetTable)['utf-8']
    } elseif (Test-IsValidEncoding -Bytes $payload -Charset ((Get-CharsetTable)['gbk'])) {
      $charset = (Get-CharsetTable)['gbk']
    } else {
      $charset = (Get-CharsetTable)['latin1']
    }
  }

  $enc = Get-EncodingObject -Charset $charset
  $text = $enc.GetString($payload)
  # The payload already excludes the BOM bytes, but a leading U+FEFF must never reach a caller.
  $text = Remove-BomChar -Text $text

  $eol = 'lf'
  if ($text.Contains("`r`n")) { $eol = 'crlf' }

  return [ordered]@{
    path = $Path
    charset = $charset
    hasBom = $bomLen -gt 0
    bomLen = $bomLen
    eol = $eol
    text = $text
    bytes = $bytes
    size = $bytes.Length
    lines = (Get-LineCount -Text $text)
  }
}

function Get-LineCount {
  param([string]$Text)
  # A trailing newline terminates the last line rather than opening an empty one.
  if ($Text.Length -eq 0) { return 0 }
  $count = 0
  foreach ($ch in $Text.ToCharArray()) { if ($ch -eq "`n") { $count++ } }
  if (-not $Text.EndsWith("`n")) { $count++ }
  return $count
}

function Get-OutputBytes {
  param($Doc, [string]$Text)
  # The two UTF-8 variants share code page 65001, so the Encoding object alone cannot carry the
  # BOM choice: pick the object that matches the charset, then decide the preamble separately.
  if ($Doc.charset.iana -eq 'utf-8-bom') { $enc = New-Object System.Text.UTF8Encoding($true) }
  elseif ($Doc.charset.iana -eq 'utf-8') { $enc = New-Object System.Text.UTF8Encoding($false) }
  else { $enc = Get-EncodingObject -Charset $Doc.charset }
  $payload = $enc.GetBytes($Text)
  return , (Get-WithBomBytes -Payload $payload -Charset $Doc.charset -WithBom $Doc.hasBom)
}

# ---------------------------------------------------------------------------
# Native layer.
#
# Everything native is declared here in a single Add-Type, compiled on first use
# (Add-Type costs ~200-400 ms, so read-only verbs must never touch it). Only
# built-in facilities are used: no koffi, no third-party module. Windows
# PowerShell 5.1 compiles C# 5, so no string interpolation, no expression-bodied
# members and no null-conditional operators appear below.
# ---------------------------------------------------------------------------
$script:NativeReady = $false

function Initialize-Native {
  if ($script:NativeReady) { return }
  $code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshNative
{
    // -- file / process ---------------------------------------------------
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileExW(string existing, string next, int flags);
    public const int MOVEFILE_REPLACE_EXISTING = 0x1;
    public const int MOVEFILE_COPY_ALLOWED = 0x2;
    public const int MOVEFILE_WRITE_THROUGH = 0x8;

    // -- cursor -----------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    // -- synthetic input --------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern short GetKeyState(int vKey);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    // -- foreground / window ----------------------------------------------
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const uint GW_HWNDNEXT = 2;
    public const uint GW_HWNDPREV = 3;
    public const uint WM_CLOSE = 0x0010;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;

    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    // -- clipboard --------------------------------------------------------
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint format, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalSize(IntPtr handle);
    public const uint GMEM_MOVEABLE = 0x0002;
    public const uint CF_UNICODETEXT = 13;

    // -- screen capture ---------------------------------------------------
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int sx, int sy, uint rop);
    public const uint SRCCOPY = 0x00CC0020;

    // -- DPI --------------------------------------------------------------
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    // -- helpers ----------------------------------------------------------
    public static string WindowText(IntPtr hWnd)
    {
        int len = GetWindowTextLengthW(hWnd);
        if (len <= 0) { return ""; }
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowClass(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static void SendKey(ushort vk, ushort scan, uint flags)
    {
        INPUT[] one = new INPUT[1];
        one[0].type = INPUT_KEYBOARD;
        one[0].u.ki.wVk = vk;
        one[0].u.ki.wScan = scan;
        one[0].u.ki.dwFlags = flags;
        one[0].u.ki.time = 0;
        one[0].u.ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendUnicodeChar(char ch)
    {
        SendKey(0, (ushort)ch, KEYEVENTF_UNICODE);
        SendKey(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    public static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        INPUT[] one = new INPUT[1];
        one[0].type = INPUT_MOUSE;
        one[0].u.mi.dx = dx;
        one[0].u.mi.dy = dy;
        one[0].u.mi.mouseData = data;
        one[0].u.mi.dwFlags = flags;
        one[0].u.mi.time = 0;
        one[0].u.mi.dwExtraInfo = IntPtr.Zero;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  # Declare DPI awareness before any window exists, so reported coordinates and injected clicks
  # agree with what the user sees on a scaled display.
  try { [DshNative]::SetProcessDPIAware() | Out-Null } catch { }
  $script:NativeReady = $true
}

function Invoke-MoveFileReplace {
  param([string]$Source, [string]$Destination)
  Initialize-Native
  $flags = [DshNative]::MOVEFILE_REPLACE_EXISTING -bor [DshNative]::MOVEFILE_WRITE_THROUGH
  return [DshNative]::MoveFileExW($Source, $Destination, $flags)
}

function Write-Atomic {
  param([string]$Path, [byte[]]$Bytes)
  $dir = Split-Path -Parent $Path
  if ([string]::IsNullOrEmpty($dir)) { $dir = (Get-Location).Path }
  if (-not (Test-Path -LiteralPath $dir)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("cannot write '{0}': directory '{1}' does not exist" -f $Path, $dir))
  }
  $tmp = Join-Path $dir ('.dsh-os-' + [Guid]::NewGuid().ToString('n') + '.tmp')
  try {
    [System.IO.File]::WriteAllBytes($tmp, $Bytes)
    # The temporary is fully written before it is published, so a reader never observes a partially
    # written target. .NET Framework has no File.Move(overwrite), so the replace goes through
    # MoveFileExW with MOVEFILE_REPLACE_EXISTING.
    if (Test-Path -LiteralPath $Path) {
      if (-not (Invoke-MoveFileReplace -Source $tmp -Destination $Path)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot replace '{0}': MoveFileExW failed with win32 error {1}" -f $Path, $err))
      }
    } else {
      [System.IO.File]::Move($tmp, $Path)
    }
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if ($_.Exception.Message -match 'already exists') {
      throw (New-OsError -Code 'E_EXISTS' -Message ("cannot write '{0}': it already exists" -f $Path))
    }
    if ($_.Exception.PSObject.Properties['OsCode']) { throw }
    throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot write '{0}': {1}" -f $Path, $_.Exception.Message))
  }
}

function Get-CharBoundaryCheck {
  param($Doc, [int]$Offset, [string]$Path)
  if ($Offset -lt 0 -or $Offset -gt $Doc.bytes.Length) {
    throw (New-OsError -Code 'E_RANGE' -Message ("offset {0} is out of range for '{1}' (0..{2})" -f $Offset, $Path, $Doc.bytes.Length))
  }
  if ($Offset -eq 0 -or $Offset -eq $Doc.bytes.Length) { return }
  $enc = $Doc.charset.iana
  if ($enc -eq 'utf-8' -or $enc -eq 'utf-8-bom') {
    # A continuation byte is 10xxxxxx; an offset may not point at one.
    if (($Doc.bytes[$Offset] -band 0xC0) -eq 0x80) {
      throw (New-OsError -Code 'E_BOUNDARY' -Message ("offset {0} falls inside a multi-byte character in '{1}'" -f $Offset, $Path) `
          -Hint 'offsets are byte offsets and must land on a character boundary')
    }
    return
  }
  if ($enc -eq 'utf-16le' -or $enc -eq 'utf-16be') {
    if ($Offset % 2 -ne 0) {
      throw (New-OsError -Code 'E_BOUNDARY' -Message ("offset {0} falls inside a UTF-16 code unit in '{1}'" -f $Offset, $Path))
    }
    return
  }
  if ($enc -eq 'utf-32le' -or $enc -eq 'utf-32be') {
    if ($Offset % 4 -ne 0) {
      throw (New-OsError -Code 'E_BOUNDARY' -Message ("offset {0} falls inside a UTF-32 code unit in '{1}'" -f $Offset, $Path))
    }
  }
}

# ---------------------------------------------------------------------------
# Path helpers.
# ---------------------------------------------------------------------------
function Resolve-FullPath {
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) {
    throw (New-OsError -Code 'E_USAGE' -Message 'a path argument must not be empty')
  }
  try {
    return [System.IO.Path]::GetFullPath($Path)
  } catch {
    throw (New-OsError -Code 'E_TYPE' -Message ("'{0}' is not a valid path: {1}" -f $Path, $_.Exception.Message))
  }
}

# ---------------------------------------------------------------------------
# Protected paths (authorization layer B; see docs/permission-model.md section 3.1).
#
# These are the files that decide what this layer is allowed to do, so no verb may modify them.
# The check runs on a fully resolved absolute path and compares normalized segments rather than
# matching a pattern: a regular expression would be walked around by "..", by a short (8.3) name,
# or by a trailing dot on Windows. Reads are deliberately still allowed, so a caller can inspect
# the rules and the scripts.
# ---------------------------------------------------------------------------
$script:ProtectedRelativePaths = @(
  'permission.json',
  'permission.json.bak',
  'src\host\command.txt',
  'src\host\bin\dsh-os.ps1',
  'src\host\bin\dsh-os.sh',
  'src\host\bin\dsh-os.bat',
  'src\host\spec\verbs.tsv',
  'src\host\spec\charsets.tsv'
)

function Get-ProtectedPaths {
  $list = New-Object System.Collections.ArrayList
  foreach ($rel in $script:ProtectedRelativePaths) {
    [void]$list.Add([System.IO.Path]::GetFullPath((Join-Path $script:RootDir $rel)))
  }
  return , $list.ToArray()
}

function Test-ProtectedPath {
  param([string]$Path)
  # Trailing dots and spaces are stripped by the Windows file system but not by string comparison,
  # so normalize them away before comparing.
  $candidate = $Path
  while ($candidate.Length -gt 3 -and ($candidate.EndsWith('.') -or $candidate.EndsWith(' '))) {
    $candidate = $candidate.Substring(0, $candidate.Length - 1)
  }
  foreach ($protected in (Get-ProtectedPaths)) {
    if ([string]::Equals($candidate, $protected, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  # A temporary file written next to a protected path must be protected too, otherwise an atomic
  # write could stage content beside it.
  foreach ($protected in (Get-ProtectedPaths)) {
    $dir = Split-Path -Parent $protected
    $leaf = Split-Path -Leaf $protected
    $candDir = Split-Path -Parent $candidate
    $candLeaf = Split-Path -Leaf $candidate
    if ([string]::Equals($dir, $candDir, [System.StringComparison]::OrdinalIgnoreCase) -and
        $candLeaf.StartsWith($leaf + '.', [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Assert-NotProtectedPath {
  param([string]$Path, [string]$Verb)
  if (Test-ProtectedPath -Path $Path) {
    throw (New-OsError -Code 'E_PERMISSION_PROTECTED_PATH' `
        -Message ("{0} may not modify '{1}': it is part of the authorization layer" -f $Verb, $Path) `
        -Hint 'authorization changes go through the consent delegate, which requires a user-accepted dialog; see docs/permission-model.md')
  }
}

# ---------------------------------------------------------------------------
# file.* verbs
# ---------------------------------------------------------------------------
function Invoke-FileCreate {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'file create'
  Assert-Allowed -Parsed $Parsed -Verb 'file create' -Perm 'W' -Positionals 3
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file create'
  $content = Get-Positional -Parsed $Parsed -Index 1 -Name 'content'
  $charsetName = Get-Positional -Parsed $Parsed -Index 2 -Name 'charset' -Optional -Default 'utf-8'
  Assert-NoExtra -Parsed $Parsed -Expected 3

  if (Test-Path -LiteralPath $path) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("cannot create '{0}': it already exists" -f $path) `
        -Hint 'use file view to read it, file append/file insert to extend it, or file delete then create')
  }
  $dir = Split-Path -Parent $path
  if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $charset = Resolve-Charset -Name $charsetName
  $enc = Get-EncodingObject -Charset $charset
  $text = $content
  $eol = Get-FlagValue -Parsed $Parsed -Name 'eol' -Default $null
  if ($eol -eq 'crlf') { $text = $text.Replace("`r`n", "`n").Replace("`n", "`r`n") }

  $payload = $enc.GetBytes($text)
  $bytes = Get-WithBomBytes -Payload $payload -Charset $charset -WithBom ($charset.iana -eq 'utf-8-bom')
  Write-Atomic -Path $path -Bytes $bytes
  return [ordered]@{
    path = $path; operation = 'create'; charset = $charset.iana
    bom = ($charset.iana -eq 'utf-8-bom'); eol = $(if ($eol) { $eol } else { 'lf' })
    bytes = $bytes.Length
  }
}

function Invoke-FileCharset {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $doc = Read-TextDoc -Path $path
  return [ordered]@{
    path = $doc.path
    charset = $doc.charset.iana
    bom = $doc.hasBom
    eol = $doc.eol
    size = $doc.size
    lines = $doc.lines
  }
}

function Invoke-FileEncode {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'file encode'
  Assert-Allowed -Parsed $Parsed -Verb 'file encode' -Perm 'W' -Positionals 2
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file encode'
  $target = Resolve-Charset -Name (Get-Positional -Parsed $Parsed -Index 1 -Name 'charset')
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $doc = Read-TextDoc -Path $path

  if (Test-HasFlag -Parsed $Parsed -Name 'backup') {
    [System.IO.File]::WriteAllBytes(($path + '.bak'), $doc.bytes)
  }

  $bomPolicy = Get-FlagValue -Parsed $Parsed -Name 'bom' -Default 'keep'
  $text = $doc.text
  $targetHasBom = Resolve-BomPolicy -Policy $bomPolicy -SourceHasBom $doc.hasBom -Target $target
  $targetDoc = [ordered]@{ charset = $target; hasBom = $targetHasBom }

  $enc = Get-EncodingObject -Charset $target
  if ($target.iana -eq 'utf-8-bom') { $enc = New-Object System.Text.UTF8Encoding($true) }
  elseif ($target.iana -eq 'utf-8') { $enc = New-Object System.Text.UTF8Encoding($false) }
  $payload = $enc.GetBytes($text)
  $bytes = Get-WithBomBytes -Payload $payload -Charset $target -WithBom $targetDoc.hasBom
  Write-Atomic -Path $path -Bytes $bytes
  return [ordered]@{
    path = $doc.path; from = $doc.charset.iana; to = $target.iana
    bom = $targetDoc.hasBom; eol = $doc.eol; bytes = $bytes.Length
    backup = (Test-HasFlag -Parsed $Parsed -Name 'backup')
  }
}

function Invoke-FileLength {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot measure '{0}': not found" -f $path))
  }
  if (Test-Path -LiteralPath $path -PathType Container) {
    if (Test-HasFlag -Parsed $Parsed -Name 'no-recursive') {
      $fi = Get-Item -LiteralPath $path -Force
      return [ordered]@{ path = $path; type = 'directory'; bytes = 0; files = 0; directories = 0 }
    }
    $total = [int64]0
    $files = 0
    $dirs = 0
    foreach ($f in Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue) {
      $total += $f.Length; $files++
    }
    foreach ($d in Get-ChildItem -LiteralPath $path -Recurse -Force -Directory -ErrorAction SilentlyContinue) { $dirs++ }
    return [ordered]@{ path = $path; type = 'directory'; bytes = $total; files = $files; directories = $dirs; recursive = $true }
  }
  $item = Get-Item -LiteralPath $path -Force
  return [ordered]@{ path = $path; type = 'file'; bytes = [int64]$item.Length; recursive = $false }
}

function Invoke-FileInformation {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot inspect '{0}': not found" -f $path))
  }
  $item = Get-Item -LiteralPath $path -Force
  $info = [ordered]@{
    path = $path
    type = $(if ($item.PSIsContainer) { 'directory' } else { 'file' })
    size = [int64]$item.Length
    attributes = $item.Attributes.ToString()
    created = $item.CreationTimeUtc.ToString('o')
    modified = $item.LastWriteTimeUtc.ToString('o')
    accessed = $item.LastAccessTimeUtc.ToString('o')
    realpath = $path
  }
  if (-not $item.PSIsContainer) {
    try {
      $doc = Read-TextDoc -Path $path
      $info['charset'] = $doc.charset.iana
      $info['bom'] = $doc.hasBom
      $info['eol'] = $doc.eol
      $info['lines'] = $doc.lines
    } catch {
      $info['charset'] = $null
      $info['error'] = (Get-ErrorCode -ErrorRecord $_)
    }
  }
  return $info
}

function Invoke-FileList {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot list '{0}': not found" -f $path))
  }
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    throw (New-OsError -Code 'E_NOT_A_DIR' -Message ("cannot list '{0}': not a directory" -f $path))
  }
  $entries = New-Object System.Collections.ArrayList
  foreach ($c in Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue) {
    [void]$entries.Add([ordered]@{
      name = $c.Name
      type = $(if ($c.PSIsContainer) { 'directory' } else { 'file' })
      size = [int64]$c.Length
      modified = $c.LastWriteTimeUtc.ToString('o')
    })
  }
  return [ordered]@{ path = $path; entries = $entries.ToArray(); count = $entries.Count }
}

function Invoke-FileDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'file delete'
  Assert-Allowed -Parsed $Parsed -Verb 'file delete' -Perm 'W' -Positionals 1
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file delete'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot delete '{0}': not found" -f $path))
  }
  $permanent = Test-HasFlag -Parsed $Parsed -Name 'permanent'
  if ($permanent) {
    Remove-Item -LiteralPath $path -Recurse -Force
    return [ordered]@{ path = $path; operation = 'unlink'; permanent = $true }
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  if (Test-Path -LiteralPath $path -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
  return [ordered]@{ path = $path; operation = 'recycle'; permanent = $false }
}

function Invoke-FileMove {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'file move'
  Assert-Allowed -Parsed $Parsed -Verb 'file move' -Perm 'W' -Positionals 2
  $src = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'source')
  $dst = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 1 -Name 'destination')
  # Both ends matter: a move removes the source as surely as it writes the destination, so
  # protecting only the destination would let a caller relocate permission.json out of the way.
  Assert-NotProtectedPath -Path $src -Verb 'file move'
  Assert-NotProtectedPath -Path $dst -Verb 'file move'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  if (-not (Test-Path -LiteralPath $src)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot move '{0}': not found" -f $src))
  }
  if (Test-Path -LiteralPath $dst) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("cannot move to '{0}': it already exists" -f $dst))
  }
  $dir = Split-Path -Parent $dst
  if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("cannot move to '{0}': directory '{1}' does not exist" -f $dst, $dir))
  }
  [System.IO.File]::Move($src, $dst)
  return [ordered]@{ source = $src; destination = $dst; operation = 'move' }
}

function Invoke-FileCopy {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'file copy'
  Assert-Allowed -Parsed $Parsed -Verb 'file copy' -Perm 'W' -Positionals 2
  $src = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'source')
  $dst = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 1 -Name 'destination')
  # Copying a protected file out to an unprotected location is a disclosure, not merely a write, so
  # the source is checked as well as the destination.
  Assert-NotProtectedPath -Path $src -Verb 'file copy'
  Assert-NotProtectedPath -Path $dst -Verb 'file copy'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  if (-not (Test-Path -LiteralPath $src)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot copy '{0}': not found" -f $src))
  }
  if (Test-Path -LiteralPath $dst) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("cannot copy to '{0}': it already exists" -f $dst))
  }
  $dir = Split-Path -Parent $dst
  if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("cannot copy to '{0}': directory '{1}' does not exist" -f $dst, $dir))
  }
  if (Test-Path -LiteralPath $src -PathType Container) {
    Copy-Item -LiteralPath $src -Destination $dst -Recurse
  } else {
    Copy-Item -LiteralPath $src -Destination $dst
  }
  return [ordered]@{ source = $src; destination = $dst; operation = 'copy' }
}

function Invoke-FileMkdir {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'file mkdir'
  Assert-Allowed -Parsed $Parsed -Verb 'file mkdir' -Perm 'W' -Positionals 1
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file mkdir'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (Test-Path -LiteralPath $path) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("cannot create directory '{0}': it already exists" -f $path))
  }
  if (Test-HasFlag -Parsed $Parsed -Name 'parents') {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  } else {
    $parent = Split-Path -Parent $path
    if (-not [string]::IsNullOrEmpty($parent) -and -not (Test-Path -LiteralPath $parent)) {
      throw (New-OsError -Code 'E_NO_PARENT' -Message ("cannot create '{0}': parent '{1}' does not exist" -f $path, $parent) `
          -Hint 'pass --parents to create intermediate directories')
    }
    New-Item -ItemType Directory -Path $path | Out-Null
  }
  return [ordered]@{ path = $path; operation = 'mkdir' }
}

function Invoke-FileAppend {
  param($Parsed)
  # charset is optional on append: when omitted the file's own encoding is used, which is almost
  # always what a caller wants. Supplying it turns the call into an assertion.
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'file append'
  Assert-Allowed -Parsed $Parsed -Verb 'file append' -Perm 'W' -Positionals 3
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file append'
  $content = Get-Positional -Parsed $Parsed -Index 1 -Name 'content'
  $charsetName = Get-Positional -Parsed $Parsed -Index 2 -Name 'charset' -Optional -Default $null
  Assert-NoExtra -Parsed $Parsed -Expected 3
  $doc = Read-TextDoc -Path $path
  if ($charsetName) {
    $expect = Resolve-Charset -Name $charsetName
    if ($expect.iana -ne $doc.charset.iana -and -not ($expect.iana -eq 'utf-8' -and $doc.charset.iana -eq 'utf-8-bom')) {
      throw (New-OsError -Code 'E_CHARSET_MISMATCH' -Message ("'{0}' is {1}, not {2}" -f $path, $doc.charset.iana, $expect.iana))
    }
  }
  # The appended text adopts the file's EOL convention so the result stays coherent.
  $add = $content
  if ($doc.eol -eq 'crlf') { $add = $add.Replace("`r`n", "`n").Replace("`n", "`r`n") }
  $text = $doc.text + $add
  $bytes = Get-OutputBytes -Doc $doc -Text $text
  Write-Atomic -Path $path -Bytes $bytes
  return [ordered]@{
    path = $doc.path; operation = 'append'; charset = $doc.charset.iana
    bom = $doc.hasBom; eol = $doc.eol; offset = $doc.bytes.Length; bytes = $bytes.Length
  }
}

function Invoke-FileInsert {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'file insert'
  Assert-Allowed -Parsed $Parsed -Verb 'file insert' -Perm 'W' -Positionals 4
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NotProtectedPath -Path $path -Verb 'file insert'
  $content = Get-Positional -Parsed $Parsed -Index 1 -Name 'content'
  # charset is accepted as --charset rather than as the third positional: it sits between content
  # and offset in command.txt, so an omitted positional there would silently shift offset. Omitting
  # it uses the file's own encoding; supplying it turns the call into an assertion.
  $charsetName = Get-FlagValue -Parsed $Parsed -Name 'charset' -Default $null
  $offset = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 2 -Name 'offset') -Name 'offset'
  Assert-NoExtra -Parsed $Parsed -Expected 3
  $doc = Read-TextDoc -Path $path
  if ($charsetName) {
    $expect = Resolve-Charset -Name $charsetName
    if ($expect.iana -ne $doc.charset.iana -and -not ($expect.iana -eq 'utf-8' -and $doc.charset.iana -eq 'utf-8-bom')) {
      throw (New-OsError -Code 'E_CHARSET_MISMATCH' -Message ("'{0}' is {1}, not {2}" -f $path, $doc.charset.iana, $expect.iana))
    }
  }
  Get-CharBoundaryCheck -Doc $doc -Offset $offset -Path $path

  # Splice on the byte level so the inserted bytes use the file's own encoding.
  $enc = Get-EncodingObject -Charset $doc.charset
  $payloadStart = 0
  if ($doc.hasBom) { $payloadStart = $doc.bomLen }
  $add = $content
  if ($doc.eol -eq 'crlf') { $add = $add.Replace("`r`n", "`n").Replace("`n", "`r`n") }
  $addBytes = $enc.GetBytes($add)

  $head = New-Object byte[] ($offset)
  [Array]::Copy($doc.bytes, 0, $head, 0, $offset)
  $tail = New-Object byte[] ($doc.bytes.Length - $offset)
  [Array]::Copy($doc.bytes, $offset, $tail, 0, $tail.Length)
  $out = New-Object byte[] ($head.Length + $addBytes.Length + $tail.Length)
  [Array]::Copy($head, 0, $out, 0, $head.Length)
  [Array]::Copy($addBytes, 0, $out, $head.Length, $addBytes.Length)
  [Array]::Copy($tail, 0, $out, $head.Length + $addBytes.Length, $tail.Length)

  Write-Atomic -Path $path -Bytes $out
  return [ordered]@{
    path = $doc.path; operation = 'insert'; charset = $doc.charset.iana
    bom = $doc.hasBom; eol = $doc.eol; offset = $offset
    written = $addBytes.Length; bytes = $out.Length
  }
}

function Invoke-FileView {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  $charsetName = Get-Positional -Parsed $Parsed -Index 1 -Name 'charset' -Optional -Default $null
  $startText = Get-Positional -Parsed $Parsed -Index 2 -Name 'start' -Optional -Default $null
  $endText = Get-Positional -Parsed $Parsed -Index 3 -Name 'end' -Optional -Default $null
  Assert-NoExtra -Parsed $Parsed -Expected 4
  $doc = Read-TextDoc -Path $path

  if ($charsetName) {
    $expect = Resolve-Charset -Name $charsetName
    if ($expect.iana -ne $doc.charset.iana) {
      throw (New-OsError -Code 'E_CHARSET_MISMATCH' -Message ("'{0}' is {1}, not {2}" -f $path, $doc.charset.iana, $expect.iana))
    }
  }

  $total = $doc.bytes.Length
  $start = 0
  if ($startText) { $start = Get-IntArg -Text $startText -Name 'start' }
  $end = $total
  if ($endText) { $end = Get-IntArg -Text $endText -Name 'end' }
  if ($end -lt $start) {
    throw (New-OsError -Code 'E_RANGE' -Message ("end {0} precedes start {1}" -f $end, $start))
  }
  if ($start -gt $total -or $end -gt $total) {
    throw (New-OsError -Code 'E_RANGE' -Message ("range [{0},{1}) is out of bounds for a {2}-byte file" -f $start, $end, $total))
  }
  Get-CharBoundaryCheck -Doc $doc -Offset $start -Path $path
  Get-CharBoundaryCheck -Doc $doc -Offset $end -Path $path

  $length = $end - $start
  $slice = New-Object byte[] $length
  [Array]::Copy($doc.bytes, $start, $slice, 0, $length)
  $enc = Get-EncodingObject -Charset $doc.charset
  $text = Remove-BomChar -Text ($enc.GetString($slice))

  $normalized = $text.Replace("`r`n", "`n")
  $lines = @($normalized -split "`n")
  $withNumbers = -not (Test-HasFlag -Parsed $Parsed -Name 'no-numbers')
  $rendered = New-Object System.Collections.ArrayList
  $n = 1
  foreach ($l in $lines) {
    if ($withNumbers) { [void]$rendered.Add(('{0}: {1}' -f $n, $l)) } else { [void]$rendered.Add($l) }
    $n++
  }
  $body = $rendered -join "`n"

  $maxBytes = Get-FlagValue -Parsed $Parsed -Name 'max-bytes' -Default '1048576'
  $limit = Get-IntArg -Text $maxBytes -Name 'max-bytes'
  $charLimit = [int]$limit
  $truncated = $false
  if ($body.Length -gt $charLimit) {
    $body = $body.Substring(0, $charLimit) + "`n... (truncated at $charLimit characters)"
    $truncated = $true
  }

  return [ordered]@{
    path = $doc.path
    charset = $doc.charset.iana
    bom = $doc.hasBom
    eol = $doc.eol
    size = $doc.size
    start = $start
    end = $end
    totalBytes = $total
    lines = $lines.Length
    truncated = $truncated
    text = $body
  }
}

# ---------------------------------------------------------------------------
# file.verify.* - assertions. They report the observed value next to the match result and never
# modify the target, so a caller can distinguish "the file is wrong" from "I asked wrongly".
# ---------------------------------------------------------------------------
function Invoke-FileVerifyCharset {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  $expected = Resolve-Charset -Name (Get-Positional -Parsed $Parsed -Index 1 -Name 'charset')
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $doc = Read-TextDoc -Path $path
  $ok = ($expected.iana -eq $doc.charset.iana)
  return [ordered]@{
    path = $doc.path
    assertion = 'charset'
    expected = $expected.iana
    observed = $doc.charset.iana
    match = $ok
    bom = $doc.hasBom
    eol = $doc.eol
    size = $doc.size
  }
}

function Invoke-FileVerifyEncoding {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  $charset = Resolve-Charset -Name (Get-Positional -Parsed $Parsed -Index 1 -Name 'charset')
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $doc = Read-TextDoc -Path $path

  # A byte sequence is legal in a single-byte or ambiguous encoding only if decoding and
  # re-encoding reproduces it exactly: a default replacement fallback loses that round trip.
  $bomLen = $doc.bomLen
  $body = New-Object byte[] ($doc.bytes.Length - $bomLen)
  [Array]::Copy($doc.bytes, $bomLen, $body, 0, $body.Length)
  $enc = Get-EncodingObject -Charset $charset
  $text = $enc.GetString($body)
  $roundTrip = $enc.GetBytes($text)

  $legal = ($roundTrip.Length -eq $body.Length)
  $firstBad = -1
  if ($legal) {
    for ($i = 0; $i -lt $body.Length; $i++) {
      if ($body[$i] -ne $roundTrip[$i]) { $legal = $false; $firstBad = $i; break }
    }
  } else {
    $limit = [Math]::Min($body.Length, $roundTrip.Length)
    for ($i = 0; $i -lt $limit; $i++) {
      if ($body[$i] -ne $roundTrip[$i]) { $firstBad = $i; break }
    }
  }
  $replacements = 0
  foreach ($ch in $text.ToCharArray()) { if ([int][char]$ch -eq 0xFFFD) { $replacements++ } }

  $result = [ordered]@{
    path = $doc.path
    assertion = 'encoding'
    charset = $charset.iana
    legal = $legal
    roundTripExact = $legal
    replacementChars = $replacements
    size = $doc.size
    bytesExcludingBom = $body.Length
  }
  if ($firstBad -ge 0) { $result['firstIllegalOffset'] = $firstBad }
  return $result
}

function Invoke-FileVerifyCompletion {
  param($Parsed)
  $path = Resolve-FullPath (Get-Positional -Parsed $Parsed -Index 0 -Name 'path')
  Assert-NoExtra -Parsed $Parsed -Expected 1
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ path = $path; assertion = 'completion'; complete = $false; missing = $true }
  }
  $doc = Read-TextDoc -Path $path
  $checks = [ordered]@{}
  $allMatch = $true
  $anyProvided = $false

  $expectLen = Get-FlagValue -Parsed $Parsed -Name 'length' -Default $null
  if ($expectLen) {
    $anyProvided = $true
    $want = Get-IntArg -Text $expectLen -Name 'length'
    $got = [int]$doc.size
    $checks['length'] = [ordered]@{ expected = $want; observed = $got; match = ($want -eq $got) }
    if ($want -ne $got) { $allMatch = $false }
  }

  $expectHash = Get-FlagValue -Parsed $Parsed -Name 'sha256' -Default $null
  if ($expectHash) {
    $anyProvided = $true
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($doc.bytes) } finally { $sha.Dispose() }
    $hex = (($digest) | ForEach-Object { $_.ToString('x2') }) -join ''
    $want = $expectHash.ToLowerInvariant()
    $checks['sha256'] = [ordered]@{ expected = $want; observed = $hex; match = ($want -eq $hex) }
    if ($want -ne $hex) { $allMatch = $false }
  }

  $expectBom = Get-FlagValue -Parsed $Parsed -Name 'bom' -Default $null
  if ($expectBom) {
    $anyProvided = $true
    $want = ($expectBom -eq 'true' -or $expectBom -eq 'yes' -or $expectBom -eq '1')
    $checks['bom'] = [ordered]@{ expected = $want; observed = $doc.hasBom; match = ($want -eq $doc.hasBom) }
    if ($want -ne $doc.hasBom) { $allMatch = $false }
  }

  $expectEol = Get-FlagValue -Parsed $Parsed -Name 'eol' -Default $null
  if ($expectEol) {
    $anyProvided = $true
    $checks['eol'] = [ordered]@{ expected = $expectEol; observed = $doc.eol; match = ($expectEol -eq $doc.eol) }
    if ($expectEol -ne $doc.eol) { $allMatch = $false }
  }

  # With no expectation supplied, "completion" can only report the observed facts; saying
  # complete:false would be misleading, so the caller is told that no assertion was made.
  return [ordered]@{
    path = $doc.path
    assertion = 'completion'
    asserted = $anyProvided
    complete = $(if ($anyProvided) { $allMatch } else { $null })
    charset = $doc.charset.iana
    bom = $doc.hasBom
    eol = $doc.eol
    size = $doc.size
    lines = $doc.lines
    checks = $checks
  }
}

# ---------------------------------------------------------------------------
# system.* - pure queries. Each field degrades to null on its own instead of failing the whole
# answer, because a missing GPU driver or a locked-down WMI namespace is normal, not an error.
# ---------------------------------------------------------------------------
function Get-CimSafe {
  param([string]$ClassName, [string]$Namespace = 'root\cimv2')
  # The unary comma is essential: PowerShell unwraps a returned one-element array into the element
  # itself, so callers doing $result[0].Property would work by luck while $result.Count throws.
  # Returning a wrapper keeps the type stable for zero, one and many rows.
  try {
    return , @(Get-CimInstance -ClassName $ClassName -Namespace $Namespace -ErrorAction Stop)
  } catch {
    return , @()
  }
}

function Get-FirstOrNull {
  param($Items)
  if ($null -eq $Items) { return $null }
  if ($Items -is [System.Array]) {
    if ($Items.Length -eq 0) { return $null }
    return $Items[0]
  }
  return $Items
}

function Get-RegistryValueSafe {
  param([string]$KeyPath, [string]$Name)
  try {
    $item = Get-ItemProperty -Path $KeyPath -Name $Name -ErrorAction Stop
    return $item.$Name
  } catch {
    return $null
  }
}

function Invoke-SystemBrand {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $board = Get-CimSafe -ClassName 'Win32_BaseBoard'
  $cs = Get-CimSafe -ClassName 'Win32_ComputerSystem'
  $bios = Get-CimSafe -ClassName 'Win32_BIOS'
  $product = $null; $vendor = $null; $serial = $null
  if ((@($cs).Length -gt 0)) { $vendor = $cs[0].Manufacturer; $product = $cs[0].Model }
  if ((@($board).Length -gt 0)) { if (-not $product) { $product = $board[0].Product }; if (-not $vendor) { $vendor = $board[0].Manufacturer } }
  if ((@($bios).Length -gt 0)) { $serial = $bios[0].SerialNumber }
  return [ordered]@{
    platform = 'windows'
    vendor = $vendor
    product = $product
    serial = $serial
    family = 'windows'
  }
}

function Invoke-SystemCpu {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $cpus = Get-CimSafe -ClassName 'Win32_Processor'
  $items = New-Object System.Collections.ArrayList
  foreach ($c in $cpus) {
    [void]$items.Add([ordered]@{
      name = $c.Name
      manufacturer = $c.Manufacturer
      cores = $c.NumberOfCores
      threads = $c.NumberOfLogicalProcessors
      maxClockMhz = $c.MaxClockSpeed
      architecture = $(if ($null -ne $c.AddressWidth) { [string]$c.AddressWidth + '-bit' } else { $null })
    })
  }
  return [ordered]@{ count = $items.Count; processors = $items.ToArray() }
}

function Invoke-SystemGpu {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  # A machine with no usable driver legitimately reports an empty list here.
  $gpus = Get-CimSafe -ClassName 'Win32_VideoController'
  $items = New-Object System.Collections.ArrayList
  foreach ($g in $gpus) {
    [void]$items.Add([ordered]@{
      name = $g.Name
      vendor = $g.AdapterCompatibility
      memoryBytes = $(if ($null -ne $g.AdapterRAM -and [int64]$g.AdapterRAM -gt 0) { [int64]$g.AdapterRAM } else { $null })
      driverVersion = $g.DriverVersion
      resolution = $(if ($g.CurrentHorizontalResolution) { ([string]$g.CurrentHorizontalResolution + 'x' + [string]$g.CurrentVerticalResolution) } else { $null })
    })
  }
  return [ordered]@{ count = $items.Count; adapters = $items.ToArray() }
}

function Invoke-SystemVersion {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $os = Get-CimSafe -ClassName 'Win32_OperatingSystem'
  $caption = $null; $version = $null; $build = $null; $arch = $null
  if ((@($os).Length -gt 0)) {
    $caption = $os[0].Caption; $version = $os[0].Version; $build = $os[0].BuildNumber; $arch = $os[0].OSArchitecture
  }
  return [ordered]@{
    platform = 'windows'
    caption = $caption
    version = $version
    build = $build
    architecture = $arch
    productName = (Get-RegistryValueSafe -KeyPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'ProductName')
    displayVersion = (Get-RegistryValueSafe -KeyPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'DisplayVersion')
    powershell = $PSVersionTable.PSVersion.ToString()
    clr = $PSVersionTable.CLRVersion.ToString()
    isElevated = (Test-IsElevated)
    user = [System.Environment]::UserName
  }
}

function Invoke-SystemInfo {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  return [ordered]@{
    brand = (Invoke-SystemBrand -Parsed $Parsed)
    cpu = (Invoke-SystemCpu -Parsed $Parsed)
    gpu = (Invoke-SystemGpu -Parsed $Parsed)
    version = (Invoke-SystemVersion -Parsed $Parsed)
  }
}

function Test-IsElevated {
  try {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $null
  }
}

# ---------------------------------------------------------------------------
# task.* - process queries and launch. Launch never goes through a shell string.
# ---------------------------------------------------------------------------
function Invoke-TaskList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $limitText = Get-FlagValue -Parsed $Parsed -Name 'limit' -Default '200'
  $limit = Get-IntArg -Text $limitText -Name 'limit'
  $items = New-Object System.Collections.ArrayList
  foreach ($proc in (Get-Process -ErrorAction SilentlyContinue | Sort-Object -Property WorkingSet64 -Descending)) {
    if ($filter -ne '' -and $filter -ne '*' -and $proc.ProcessName -notlike $filter) { continue }
    [void]$items.Add([ordered]@{
      pid = $proc.Id
      name = $proc.ProcessName
      memoryBytes = [int64]$proc.WorkingSet64
      responding = $(if ($proc.Responding) { $true } else { $false })
    })
    if ($items.Count -ge $limit) { break }
  }
  return [ordered]@{ count = $items.Count; limit = $limit; processes = $items.ToArray() }
}

function Invoke-TaskQuery {
  param($Parsed)
  $pidText = Get-Positional -Parsed $Parsed -Index 0 -Name 'pid'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $targetPid = Get-IntArg -Text $pidText -Name 'pid'
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no process with pid {0}" -f $targetPid))
  }
  $path = $null
  try { $path = $proc.Path } catch { $path = $null }
  $startTime = $null
  try { $startTime = $proc.StartTime.ToUniversalTime().ToString('o') } catch { $startTime = $null }
  return [ordered]@{
    pid = $proc.Id
    name = $proc.ProcessName
    path = $path
    memoryBytes = [int64]$proc.WorkingSet64
    startTime = $startTime
    responding = $(if ($proc.Responding) { $true } else { $false })
    handleCount = $proc.HandleCount
    threadCount = $proc.Threads.Count
  }
}

function Invoke-TaskShow {
  param($Parsed)
  $pidText = Get-Positional -Parsed $Parsed -Index 0 -Name 'pid'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $targetPid = Get-IntArg -Text $pidText -Name 'pid'
  Initialize-Native
  $found = New-Object System.Collections.ArrayList
  $callback = [DshNative+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$param)
    $wpid = [uint32]0
    [void][DshNative]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($wpid -eq $targetPid -and [DshNative]::IsWindowVisible($hWnd)) {
      [void]$found.Add($hWnd)
    }
    return $true
  }
  [void][DshNative]::EnumWindows($callback, [IntPtr]::Zero)

  if ($found.Count -eq 0) {
    throw (New-OsError -Code 'E_WINDOW_NOT_FOUND' -Message ("pid {0} has no visible top-level window" -f $targetPid))
  }
  $handle = $found[0]
  [void][DshNative]::ShowWindow($handle, [DshNative]::SW_RESTORE)
  [void][DshNative]::SetForegroundWindow($handle)
  return [ordered]@{
    pid = $targetPid
    handle = [int64]$handle
    title = [DshNative]::WindowText($handle)
    windows = $found.Count
  }
}

# ---------------------------------------------------------------------------
# environment.* - scoped variable access. Every mutating call reports the scope it wrote, because a
# user- or machine-scope write does not reach already-running processes.
# ---------------------------------------------------------------------------
function Resolve-EnvironmentScope {
  param($Parsed, [string]$Default = 'user')
  $scope = Get-FlagValue -Parsed $Parsed -Name 'scope' -Default $Default
  switch ($scope) {
    'process' { return [System.EnvironmentVariableTarget]::Process }
    'user' { return [System.EnvironmentVariableTarget]::User }
    'machine' { return [System.EnvironmentVariableTarget]::Machine }
    default {
      throw (New-OsError -Code 'E_USAGE' -Message ("--scope must be process, user or machine, got '{0}'" -f $scope))
    }
  }
}

function Get-ScopeName {
  param($Target)
  switch ($Target) {
    ([System.EnvironmentVariableTarget]::Process) { return 'process' }
    ([System.EnvironmentVariableTarget]::User) { return 'user' }
    ([System.EnvironmentVariableTarget]::Machine) { return 'machine' }
  }
  return 'unknown'
}

function Assert-ScopeWritable {
  param($Target, [string]$Verb)
  if ($Target -ne [System.EnvironmentVariableTarget]::Machine) { return }
  if (Test-IsElevated) { return }
  throw (New-OsError -Code 'E_ELEVATION_REQUIRED' `
      -Message ("{0} at machine scope needs an elevated context" -f $Verb) `
      -Hint 'writes that would silently not apply are refused instead; use --scope user, or run elevated')
}

function Invoke-EnvironmentList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
  $vars = [System.Environment]::GetEnvironmentVariables($target)
  foreach ($key in ($vars.Keys | Sort-Object)) {
    if ($filter -ne '' -and $filter -ne '*' -and $key -notlike $filter) { continue }
    [void]$items.Add([ordered]@{ name = $key; value = [string]$vars[$key] })
  }
  return [ordered]@{ scope = (Get-ScopeName -Target $target); count = $items.Count; variables = $items.ToArray() }
}

function Invoke-EnvironmentGet {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $value = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $value) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
  }
  return [ordered]@{ name = $name; value = $value; scope = (Get-ScopeName -Target $target) }
}

function Invoke-EnvironmentAdd {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment add'
  Assert-Allowed -Parsed $Parsed -Verb 'environment add' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment add'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -ne $existing) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("'{0}' is already set at {1} scope" -f $name, (Get-ScopeName -Target $target)) `
        -Hint 'use environment set to overwrite it')
  }
  [System.Environment]::SetEnvironmentVariable($name, $value, $target)
  return [ordered]@{
    name = $name; value = $value; scope = (Get-ScopeName -Target $target); operation = 'add'
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentSet {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment set'
  Assert-Allowed -Parsed $Parsed -Verb 'environment set' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment set'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $existing) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)) `
        -Hint 'use environment add to create it')
  }
  [System.Environment]::SetEnvironmentVariable($name, $value, $target)
  return [ordered]@{
    name = $name; value = $value; scope = (Get-ScopeName -Target $target); operation = 'set'
    previous = $existing
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'environment delete'
  Assert-Allowed -Parsed $Parsed -Verb 'environment delete' -Perm 'W' -Positionals 1
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment delete'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $existing) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
  }
  [System.Environment]::SetEnvironmentVariable($name, $null, $target)
  $stillThere = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -ne $stillThere) {
    throw (New-OsError -Code 'E_IO' -Message ("'{0}' is still set at {1} scope after deletion" -f $name, (Get-ScopeName -Target $target)))
  }
  return [ordered]@{
    name = $name; previous = $existing; scope = (Get-ScopeName -Target $target); operation = 'delete'
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

# ---------------------------------------------------------------------------
# environment attr.* - an attribute of a variable is an ordered list joined by the platform
# separator. PATH is the default attribute; PATHEXT, LIB and INCLUDE behave the same way, which is
# why this is modelled generically rather than as a special case for PATH.
# ---------------------------------------------------------------------------
function Get-AttributeSeparator {
  # Windows joins list variables with ';'. POSIX uses ':' for PATH and friends.
  if ($env:OS -eq 'Windows_NT') { return ';' }
  return ':'
}

function Resolve-AttributeName {
  param($Parsed)
  return (Get-FlagValue -Parsed $Parsed -Name 'attr' -Default 'PATH')
}

function Get-AttributeEntries {
  param([string]$Name, $Target)
  $raw = [System.Environment]::GetEnvironmentVariable($Name, $Target)
  if ($null -eq $raw) { return , @() }
  $sep = Get-AttributeSeparator
  # The unary comma keeps an empty result an empty array instead of $null, so every caller can use
  # .Count and indexing without a null guard -- but callers must NOT wrap this in @(), which would
  # nest it into a one-element array and silently break their range checks.
  return , @($raw -split [regex]::Escape($sep) | Where-Object { $_ -ne '' })
}

function Join-AttributeEntries {
  param([string[]]$Entries)
  return ($Entries -join (Get-AttributeSeparator))
}

function Get-AttributeList {
  param($Parsed)
  # Which variables look like attributes at this scope, so a caller can discover them instead of
  # guessing names.
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $sep = Get-AttributeSeparator
  $items = New-Object System.Collections.ArrayList
  $known = @('PATH', 'PATHEXT', 'LIB', 'INCLUDE', 'MANPATH', 'CDPATH', 'PSModulePath')
  $vars = [System.Environment]::GetEnvironmentVariables($target)
  foreach ($key in ($vars.Keys | Sort-Object)) {
    $value = [string]$vars[$key]
    $isKnown = ($known -contains $key)
    $looksLikeList = ($value.Contains($sep))
    if (-not $isKnown -and -not $looksLikeList) { continue }
    $entries = @($value -split [regex]::Escape($sep) | Where-Object { $_ -ne '' })
    [void]$items.Add([ordered]@{
      name = $key
      known = $isKnown
      separator = $sep
      entryCount = $entries.Count
    })
  }
  return [ordered]@{ scope = (Get-ScopeName -Target $target); count = $items.Count; attributes = $items.ToArray() }
}

function Invoke-EnvironmentAttrList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  return (Get-AttributeList -Parsed $Parsed)
}

function Invoke-EnvironmentAttrGet {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $attr = Resolve-AttributeName -Parsed $Parsed
  $raw = [System.Environment]::GetEnvironmentVariable($attr, $target)
  if ($null -eq $raw) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("attribute '{0}' is not set at {1} scope" -f $attr, (Get-ScopeName -Target $target)))
  }
  # The name argument selects which variable's attribute is inspected; PATH-style attributes are
  # usually read from PATH itself, so a mismatched pair is reported rather than silently ignored.
  if ($name -ne $attr) {
    $other = [System.Environment]::GetEnvironmentVariable($name, $target)
    if ($null -eq $other) {
      throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
    }
  }
  $entries = Get-AttributeEntries -Name $attr -Target $target
  $items = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $entries.Count; $i++) {
    [void]$items.Add([ordered]@{ index = $i; value = $entries[$i] })
  }
  return [ordered]@{
    name = $attr
    requestedName = $name
    scope = (Get-ScopeName -Target $target)
    separator = (Get-AttributeSeparator)
    count = $items.Count
    entries = $items.ToArray()
  }
}

function Invoke-EnvironmentAttrAdd {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment attr add'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attr add' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attr add'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $entries = Get-AttributeEntries -Name $attr -Target $target
  foreach ($e in $entries) {
    if ($e -eq $value) {
      throw (New-OsError -Code 'E_EXISTS' -Message ("'{0}' already contains '{1}'" -f $attr, $value))
    }
  }
  $joined = Join-AttributeEntries -Entries (@($entries) + @($value))
  [System.Environment]::SetEnvironmentVariable($attr, $joined, $target)
  return [ordered]@{
    name = $attr; added = $value; scope = (Get-ScopeName -Target $target)
    count = $entries.Count + 1; operation = 'attr-add'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentAttrSet {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'environment attr set'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attr set' -Perm 'W' -Positionals 3
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $index = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1 -Name 'index') -Name 'index'
  $value = Get-Positional -Parsed $Parsed -Index 2 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attr set'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $entries = Get-AttributeEntries -Name $attr -Target $target
  if ($index -ge $entries.Count) {
    throw (New-OsError -Code 'E_RANGE' -Message ("index {0} is out of range for '{1}' (0..{2})" -f $index, $attr, [Math]::Max(0, $entries.Count - 1)))
  }
  $previous = $entries[$index]
  $entries[$index] = $value
  [System.Environment]::SetEnvironmentVariable($attr, (Join-AttributeEntries -Entries $entries), $target)
  return [ordered]@{
    name = $attr; index = $index; previous = $previous; value = $value
    scope = (Get-ScopeName -Target $target); count = $entries.Count; operation = 'attr-set'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentAttrDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'environment attr delete'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attr delete' -Perm 'W' -Positionals 1
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attr delete'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $indexText = Get-FlagValue -Parsed $Parsed -Name 'index' -Default $null
  $valueText = Get-FlagValue -Parsed $Parsed -Name 'value' -Default $null
  if (-not $indexText -and -not $valueText) {
    throw (New-OsError -Code 'E_USAGE' -Message 'environment attr delete needs --index or --value to say which entry to remove')
  }
  $entries = Get-AttributeEntries -Name $attr -Target $target
  $removed = $null
  if ($indexText) {
    $index = Get-IntArg -Text $indexText -Name 'index'
    if ($index -ge $entries.Count) {
      throw (New-OsError -Code 'E_RANGE' -Message ("index {0} is out of range for '{1}' (0..{2})" -f $index, $attr, [Math]::Max(0, $entries.Count - 1)))
    }
    $removed = $entries[$index]
    $kept = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $entries.Count; $i++) { if ($i -ne $index) { [void]$kept.Add($entries[$i]) } }
    $entries = $kept.ToArray()
  } else {
    $kept = New-Object System.Collections.ArrayList
    foreach ($e in $entries) {
      if ($e -eq $valueText -and $null -eq $removed) { $removed = $e; continue }
      [void]$kept.Add($e)
    }
    if ($null -eq $removed) {
      throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' does not contain '{1}'" -f $attr, $valueText))
    }
    $entries = $kept.ToArray()
  }
  if ($entries.Count -eq 0) {
    [System.Environment]::SetEnvironmentVariable($attr, $null, $target)
  } else {
    [System.Environment]::SetEnvironmentVariable($attr, (Join-AttributeEntries -Entries $entries), $target)
  }
  return [ordered]@{
    name = $attr; removed = $removed; scope = (Get-ScopeName -Target $target)
    count = $entries.Count; operation = 'attr-delete'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

# ---------------------------------------------------------------------------
# service.* - Windows Service Control Manager. Mutating verbs report elevation problems explicitly.
# ---------------------------------------------------------------------------
function Invoke-ServiceList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
  foreach ($svc in (Get-Service -ErrorAction SilentlyContinue | Sort-Object -Property Name)) {
    if ($filter -ne '' -and $filter -ne '*' -and $svc.Name -notlike $filter -and $svc.DisplayName -notlike $filter) { continue }
    [void]$items.Add([ordered]@{
      name = $svc.Name
      displayName = $svc.DisplayName
      status = $svc.Status.ToString()
      startType = $(try { $svc.StartType.ToString() } catch { $null })
    })
  }
  return [ordered]@{ count = $items.Count; services = $items.ToArray() }
}

function Invoke-ServiceQuery {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no service named '{0}'" -f $name))
  }
  $cim = Get-CimSafe -ClassName 'Win32_Service'
  $detail = $null
  foreach ($c in $cim) { if ($c.Name -eq $svc.Name) { $detail = $c; break } }
  return [ordered]@{
    name = $svc.Name
    displayName = $svc.DisplayName
    status = $svc.Status.ToString()
    startType = $(try { $svc.StartType.ToString() } catch { $null })
    canStop = $(if ($null -ne $detail) { $detail.AcceptStop } else { $null })
    startName = $(if ($null -ne $detail) { $detail.StartName } else { $null })
    pathName = $(if ($null -ne $detail) { $detail.PathName } else { $null })
  }
}

# ---------------------------------------------------------------------------
# permission.* - read the authorization file. The two mutating verbs are not implemented here on
# purpose: they belong to the consent delegate, which is the only writer (docs/permission-model.md).
# ---------------------------------------------------------------------------
function Get-PermissionFilePath {
  return (Join-Path $script:RootDir 'permission.json')
}

function Read-PermissionFile {
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ exists = $false; trusted = $true; document = $null; path = $path }
  }
  $raw = [System.IO.File]::ReadAllText($path, $script:NoBom)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    # An empty file is the documented initial state: no rules, defaults apply.
    return [ordered]@{ exists = $true; empty = $true; trusted = $true; document = $null; path = $path }
  }
  $doc = $null
  try { $doc = $raw | ConvertFrom-Json } catch {
    throw (New-OsError -Code 'E_PERMISSION_FILE_UNTRUSTED' -Message ("permission.json is not valid JSON: {0}" -f $_.Exception.Message) `
        -Hint 'a malformed authorization file must be fixed by the consent delegate, not by a verb')
  }
  $trusted = $true
  if ($null -ne $doc.PSObject.Properties['updatedBy']) {
    if ([string]$doc.updatedBy -ne 'consent-delegate') { $trusted = $false }
  }
  return [ordered]@{ exists = $true; empty = $false; trusted = $trusted; document = $doc; path = $path }
}

function Invoke-PermissionList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $state = Read-PermissionFile
  $rules = @()
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['rules']) {
    $rules = @($state.document.rules)
  }
  $items = New-Object System.Collections.ArrayList
  foreach ($r in $rules) {
    [void]$items.Add([ordered]@{
      id = $r.id
      verb = $r.verb
      decision = $r.decision
      grantedBy = $r.grantedBy
      grantedAt = $r.grantedAt
      expiresAt = $r.expiresAt
    })
  }
  return [ordered]@{
    path = $state.path
    exists = $state.exists
    empty = $(if ($null -ne $state.empty) { $state.empty } else { $false })
    trusted = $state.trusted
    count = $items.Count
    rules = $items.ToArray()
    aclEnforced = (Test-AclEnforced)
  }
}

function Invoke-PermissionAudit {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $limitText = Get-FlagValue -Parsed $Parsed -Name 'limit' -Default '50'
  $limit = Get-IntArg -Text $limitText -Name 'limit'
  $state = Read-PermissionFile
  $all = @()
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['audit']) {
    $all = @($state.document.audit)
  }
  $take = [Math]::Min($limit, $all.Count)
  $tail = @()
  if ($take -gt 0) { $tail = $all[($all.Count - $take)..($all.Count - 1)] }
  return [ordered]@{ path = $state.path; count = $tail.Count; entries = $tail }
}

function Invoke-PermissionQuery {
  param($Parsed)
  $verb = Get-Positional -Parsed $Parsed -Index 0 -Name 'verb'
  $target = Get-Positional -Parsed $Parsed -Index 1 -Name 'target' -Optional -Default '*'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $state = Read-PermissionFile
  $matched = $null
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['rules']) {
    foreach ($r in @($state.document.rules)) {
      $verbMatch = ($r.verb -eq $verb) -or ($r.verb.EndsWith('.*') -and $verb.StartsWith($r.verb.Substring(0, $r.verb.Length - 1)))
      if (-not $verbMatch) { continue }
      $value = '*'
      if ($null -ne $r.target -and $null -ne $r.target.PSObject.Properties['value']) { $value = [string]$r.target.value }
      if ($value -eq '*' -or $value -eq $target) { $matched = $r; break }
    }
  }
  $decision = 'ask'
  if ($null -ne $matched) { $decision = [string]$matched.decision }
  elseif (-not $state.trusted) { $decision = 'ask' }
  return [ordered]@{
    verb = $verb
    target = $target
    decision = $decision
    ruleId = $(if ($null -ne $matched) { $matched.id } else { $null })
    source = $(if ($null -ne $matched) { 'rule' } else { 'defaults' })
    trusted = $state.trusted
    aclEnforced = (Test-AclEnforced)
    fileExists = $state.exists
  }
}

function Test-AclEnforced {
  # Layer A is only real when the authorization file has an explicit deny for the automation
  # context. Until acl init has run, this must report false rather than implying protection.
  $flag = Join-Path $script:RootDir '.temporary\acl-state.json'
  if (-not (Test-Path -LiteralPath $flag)) { return $false }
  try {
    $doc = ([System.IO.File]::ReadAllText($flag, $script:NoBom) | ConvertFrom-Json)
    if ($null -eq $doc.PSObject.Properties['aclEnforced']) { return $false }
    return [bool]$doc.aclEnforced
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
function Get-PlatformCapabilities {
  $caps = [ordered]@{
    platform = 'win32'
    sessionType = 'windows'
    dpiAware = $false
    inputInjection = 'add-type-user32'
    clipboard = 'user32'
    screenshot = 'gdi32-bitblt'
    accessibility = 'unavailable'
    fonts = $null
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $caps['dpiAware'] = $true
    $caps['screens'] = [System.Windows.Forms.Screen]::AllScreens.Count
  } catch {
    $caps['screens'] = $null
  }
  return $caps
}

function Invoke-Selfcheck {
  param($Parsed)
  $verbs = New-Object System.Collections.ArrayList
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 4) { continue }
      [void]$verbs.Add([ordered]@{ verb = $f[0]; positionals = $f[1]; flags = $f[2]; perm = $f[3] })
    }
  }
  return [ordered]@{
    script = 'bin/dsh-os.ps1'
    powershell = $PSVersionTable.PSVersion.ToString()
    clrVersion = $PSVersionTable.CLRVersion.ToString()
    encodesPlainStdout = $true
    capabilities = Get-PlatformCapabilities
    verbCount = $verbs.Count
    verbs = $verbs.ToArray()
  }
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
function Get-VerbKey {
  param($Parsed)
  if ($Parsed.positionals.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os selfcheck   (lists the full verb table)')
  }
  # Verbs are one to three tokens deep: "selfcheck", "file charset", "file verify charset". A token
  # continues the verb only when it looks like a verb word (lowercase, no digits at the start) and
  # some verb in the table starts with the extended key. Membership is deliberately not required at
  # each step: "file.verify" is not itself a verb, but "file.verify.charset" is.
  $key = [string]$Parsed.positionals[0]
  $consumed = 1
  $known = Get-KnownVerbs
  while ($consumed -lt 3 -and $consumed -lt $Parsed.positionals.Length) {
    $token = [string]$Parsed.positionals[$consumed]
    if ($token.StartsWith('-')) { break }
    if ($token -notmatch '^[a-z][a-z0-9-]*$') { break }
    $candidate = $key + '.' + $token
    $extends = $false
    foreach ($knownVerb in $known.Keys) {
      if ($knownVerb -eq $candidate -or $knownVerb.StartsWith($candidate + '.')) { $extends = $true; break }
    }
    if (-not $extends) { break }
    $key = $candidate
    $consumed++
  }
  $tail = @()
  for ($i = $consumed; $i -lt $Parsed.positionals.Length; $i++) { $tail += $Parsed.positionals[$i] }
  return @{ key = $key; tail = $tail }
}

$script:KnownVerbs = $null

function Get-KnownVerbs {
  if ($null -ne $script:KnownVerbs) { return $script:KnownVerbs }
  $set = @{}
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 1) { continue }
      $set[$f[0]] = $true
    }
  }
  # selfcheck is a top-level verb with no group.
  $set['selfcheck'] = $true
  $set['text'] = $true
  $set['structure'] = $true
  $set['screenshot'] = $true
  $script:KnownVerbs = $set
  return $set
}

function Test-KnownVerb {
  param([string]$Key)
  return (Get-KnownVerbs).ContainsKey($Key)
}

function Invoke-Dispatch {
  param([string[]]$Argv)
  $Parsed = Parse-Arguments -Argv $Argv
  $script:Pretty = (Test-HasFlag -Parsed $Parsed -Name 'pretty')
  $script:Quiet = (Test-HasFlag -Parsed $Parsed -Name 'quiet')

  $target = Get-VerbKey -Parsed $Parsed
  $script:Verb = $target.key
  # Rebuild a positional list matching the verb table (group, optional subverb, then the rest).
  $tail = $target.tail
  $rebuilt = @()
  foreach ($t in $tail) { $rebuilt += $t }
  $inner = @{ positionals = $rebuilt; flags = $Parsed.flags }

  switch ($target.key) {
    'file.create' { return (Invoke-FileCreate -Parsed $inner) }
    'file.charset' { return (Invoke-FileCharset -Parsed $inner) }
    'file.encode' { return (Invoke-FileEncode -Parsed $inner) }
    'file.length' { return (Invoke-FileLength -Parsed $inner) }
    'file.information' { return (Invoke-FileInformation -Parsed $inner) }
    'file.list' { return (Invoke-FileList -Parsed $inner) }
    'file.delete' { return (Invoke-FileDelete -Parsed $inner) }
    'file.move' { return (Invoke-FileMove -Parsed $inner) }
    'file.copy' { return (Invoke-FileCopy -Parsed $inner) }
    'file.mkdir' { return (Invoke-FileMkdir -Parsed $inner) }
    'file.append' { return (Invoke-FileAppend -Parsed $inner) }
    'file.insert' { return (Invoke-FileInsert -Parsed $inner) }
    'file.view' { return (Invoke-FileView -Parsed $inner) }
    'selfcheck' { return (Invoke-Selfcheck -Parsed $Parsed) }

    # -- round 2: assertions and read-only queries (no authorization needed) --
    'file.verify.charset' { return (Invoke-FileVerifyCharset -Parsed $inner) }
    'file.verify.encoding' { return (Invoke-FileVerifyEncoding -Parsed $inner) }
    'file.verify.completion' { return (Invoke-FileVerifyCompletion -Parsed $inner) }
    'system.brand' { return (Invoke-SystemBrand -Parsed $inner) }
    'system.cpu' { return (Invoke-SystemCpu -Parsed $inner) }
    'system.gpu' { return (Invoke-SystemGpu -Parsed $inner) }
    'system.version' { return (Invoke-SystemVersion -Parsed $inner) }
    'system.info' { return (Invoke-SystemInfo -Parsed $inner) }
    'task.list' { return (Invoke-TaskList -Parsed $inner) }
    'task.query' { return (Invoke-TaskQuery -Parsed $inner) }
    'environment.list' { return (Invoke-EnvironmentList -Parsed $inner) }
    'environment.get' { return (Invoke-EnvironmentGet -Parsed $inner) }
    'environment.add' { return (Invoke-EnvironmentAdd -Parsed $inner) }
    'environment.set' { return (Invoke-EnvironmentSet -Parsed $inner) }
    'environment.delete' { return (Invoke-EnvironmentDelete -Parsed $inner) }
    'environment.attr.list' { return (Invoke-EnvironmentAttrList -Parsed $inner) }
    'environment.attr.get' { return (Invoke-EnvironmentAttrGet -Parsed $inner) }
    'environment.attr.add' { return (Invoke-EnvironmentAttrAdd -Parsed $inner) }
    'environment.attr.set' { return (Invoke-EnvironmentAttrSet -Parsed $inner) }
    'environment.attr.delete' { return (Invoke-EnvironmentAttrDelete -Parsed $inner) }
    'service.list' { return (Invoke-ServiceList -Parsed $inner) }
    'service.query' { return (Invoke-ServiceQuery -Parsed $inner) }
    'permission.query' { return (Invoke-PermissionQuery -Parsed $inner) }
    'permission.list' { return (Invoke-PermissionList -Parsed $inner) }
    'permission.audit' { return (Invoke-PermissionAudit -Parsed $inner) }

    default {
      throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message ("verb '{0}' is not implemented in this build" -f $target.key) `
          -Hint 'run: dsh-os selfcheck   (lists every verb, so the unsupported ones are visible rather than silent)')
    }
  }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$watch = [System.Diagnostics.Stopwatch]::StartNew()
# $script:Verb holds the resolved dotted verb once dispatch has parsed it; before that the raw first
# token is the best label available.
$script:Verb = $null
try {
  if ($args.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os selfcheck')
  }
  $script:Verb = [string]$args[0]
  $result = Invoke-Dispatch -Argv $args
  $watch.Stop()
  Write-Envelope -Verb $script:Verb -Result $result -ErrorObject $null -DurationMs ([int]$watch.ElapsedMilliseconds)
  exit 0
} catch {
  $watch.Stop()
  $code = Get-ErrorCode -ErrorRecord $_
  $message = $_.Exception.Message
  $hint = Get-ErrorHint -ErrorRecord $_
  # DSH_OS_TRACE=1 sends the failing statement and call stack to stderr, which is where every
  # human diagnostic belongs; stdout stays parseable.
  if ($env:DSH_OS_TRACE -eq '1') {
    [Console]::Error.WriteLine('--- dsh-os trace ---')
    [Console]::Error.WriteLine('code:     ' + $code)
    [Console]::Error.WriteLine('message:  ' + $message)
    [Console]::Error.WriteLine('position: ' + $_.InvocationInfo.PositionMessage)
    [Console]::Error.WriteLine('stack:    ' + ($_.ScriptStackTrace -replace "`n", ' <- '))
  }
  $errObj = New-ErrorObject -Code $code -Message $message -Hint $hint
  Write-Envelope -Verb $script:Verb -Result $null -ErrorObject $errObj -DurationMs ([int]$watch.ElapsedMilliseconds)
  exit (Get-ExitCode -Code $code)
}
