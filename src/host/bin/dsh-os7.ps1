# dsh-os7.ps1 - GENERATED FILE. Do not edit directly.
#
# Assembled by tools/build.ps1 from the PowerShell 7.6 modules named below, which are the source of
# truth. This is the PowerShell 7 artefact; bin/dsh-os.ps1 is the Windows PowerShell 5.1 one.
#
#   preamble.ps1
#   json.ps1
#   command.ps1
#   charset.ps1
#   native.ps1
#   paths.ps1
#   file.ps1
#   system.ps1
#   execute.ps1
#   task.ps1
#   environment.ps1
#   service.ps1
#   permission.ps1
#   window.ps1
#   dispatch.ps1
#   entry.ps1
#
# Requires PowerShell 7. It is a single self-contained file carrying UTF-8 with BOM, with no module
# resolution and no relative-path assumptions, for the same reasons as the 5.1 artefact. The two are
# kept apart because .NET 10 removes workarounds the 5.1 code cannot avoid (notably ArgumentList, which
# makes a hand-built Windows command line unnecessary) and adds capabilities it does not have.


# ===== preamble.ps1 ================================================

# requires -version 7.0
<#
  dsh-os - Windows implementation of the dsh-os atomic command surface, for PowerShell 7.

  This is the PowerShell 7.6 module set. bin/dsh-os.ps1 is the Windows PowerShell 5.1 one; the two are
  separate scripts rather than one script with runtime branches, because the runtimes differ in ways a
  branch cannot paper over cleanly. Most visibly, .NET Framework has no
  ProcessStartInfo.ArgumentList, so the 5.1 code has to build a Windows command line by hand; .NET 10
  has ArgumentList, so that entire hazard simply does not exist here.

  Contract: command.txt (authoritative), docs/os-spec.md (full spec), spec/verbs.tsv (verb table),
            spec/charsets.tsv (charset table).

  Design rules honoured here, carried over from the 5.1 implementation because they are properties of
  the contract rather than of the runtime:
    * Values arrive as separate argv elements. This script never re-parses a command line and never
      assembles one; arguments come from $args, which PowerShell populates without a shell layer.
    * Every argument is quoted by the caller. Both forms are accepted and normalised before dispatch:
        file create "./a.txt" "123" "utf-8-bom"
        file create path="./a.txt" content="123" charset="utf-8-bom"
    * File content is only ever read through [System.IO.File]::ReadAllBytes and written through
      [System.IO.File]::WriteAllBytes with an explicit Encoding object, so BOM and EOL handling is
      deliberate. Get-Content/Set-Content are never used for file content.
    * stdout carries exactly one UTF-8 (no BOM) JSON envelope. stderr carries human diagnostics only.
      Results are agent-first: structured fields, error.code authoritative, never human rendering.
    * Read-only verbs never require --allow; mutating verbs do.
    * Native calls use Add-Type P/Invoke only - no koffi, no third-party module.

  This file is one of the modules assembled into bin/dsh-os7.ps1 by tools/build.ps1. Edit the module,
  never the generated script. Modules are ASCII-only; the generated script carries the UTF-8 BOM.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Console encoding: pin UTF-8 without BOM on every stream before anything else.
#
# PowerShell 7 already defaults $OutputEncoding and the console to UTF-8 without a BOM, so unlike the
# 5.1 module this is belt-and-braces rather than the load-bearing fix it is there (where the default
# was ASCII). It is kept because the envelope is written as raw bytes below and the streams must agree
# with it, and because a host that has changed the default should not be able to change our output.
# ---------------------------------------------------------------------------
$script:NoBom = [System.Text.UTF8Encoding]::new($false)
$script:BomUtf8 = [System.Text.UTF8Encoding]::new($true)
try {
  [Console]::InputEncoding = $script:NoBom
  [Console]::OutputEncoding = $script:NoBom
  $OutputEncoding = $script:NoBom
} catch {
  # A redirected or hostless console can refuse these; the envelopes below still write raw UTF-8 bytes.
}

# ---------------------------------------------------------------------------
# Non-UTF8 code pages
#
# .NET (Core) does not ship the legacy code pages in its default encoding table, but PowerShell 7
# registers System.Text.Encoding.CodePages itself at startup. This was verified by probe on 7.6.6
# rather than assumed: GetEncoding already resolves 936, 54936, 950, 932, 1200, 1201, 28591 and 1252
# with no setup at all.
#
# There is therefore no code-page initialisation here. The charset module calls GetEncoding directly
# and reports a failure as E_CHARSET_UNKNOWN at the verb, which is the contract, rather than adding
# startup machinery for a case the runtime already handles.
# ---------------------------------------------------------------------------

# Layout: <repo>/src/host/bin/dsh-os7.ps1
#   HostDir = <repo>/src/host   - spec tables, command.txt, the other entry points
#   RepoDir = <repo>            - permission.json and the protected-path boundary
#
# The repository root is located by walking upward for a marker rather than by counting ".." levels
# from $MyInvocation. When this script is launched as a child process with -File, that path is RELATIVE
# to the caller's working directory, so Split-Path walks up from the CWD and silently produces a wrong
# root. That failure is invisible at runtime and would disarm the protected-path guard completely, so
# the marker search is the load-bearing part.
function Find-RepoDir {
  param([string]$StartDir)
  $dir = $StartDir
  for ($i = 0; $i -lt 8 -and $dir; $i++) {
    # A directory holding a package.json and src/host is the project root.
    if ((Test-Path -LiteralPath (Join-Path $dir 'package.json')) -and
        (Test-Path -LiteralPath (Join-Path $dir 'src/host'))) {
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

# ===== json.ps1 ====================================================

# Module: json.ps1 - the error model, the exit table, the JSON serialiser and the envelope writer.

# ---------------------------------------------------------------------------
# Error model. Every failure is an OsError; exit codes are a coarse class and
# error.code is authoritative (callers must branch on the code, never the message).
#
# The table's contents are part of the contract and are byte-for-byte the 5.1
# table: a caller maps error.code to the exit class it already knows.
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
  # A plain Exception carrying OsCode/Hint as added properties, exactly as in 5.1. A PowerShell class
  # deriving from Exception would type the error more strongly, but it would also change what the rest
  # of the surface sees when it inspects the exception; the added-property shape is the contract.
  $e = [System.Exception]::new($Message)
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
# JSON, serialised by hand and deliberately not through ConvertTo-Json.
#
# PowerShell 7 does have ConvertTo-Json and System.Text.Json, so this is a choice rather than a
# limitation: the golden tests compare the envelope byte for byte, so escaping and number formatting
# have to be fixed by us. ConvertTo-Json's escaping (\uXXXX only for some control characters) and its
# depth limit have both changed across versions (7.3 raised -Depth to 100, 7.5 changed BigInteger and
# enum handling), which is exactly the kind of drift this code cannot absorb. The hand-written
# serialiser below is the stable contract; keep it.
# ---------------------------------------------------------------------------
function ConvertTo-JsonString {
  param([string]$Value)
  if ($null -eq $Value) { return 'null' }
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append('"')
  foreach ($ch in $Value.ToCharArray()) {
    $c = [int][char]$ch
    # Dispatched on the CHARACTER CODE, not with `switch ($ch)` as the 5.1 module did.
    #
    # This is the single most dangerous consequence of the .NET 5 string-comparison change: on
    # PowerShell 7 an ignorable character compares EQUAL to almost anything, so the 5.1 switch's
    # `"`b" { ... }` case matched U+0001 and U+007F as well, and both were emitted as \b instead of
    # \u0001 / \u007f. Verified on 7.6.6: [string][char]1 -ceq [string][char]8 returned True.
    # `-match` and hashtable lookups are unaffected, but every -eq/-ceq/-like/-contains comparison in
    # this file would be, so the escaper compares integers and cannot be fooled.
    if ($c -eq 0x22) { [void]$sb.Append('\"') }
    elseif ($c -eq 0x5C) { [void]$sb.Append('\\') }
    elseif ($c -eq 0x08) { [void]$sb.Append('\b') }
    elseif ($c -eq 0x0C) { [void]$sb.Append('\f') }
    elseif ($c -eq 0x0A) { [void]$sb.Append('\n') }
    elseif ($c -eq 0x0D) { [void]$sb.Append('\r') }
    elseif ($c -eq 0x09) { [void]$sb.Append('\t') }
    elseif ($c -lt 0x20 -or $c -eq 0x7F) { [void]$sb.Append('\u' + $c.ToString('x4')) }
    elseif ($c -eq 0xFFFE -or $c -eq 0xFFFF) { [void]$sb.Append('\u' + $c.ToString('x4')) }
    else { [void]$sb.Append($ch) }
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
    # 'R' with the invariant culture, so a number never arrives with a locale's decimal separator.
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }
    return $d.ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $parts = [System.Collections.ArrayList]::new()
    foreach ($k in $Value.Keys) {
      [void]$parts.Add((ConvertTo-JsonString -Value ([string]$k)) + ':' + (ConvertTo-JsonValue -Value $Value[$k] -Depth ($Depth + 1)))
    }
    return '{' + ($parts -join ',') + '}'
  }
  if ($Value -is [System.Collections.IEnumerable]) {
    $parts = [System.Collections.ArrayList]::new()
    foreach ($item in $Value) { [void]$parts.Add((ConvertTo-JsonValue -Value $item -Depth ($Depth + 1))) }
    return '[' + ($parts -join ',') + ']'
  }
  # Anything else: project its properties in declaration order. [ordered] preserves that order, which
  # is why the envelope's field order is stable and the golden tests can compare bytes.
  $ordered = [ordered]@{}
  foreach ($p in $Value.PSObject.Properties) { $ordered[$p.Name] = $p.Value }
  return (ConvertTo-JsonValue -Value $ordered -Depth ($Depth + 1))
}

function ConvertTo-PrettyJson {
  param([string]$Json)
  # Cheap structural indenter for --pretty. Deliberately does not touch string contents.
  $sb = [System.Text.StringBuilder]::new()
  $indent = 0
  $inString = $false
  $escaped = $false
  for ($i = 0; $i -lt $Json.Length; $i++) {
    $ch = $Json[$i]
    $code = [int][char]$ch
    if ($inString) {
      [void]$sb.Append($ch)
      if ($escaped) { $escaped = $false }
      elseif ($code -eq 0x5C) { $escaped = $true }
      elseif ($code -eq 0x22) { $inString = $false }
      continue
    }
    # Character codes again, for the same reason as ConvertTo-JsonString: `switch ($ch)` can only be
    # trusted when its cases are not strings that an ignorable character could compare equal to.
    if ($code -eq 0x22) { $inString = $true; [void]$sb.Append($ch) }
    elseif ($code -eq 0x7B) { [void]$sb.Append($ch); $indent++; [void]$sb.Append("`n" + ('  ' * $indent)) }
    elseif ($code -eq 0x5B) { [void]$sb.Append($ch); $indent++; [void]$sb.Append("`n" + ('  ' * $indent)) }
    elseif ($code -eq 0x7D) { $indent--; [void]$sb.Append("`n" + ('  ' * $indent) + $ch) }
    elseif ($code -eq 0x5D) { $indent--; [void]$sb.Append("`n" + ('  ' * $indent) + $ch) }
    elseif ($code -eq 0x2C) { [void]$sb.Append($ch); [void]$sb.Append("`n" + ('  ' * $indent)) }
    elseif ($code -eq 0x3A) { [void]$sb.Append(': ') }
    elseif ($code -eq 0x20) { }
    else { [void]$sb.Append($ch) }
  }
  return $sb.ToString()
}

# $script:Pretty and $script:Quiet are written by Invoke-Dispatch; $script:Envelope is the shape this
# module's writer produces. All three are initialised explicitly because Set-StrictMode -Version
# Latest still throws on reading an unset $script: variable, in 7.x exactly as in 5.1.
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

  # Written through the raw stdout stream so the bytes are exactly what was produced: no console
  # encoding layer, and no BOM. This stays even though PowerShell 7 already defaults the console to
  # UTF-8 without a BOM - a host, a redirection or a parent process can still change that, and the
  # envelope's bytes are the contract.
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

# ===== command.ps1 =================================================

# Module: command.ps1 - argument parsing, named-argument folding, assertions and int coercion.

# ---------------------------------------------------------------------------
# Argument parsing.
#   positionals: every token that is not a flag and not a flag value.
#   flags:       --name, or --name value when the name is a known value-taking flag.
#   named:       name="value", folded into the positional list by Merge-NamedArguments below.
# Unknown flags are a usage error so typos cannot silently become positionals.
# ---------------------------------------------------------------------------

$script:ValueFlags = @(
  'encoding', 'eol', 'button', 'count', 'space', 'out', 'screen', 'format',
  'workdir', 'env', 'stdin', 'timeout', 'interval', 'method', 'pid',
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
  'no-numbers', 'with-numbers', 'force', 'hold', 'clearmodifiers', 'exact', 'absent', 'z-order', 'shell',
  'background', 'regex', 'recursive'
)

# Membership tests for flag and verb names are ORDINAL, not `-contains`.
#
# From .NET 5 an ignorable character compares equal to almost anything on PowerShell 7, so
# @('allow') -contains "allow`a" is True: a typo carrying a stray control byte would be accepted as
# --allow, and a name that is not in the table could select a flag that is. Verified on 7.6.6.
# The explicit loop is [string]::Equals(...Ordinal) because [System.Array]::IndexOf does not bind its
# 3-argument (Array, object, IComparer) overload from PowerShell here - the array arrives wrapped in
# PSObject - and this is the same shape dispatch.ps1 already uses for its verb-key scan.
function Test-FlagName {
  param($Set, [string]$Name)
  foreach ($item in $Set) {
    if ([string]::Equals($item, $Name, [System.StringComparison]::Ordinal)) { return $true }
  }
  return $false
}

function Parse-Arguments {
  param([string[]]$Argv)
  $positionals = [System.Collections.ArrayList]::new()
  # A plain hashtable stays the right container: PowerShell hashtables are case-insensitive, which is
  # what flag and named-argument lookup has always relied on, and the 5.1 code did the same.
  $flags = @{}
  $named = @{}
  $i = 0
  while ($i -lt $Argv.Length) {
    $tok = $Argv[$i]
    # if/elseif is kept here rather than switch. The 5.1 code needed it because `switch` on a STRING
    # iterates the string character by character in its wildcard/regex forms, so a token such as
    # "--allow" could match a pattern it should not. That is a PowerShell language behaviour, not a
    # 5.1 quirk, so it is unchanged in 7.6 and the if/elseif form remains the safer one.
    #
    # The two tests here are safe from the ignorable-character trap: StartsWith is an ordinal .NET
    # call, and `-match` was verified on 7.6.6 not to ignore control characters (unlike -eq, -ceq,
    # -like and -contains, which all do). The flag table lookups below are the ones that had to change.
    if ($tok.Length -ge 2 -and $tok.StartsWith('--')) {
      $name = $tok.Substring(2)
      if ($name.Length -eq 0) { throw (New-OsError -Code 'E_USAGE' -Message 'empty flag "--"' ) }
      if (-not (Test-FlagName -Set $script:KnownFlags -Name $name)) {
        # A typo such as --alow must not silently become a no-op: it would look like a successful
        # call that did nothing, which is exactly the class of failure this layer exists to remove.
        throw (New-OsError -Code 'E_USAGE' -Message ("unknown flag --{0}" -f $name) `
            -Hint 'run: dsh-os7 selfcheck   (lists every accepted flag)')
      }
      if (Test-FlagName -Set $script:ValueFlags -Name $name) {
        if ($i + 1 -ge $Argv.Length) {
          throw (New-OsError -Code 'E_USAGE' -Message ("flag --{0} requires a value" -f $name))
        }
        $val = $Argv[$i + 1]
        # One occurrence stores a string, a repeat stores an array of them. Callers depend on that
        # exact shape (a single --style is a string, several are an array), so the accumulation is
        # preserved as written rather than normalised to always-array.
        if ($flags.ContainsKey($name)) { $flags[$name] = @($flags[$name]) + $val } else { $flags[$name] = $val }
        $i += 2
      } else {
        $flags[$name] = $true
        $i += 1
      }
    } elseif ($tok -match '^([A-Za-z][A-Za-z0-9_-]*)=(.*)$') {
      # Named argument form: file create path="./a.txt" content="123" charset="utf-8-bom".
      # The value keeps whatever the caller passed after '=' (quotes are consumed by the shell or by
      # the caller's own quoting, exactly as for a positional).
      $key = $Matches[1]
      $val = $Matches[2]
      if ($named.ContainsKey($key)) {
        throw (New-OsError -Code 'E_USAGE' -Message ("named argument '{0}' was given more than once" -f $key))
      }
      $named[$key] = $val
      $i += 1
    } else {
      [void]$positionals.Add($tok)
      $i += 1
    }
  }
  return @{ positionals = $positionals.ToArray(); flags = $flags; named = $named }
}

# Declared positional names for a verb, in order, from spec/verbs.tsv.
$script:VerbParams = @{}

function Get-VerbParams {
  param([string]$VerbKey)
  if ($script:VerbParams.Count -eq 0) {
    $path = Join-Path $script:HostDir 'spec\verbs.tsv'
    if (Test-Path -LiteralPath $path) {
      foreach ($line in [System.IO.File]::ReadAllLines($path, $script:NoBom)) {
        if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
        $f = $line -split "`t"
        if ($f.Count -lt 2) { continue }
        $names = @()
        if ($f[1] -ne '-') { $names = @($f[1] -split '\|') }
        $script:VerbParams[$f[0]] = $names
      }
    }
  }
  # Return the array plainly and let the caller wrap it in @(). Doing BOTH (unary comma here plus
  # @() at the call site) nests the array, so $declared[0] becomes the whole array and every name
  # lookup misses. The @() at the call site is what protects against a single-name verb's list
  # being unwrapped into a bare string.
  if ($script:VerbParams.ContainsKey($VerbKey)) { return $script:VerbParams[$VerbKey] }
  return @()
}

# Merge named arguments into the positional list so every verb body can keep reading by index.
# Order comes from the verb table, so "file create charset=utf-8 path=x content=y" is equivalent to
# the positional form regardless of the order the names were written in.
function Merge-NamedArguments {
  param($Parsed, [string]$VerbKey)
  # The guard is on named arguments alone. An earlier version also entered this function for a
  # --strict-args flag and then rejected every argument that lacked literal quote characters; that
  # check could never work, because PowerShell and bash both consume an argument's quotes while
  # parsing, so a correctly quoted call is indistinguishable from an unquoted one by the time the
  # script sees it. The flag has been removed rather than left as a validator that rejects valid input.
  if ($Parsed.named.Count -eq 0) { return $Parsed }
  $declared = @(Get-VerbParams -VerbKey $VerbKey)
  if ($Parsed.named.Count -gt 0) {
    if ($declared.Count -eq 0) {
      throw (New-OsError -Code 'E_USAGE' -Message ("verb '{0}' takes no named arguments" -f $VerbKey) `
          -Hint 'named arguments are declared in spec/verbs.tsv')
    }
    # Start from the caller's positionals, then place each named value at its declared index.
    # [type]::new() rather than New-Object: the array length is known here and this is the direct
    # constructor call. Either form works; this is the house style for 7.6.
    $slots = [string[]]::new($declared.Count)
    $filled = [bool[]]::new($declared.Count)
    $posIdx = 0
    foreach ($name in $declared) {
      if ($posIdx -lt $Parsed.positionals.Length) {
        $slots[$posIdx] = [string]$Parsed.positionals[$posIdx]
        $filled[$posIdx] = $true
        $posIdx++
      }
    }
    if ($posIdx -lt $Parsed.positionals.Length) {
      throw (New-OsError -Code 'E_USAGE' -Message ("unexpected extra argument <{0}>" -f $Parsed.positionals[$posIdx]))
    }
    for ($k = 0; $k -lt $declared.Count; $k++) {
      $name = $declared[$k]
      if (-not $Parsed.named.ContainsKey($name)) { continue }
      if ($filled[$k]) {
        throw (New-OsError -Code 'E_USAGE' -Message ("'{0}' was given both positionally and by name" -f $name))
      }
      $slots[$k] = [string]$Parsed.named[$name]
      $filled[$k] = $true
    }
    foreach ($key in $Parsed.named.Keys) {
      if ($declared -notcontains $key) {
        throw (New-OsError -Code 'E_USAGE' -Message ("unknown named argument '{0}' for '{1}'" -f $key, $VerbKey) `
            -Hint ("accepted names, in order: {0}" -f ($declared -join ', ')))
      }
    }
    # Compact the slots: a gap can only appear past the end of the supplied values.
    $out = [System.Collections.ArrayList]::new()
    for ($k = 0; $k -lt $declared.Count; $k++) {
      if ($filled[$k]) { [void]$out.Add($slots[$k]) }
    }
    $Parsed.positionals = $out.ToArray()
  }
  return $Parsed
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
  # [string] on the way out is load-bearing: a flag given twice is an array (see Parse-Arguments), and
  # a caller expecting one value gets the joined form rather than an array that breaks its own parse.
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
        -Hint 'run: dsh-os7 selfcheck   (lists every verb with its arguments and flags)')
  }
}

function Assert-Allowed {
  param($Parsed, [string]$Verb, [string]$Perm, [int]$Positionals = -1)
  # -ne on a single-character permission code is safe: the trap is non-printable characters inside
  # longer compared strings, and 'W'/'R' are fixed literals from the verb table.
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
  # TryParse with the invariant default: an int argument is machine input, not localized text, and it
  # must not start accepting a locale's group separators now that the runtime parses them more widely.
  $ok = [int]::TryParse($Text, [ref]$out)
  if (-not $ok) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must be an integer, got '{1}'" -f $Name, $Text))
  }
  if (-not $AllowNegative -and $out -lt 0) {
    throw (New-OsError -Code 'E_TYPE' -Message ("<{0}> must not be negative, got {1}" -f $Name, $out))
  }
  return $out
}

# ===== charset.ps1 =================================================

# Module: charset.ps1 - the charset table, the BOM policy and the byte-level text model.

# Lazy cache for spec/charsets.tsv. Initialised here because Get-CharsetTable reads it
# before any assignment on the first call; the split moved the declaration away from the
# function that depends on it, and an unset $script: variable is a hard error under
# Set-StrictMode. That is still true in 7.6.
$script:Charsets = $null

# ---------------------------------------------------------------------------
# Ordinal comparisons for every charset-name test.
#
# From .NET 5 (so throughout PowerShell 7), culture-invariant string comparison IGNORES
# NON-PRINTABLE CONTROL CHARACTERS. Charset names come straight from the caller, so
# 'utf-8-bom' -eq "utf-8`a-bom" is TRUE on this runtime: a control character can make two
# different names compare equal and select the wrong encoding. Every comparison of an iana
# name in this module therefore goes through Test-SameText, which is ordinal and cannot be
# fooled. Verified on 7.6.6: '-eq' returned True for that pair while Ordinal returned False.
# ---------------------------------------------------------------------------
function Test-SameText {
  param([string]$Left, [string]$Right, [switch]$IgnoreCase)
  $mode = [System.StringComparison]::Ordinal
  if ($IgnoreCase) { $mode = [System.StringComparison]::OrdinalIgnoreCase }
  return [string]::Equals($Left, $Right, $mode)
}

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
      # An [ordered] entry, so the field order of anything that echoes a charset stays the table's
      # order rather than sorting alphabetically.
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
  # Ordinal, not -eq: a control character in the caller's name must not be able to turn "utf-8" into
  # "utf-8-bom" (see the note above Test-SameText).
  if ($Bom -and (Test-SameText -Left $key -Right 'utf-8')) { $key = 'utf-8-bom' }
  $table = Get-CharsetTable
  if (-not $table.ContainsKey($key)) {
    # The table is a PowerShell hashtable, which is case-insensitive, so the lowercased key still
    # resolves every mixed-case alias the caller may have used.
    #
    # The list is sorted ORDINALLY, not with the culture-aware default. The default comparison ignores
    # the hyphen and (from .NET 5) control characters, so it sorts 'utf16' before 'utf-8' on 7.6 where
    # 5.1 sorted 'utf-16' first: the same error would carry a differently ordered hint on each runtime.
    # Ordinal order is stable everywhere and cannot be perturbed by a locale.
    $names = [System.Collections.Generic.List[string]]::new()
    foreach ($k in $table.Keys) { if (-not $names.Contains($k)) { $names.Add([string]$k) } }
    $names.Sort([System.StringComparer]::Ordinal)
    throw (New-OsError -Code 'E_CHARSET_UNKNOWN' -Message ("unknown charset '{0}'" -f $Name) `
        -Hint ("supported names: {0}" -f ($names -join ', ')))
  }
  return $table[$key]
}

function Get-EncodingObject {
  param($Charset)
  # .NET 10 does not ship the legacy code pages in its default encoding table, but PowerShell 7
  # registers System.Text.Encoding.CodePages at startup, so the numeric code page in
  # spec/charsets.tsv resolves directly. Probed on 7.6.6 rather than assumed: 936, 54936, 950, 932,
  # 1200, 1201, 28591 and 1252 all resolve with no setup. There is therefore no code-page
  # registration machinery here - a genuine failure is reported as E_CHARSET_UNKNOWN, which is what
  # the contract says, instead of being papered over at startup.
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
  # shift_jis, latin1, ...). Returning a one-element wrapper keeps the array intact. This is
  # unchanged in 7.6.
  $bytes = [System.Collections.ArrayList]::new()
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
  #
  # if/elseif rather than the 5.1 `switch ($Policy)`: the subject is a caller-supplied STRING, and
  # `switch` on a string iterates it character by character in its wildcard/regex forms, which is a
  # PowerShell language behaviour rather than a 5.1 quirk. The comparisons are ordinal for the same
  # reason as the charset names above - a control character must not be able to select a policy.
  if (Test-SameText -Left $Policy -Right 'keep' -IgnoreCase) { return $SourceHasBom }
  if (Test-SameText -Left $Policy -Right 'add' -IgnoreCase) {
    if (Test-SameText -Left $Target.bom -Right '-') {
      throw (New-OsError -Code 'E_BOM_INVALID' -Message ("charset '{0}' has no byte order mark to add" -f $Target.iana))
    }
    return $true
  }
  if (Test-SameText -Left $Policy -Right 'strip' -IgnoreCase) { return $false }
  throw (New-OsError -Code 'E_USAGE' -Message ("--bom must be keep, strip or add, got '{0}'" -f $Policy))
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
  $out = [byte[]]::new($bom.Length + $Payload.Length)
  [Array]::Copy($bom, 0, $out, 0, $bom.Length)
  [Array]::Copy($Payload, 0, $out, $bom.Length, $Payload.Length)
  return , $out
}

function Test-IsValidEncoding {
  param([byte[]]$Bytes, $Charset)
  if ((Test-SameText -Left $Charset.iana -Right 'utf-8') -or (Test-SameText -Left $Charset.iana -Right 'utf-8-bom')) {
    # Only the throwing decoder detects a byte sequence that is not valid UTF-8; the default
    # replacement fallback returns U+FFFD and would accept anything. $false means "do not emit a BOM",
    # $true means "throw on invalid bytes".
    try { [void]([System.Text.UTF8Encoding]::new($false, $true)).GetString($Bytes); return $true } catch { return $false }
  }
  # Decode through Encoding.GetString rather than Decoder.GetChars: Windows PowerShell 5.1 could not
  # bind the 3-argument GetChars overload, so that probe threw for every candidate charset and the
  # detector silently fell through to latin1. GetString binds on every runtime, so the form is kept
  # rather than switched to the overload that now exists.
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
  # ReadAllBytes, never Get-Content: the byte sequence is the thing being modelled, and this is the
  # only read path that returns it unaltered.
  $bytes = [System.IO.File]::ReadAllBytes($Path)

  # BOM sniffing, longest signature first: FF FE 00 00 is UTF-32LE, not UTF-16LE, so the UTF-32LE test
  # has to win over the UTF-16LE one.
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

  # Binary detection on the sample that excludes the BOM. A NUL byte is only legitimate inside the
  # wide encodings, which is why the charset check comes first.
  $sampleLen = [Math]::Min(8192, [Math]::Max(0, $bytes.Length - $bomLen))
  for ($i = $bomLen; $i -lt $bomLen + $sampleLen; $i++) {
    if ($bytes[$i] -eq 0) {
      if ($null -eq $charset -or
          (-not (Test-SameText -Left $charset.iana -Right 'utf-16le') -and -not (Test-SameText -Left $charset.iana -Right 'utf-16be'))) {
        throw (New-OsError -Code 'E_BINARY_CONTENT' -Message ("cannot read '{0}' as text: the content looks binary" -f $Path))
      }
    }
  }

  $payload = [byte[]]::new($bytes.Length - $bomLen)
  [Array]::Copy($bytes, $bomLen, $payload, 0, $payload.Length)

  # No BOM: the charset is decided by trying the strict UTF-8 decoder, then GBK, then latin1, which
  # accepts any byte sequence. The order is the contract, not a heuristic to be reordered.
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
  # BOM choice: pick the object that matches the charset, then decide the preamble separately in
  # Get-WithBomBytes. Ordinal comparisons again, for the charset names.
  if (Test-SameText -Left $Doc.charset.iana -Right 'utf-8-bom') { $enc = [System.Text.UTF8Encoding]::new($true) }
  elseif (Test-SameText -Left $Doc.charset.iana -Right 'utf-8') { $enc = [System.Text.UTF8Encoding]::new($false) }
  else { $enc = Get-EncodingObject -Charset $Doc.charset }
  $payload = $enc.GetBytes($Text)
  return , (Get-WithBomBytes -Payload $payload -Charset $Doc.charset -WithBom $Doc.hasBom)
}

# ===== native.ps1 ==================================================

# Module: native.ps1 - the Add-Type P/Invoke block and the atomic file replace.
#
# Ported from powershell5.1/native.ps1 for bin/dsh-os7.ps1. The C# below is the 5.1 block, unchanged.
#
# Why the declarations did not have to change: they are not a 5.1 workaround, they are the declaration
# set itself (kernel32, user32, gdi32, advapi32, shcore), and .NET 10 still binds every export named
# here. This was measured rather than assumed - the block was extracted from this module and compiled
# in a 7.6.6 session, all 67 declared members bound, and SetProcessDPIAware, GetSystemMetrics,
# GetForegroundWindow, GetCursorPos and DescribeDenyState were called. There is therefore no "minimal
# C# fix" in this port, and no Visual Basic is introduced (Add-Type dropped VB support in 6.0).
#
# The changes are all PowerShell-level and are commented where they occur: the lost-create-race test in
# Write-Atomic (the 5.1 one matched a localized .NET message) and modern constructor syntax.

# Whether the Add-Type P/Invoke block has been compiled. Add-Type costs a few hundred
# milliseconds, so read-only verbs must never trigger it.
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
    public const uint GW_OWNER = 4;
    public const uint WM_CLOSE = 0x0010;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const int SW_MAXIMIZE = 3;

    // Window state, so a verb reports the state it observed rather than assuming the call worked.
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

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

    // -- security descriptors (layer A enforcement) ------------------------
    //
    // Used to give permission.json an explicit DENY for the automation context's write access. Read
    // side is what matters most: the enforcement strength is measured from the file's real DACL, so a
    // report can never claim protection the kernel is not applying.
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    public struct TRUSTEE
    {
        public IntPtr pMultipleTrustee;
        public int MultipleTrusteeOperation;
        public int TrusteeForm;
        public int TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct EXPLICIT_ACCESS
    {
        public int grfAccessPermissions;
        public int grfAccessMode;
        public int grfInheritance;
        public TRUSTEE Trustee;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetNamedSecurityInfoW(
        string objectName, int objectType, int securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint SetNamedSecurityInfoW(
        string objectName, int objectType, int securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint SetEntriesInAclW(int count, EXPLICIT_ACCESS[] entries, IntPtr oldAcl, out IntPtr newAcl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetExplicitEntriesFromAclW(IntPtr acl, out uint count, out IntPtr entries);

    [DllImport("advapi32.dll")]
    public static extern bool IsValidAcl(IntPtr acl);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern IntPtr GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    // LocalFree is exported by kernel32, NOT by advapi32. Declaring it under advapi32 produced
    // "Unable to find an entry point named 'LocalFree'", which surfaced only at cleanup time - after
    // the deny had already been applied - so the operation looked like a failure while having partly
    // succeeded.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr handle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

    public const int SE_FILE_OBJECT = 1;
    public const int DACL_SECURITY_INFORMATION = 4;
    public const int PROTECTED_DACL_SECURITY_INFORMATION = unchecked((int)0x80000000);
    public const int TRUSTEE_IS_SID = 0;
    public const int TRUSTEE_IS_WELL_KNOWN_GROUP = 5;
    public const int TRUSTEE_IS_USER = 1;
    public const int DENY_ACCESS = 3;
    public const int GRANT_ACCESS = 1;
    public const int NO_INHERITANCE = 0;
    public const int WRITE_ACCESS = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000100 | 0x00010000 | 0x00040000;
    public const int FILE_GENERIC_WRITE = 0x00120116;
    public const int DELETE = 0x00010000;
    public const int WRITE_DAC = 0x00040000;
    public const int WRITE_OWNER = 0x00080000;
    public const int ACCESS_DENIED_ACE_TYPE = 1;
    public const int ACCESS_ALLOWED_ACE_TYPE = 0;

    // One deny check plus one presence check, without exposing the descriptor layout to PowerShell:
    // parsing the ACL here keeps the ACE walk in the same place as the declarations it depends on.
    public static string DescribeDenyState(string path, string sid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (rc != 0) { return "ERROR:" + rc; }
        try
        {
            if (dacl == IntPtr.Zero) { return "NODACL"; }
            // Walk the ACL: ACE_HEADER is AceType(1) AceFlags(1) AceSize(2), then the mask, then the SID.
            int aceCount = Marshal.ReadInt16(dacl, 4);
            IntPtr p = (IntPtr)(dacl.ToInt64() + 8);
            try
            {
                IntPtr target = IntPtr.Zero;
                ConvertStringSidToSidW(sid, out target);
                if (target == IntPtr.Zero) { return "BADSID"; }
                try
                {
                    int targetLen = 8 + Marshal.ReadByte(target, 1) * 4;
                    for (int i = 0; i < aceCount; i++)
                    {
                        byte aceType = Marshal.ReadByte(p, 0);
                        int aceSize = Marshal.ReadInt16(p, 2);
                        int mask = Marshal.ReadInt32(p, 4);
                        IntPtr aceSid = (IntPtr)(p.ToInt64() + 8);
                        int sidLen = 8 + Marshal.ReadByte(aceSid, 1) * 4;
                        bool sameSid = sidLen == targetLen && CompareMemory(aceSid, target, sidLen);
                        // Only an explicit DENY matters for layer A; an allow for someone else does not
                        // protect anything.
                        if (sameSid && aceType == ACCESS_DENIED_ACE_TYPE && (mask & FILE_GENERIC_WRITE) != 0)
                        {
                            return "DENY";
                        }
                        p = (IntPtr)(p.ToInt64() + aceSize);
                    }
                }
                finally { if (target != IntPtr.Zero) LocalFree(target); }
            }
            finally { }
            return "NONE";
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    public static bool CompareMemory(IntPtr a, IntPtr b, int length)
    {
        for (int i = 0; i < length; i++)
        {
            if (Marshal.ReadByte(a, i) != Marshal.ReadByte(b, i)) { return false; }
        }
        return true;
    }

    // Apply an explicit DENY for one SID, preserving the existing DACL.
    public static string ApplyDeny(string path, string sid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (rc != 0) { return "GET:" + rc; }
        IntPtr sidPtr = IntPtr.Zero;
        IntPtr newAcl = IntPtr.Zero;
        try
        {
            if (!ConvertStringSidToSidW(sid, out sidPtr) || sidPtr == IntPtr.Zero) { return "BADSID"; }
            EXPLICIT_ACCESS[] ea = new EXPLICIT_ACCESS[1];
            ea[0].grfAccessPermissions = FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER;
            ea[0].grfAccessMode = DENY_ACCESS;
            ea[0].grfInheritance = NO_INHERITANCE;
            ea[0].Trustee.pMultipleTrustee = IntPtr.Zero;
            ea[0].Trustee.MultipleTrusteeOperation = 0;
            ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
            ea[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
            ea[0].Trustee.ptstrName = sidPtr;
            uint arc = SetEntriesInAclW(1, ea, dacl, out newAcl);
            if (arc != 0) { return "SETENTRIES:" + arc; }
            uint src = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
            if (src != 0) { return "SETINFO:" + src; }
            return "OK";
        }
        finally
        {
            if (newAcl != IntPtr.Zero) LocalFree(newAcl);
            if (sidPtr != IntPtr.Zero) LocalFree(sidPtr);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

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
  # -Language CSharp is stated rather than implied, and the source above is the 5.1 source verbatim:
  # the language was never the problem, and Add-Type no longer supports Visual Basic at all (6.0).
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
    # written target.
    #
    # The replace still goes through MoveFileExW. .NET 10 does have [System.IO.File]::Move(source,
    # destination, overwrite: true), but that overload cannot ask for MOVEFILE_WRITE_THROUGH, and
    # picking the route by whether the target happened to exist would make a write's durability depend
    # on the file's history instead of on the call.
    if (Test-Path -LiteralPath $Path) {
      if (-not (Invoke-MoveFileReplace -Source $tmp -Destination $Path)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot replace '{0}': MoveFileExW failed with win32 error {1}" -f $Path, $err))
      }
    } else {
      try {
        [System.IO.File]::Move($tmp, $Path)
      } catch [System.IO.IOException] {
        # The destination appeared between the Test-Path above and this move.
        #
        # The 5.1 code recognised this by matching the English text "already exists" in the exception
        # message. That test is locale-dependent, and under .NET 10.0.12 on a non-English Windows the
        # message is translated, so the match never fires and a lost race is reported as
        # E_PARTIAL_WRITE. What the message was standing in for is the condition tested here: if the
        # destination exists now, the move failed because of it. Otherwise the original exception is
        # rethrown and falls through to the E_PARTIAL_WRITE below, exactly as before.
        if (Test-Path -LiteralPath $Path) {
          throw (New-OsError -Code 'E_EXISTS' -Message ("cannot write '{0}': it already exists" -f $Path))
        }
        throw
      }
    }
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if ($_.Exception.PSObject.Properties['OsCode']) { throw }
    throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot write '{0}': {1}" -f $Path, $_.Exception.Message))
  }
}

# ===== paths.ps1 ===================================================

# Module: paths.ps1 - byte-boundary checks, path resolution and the protected-path boundary.

function Get-CharBoundaryCheck {
  param($Doc, [int]$Offset, [string]$Path)
  if ($Offset -lt 0 -or $Offset -gt $Doc.bytes.Length) {
    throw (New-OsError -Code 'E_RANGE' -Message ("offset {0} is out of range for '{1}' (0..{2})" -f $Offset, $Path, $Doc.bytes.Length))
  }
  if ($Offset -eq 0 -or $Offset -eq $Doc.bytes.Length) { return }
  $enc = $Doc.charset.iana
  # Ordinal comparisons on the charset name. From .NET 5, -eq ignores non-printable control
  # characters, so 'utf-8' -eq "utf-8`a" is True here; a control character in the observed name must
  # not be able to select the wrong boundary rule (or skip the check as an "unknown" encoding).
  if ([string]::Equals($enc, 'utf-8', [System.StringComparison]::Ordinal) -or
      [string]::Equals($enc, 'utf-8-bom', [System.StringComparison]::Ordinal)) {
    # A continuation byte is 10xxxxxx; an offset may not point at one.
    if (($Doc.bytes[$Offset] -band 0xC0) -eq 0x80) {
      throw (New-OsError -Code 'E_BOUNDARY' -Message ("offset {0} falls inside a multi-byte character in '{1}'" -f $Offset, $Path) `
          -Hint 'offsets are byte offsets and must land on a character boundary')
    }
    return
  }
  if ([string]::Equals($enc, 'utf-16le', [System.StringComparison]::Ordinal) -or
      [string]::Equals($enc, 'utf-16be', [System.StringComparison]::Ordinal)) {
    if ($Offset % 2 -ne 0) {
      throw (New-OsError -Code 'E_BOUNDARY' -Message ("offset {0} falls inside a UTF-16 code unit in '{1}'" -f $Offset, $Path))
    }
    return
  }
  if ([string]::Equals($enc, 'utf-32le', [System.StringComparison]::Ordinal) -or
      [string]::Equals($enc, 'utf-32be', [System.StringComparison]::Ordinal)) {
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
  # GetFullPath is still the normaliser: it collapses "." and ".." and makes the path absolute, so
  # the protected-path comparison below sees the same form for "./permission.json" and
  # "R:\project\deepseek-coordination\permission.json".
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
#
# Every entry point is listed, not just the ones this file belongs to. The 5.1 list named only the
# .ps1/.sh/.bat trio, and when dsh-os7.ps1 was added the 7.6 artefact was left UNPROTECTED - the
# protected-path case in the golden suite moved it into a sandbox and deleted it, which is how the gap
# was found. The script a surface is executed from is part of that surface's boundary, so a new entry
# point must be added here in the same change that creates it.
# ---------------------------------------------------------------------------
$script:ProtectedRelativePaths = @(
  'permission.json',
  'permission.json.bak',
  'src\host\command.txt',
  'src\host\bin\dsh-os.ps1',
  'src\host\bin\dsh-os7.ps1',
  'src\host\bin\dsh-os.sh',
  'src\host\bin\dsh-os.bat',
  'src\host\spec\verbs.tsv',
  'src\host\spec\charsets.tsv'
)

function Get-ProtectedPaths {
  $list = [System.Collections.ArrayList]::new()
  foreach ($rel in $script:ProtectedRelativePaths) {
    # [System.IO.Path]::Combine rather than Join-Path. Join-Path -ChildPath is string[] from 7.6, so
    # passing an array (or a value that becomes one) joins several children into one path instead of
    # stringifying it, and Join-Path also resolves wildcards in its -Path argument, which turns a
    # repository path containing '[' or '*' into a failure or a different path. Path.Combine is the
    # plain concatenation this boundary check needs.
    [void]$list.Add([System.IO.Path]::GetFullPath([System.IO.Path]::Combine($script:RootDir, $rel)))
  }
  return , $list.ToArray()
}

function Test-ProtectedPath {
  param([string]$Path)
  # Trailing dots and spaces are stripped by the Windows file system but not by string comparison,
  # so normalize them away before comparing. Without this, "permission.json." would open the same
  # file as "permission.json" while comparing unequal to it.
  $candidate = $Path
  while ($candidate.Length -gt 3 -and ($candidate.EndsWith('.') -or $candidate.EndsWith(' '))) {
    $candidate = $candidate.Substring(0, $candidate.Length - 1)
  }
  # Ordinal comparisons throughout this function. Case-insensitivity is wanted (Windows paths are
  # case-insensitive), but culture-invariant comparison would also IGNORE non-printable control
  # characters from .NET 5 on, so "permission.json" would compare equal to "permission`a.json" and a
  # different file would be protected by accident. OrdinalIgnoreCase has neither problem.
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

# ===== file.ps1 ====================================================

# Module: file.ps1 - file.*, file verify.*, file search.
#
# Ported from powershell5.1/file.ps1 for bin/dsh-os7.ps1. Every verb name, positional, flag, result
# field and error code is identical to the 5.1 module, because the envelope is the contract an agent
# parses. Only what the runtime requires changed:
#
#   * String comparisons that can see argument text or file text go through Test-SameText below, which
#     names OrdinalIgnoreCase explicitly. See the note there: -eq on strings is a linguistic
#     comparison, and .NET's linguistic comparisons do not treat every non-printable control character
#     as ordinary text.
#   * New-Object X(args) -> [X]::new(args), and $(if (c) { a } else { b }) -> c ? a : b. House style in
#     this module set; neither changes behaviour.
#   * file delete still reaches the recycle bin through Microsoft.VisualBasic.FileIO.FileSystem. That
#     assembly and API exist on .NET 10 - verified by probe on 7.6.6: Add-Type -AssemblyName
#     Microsoft.VisualBasic succeeds, and DeleteFile/DeleteDirectory with SendToRecycleBin remove the
#     target - so the 5.1 approach is kept rather than reinvented against SHFileOperation.
#
# Two 7.x breaking changes deliberately do not appear here, because this module cannot trip them:
# Select-String is not used (MatchInfo.LineNumber became UInt64 in 7.5), and Join-Path is never called
# with an array (its -ChildPath became string[] in 7.6).

# Text equality, with the comparison named.
#
# PowerShell's -eq/-ne on strings are linguistic comparisons, and .NET's linguistic comparisons do not
# treat every non-printable control character as ordinary text. Where that tolerance lives changed
# between the two runtimes, and it changed in the direction that breaks a verb: measured on this
# machine (culture zh-CN) with BEL = [char]7,
#     ('lf' + BEL) -eq 'lf'                    Windows PowerShell 5.1 -> False    7.6 -> True
#     ('Foo' + BEL + 'd') -eq 'Food'           5.1 -> False                        7.6 -> True
#     'Food'.IndexOf('Foo' + BEL + 'd')        5.1 -> -1                           7.6 -> 0
#     [string]::Equals('lf' + BEL, 'lf', Ordinal)   5.1 -> False                    7.6 -> False
# So an expected value carrying an embedded control character can compare equal to one without it on
# 7.6, and a verify verb would report a match that the 5.1 script it replaces would have refused.
# OrdinalIgnoreCase keeps the case-insensitivity -eq had and drops the linguistic behaviour, so the
# answer depends on the characters alone. It is also the comparison the 5.1 protected-path code already
# used.
function Test-SameText {
  param([string]$A, [string]$B)
  return [string]::Equals($A, $B, [System.StringComparison]::OrdinalIgnoreCase)
}

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
  # --eol is argument text, so the comparison is named: 'crlf' must not match "crlf`a".
  $eol = Get-FlagValue -Parsed $Parsed -Name 'eol' -Default $null
  if (Test-SameText $eol 'crlf') { $text = $text.Replace("`r`n", "`n").Replace("`n", "`r`n") }

  # charset.iana is a canonical table value, so no control character can reach this comparison; the
  # named form is used so every text comparison in this module is auditable the same way.
  $isUtf8Bom = Test-SameText $charset.iana 'utf-8-bom'
  $payload = $enc.GetBytes($text)
  $bytes = Get-WithBomBytes -Payload $payload -Charset $charset -WithBom $isUtf8Bom
  Write-Atomic -Path $path -Bytes $bytes
  return [ordered]@{
    path = $path; operation = 'create'; charset = $charset.iana
    bom = $isUtf8Bom; eol = ($eol ? $eol : 'lf')
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
  if (Test-SameText $target.iana 'utf-8-bom') { $enc = [System.Text.UTF8Encoding]::new($true) }
  elseif (Test-SameText $target.iana 'utf-8') { $enc = [System.Text.UTF8Encoding]::new($false) }
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
    type = ($item.PSIsContainer ? 'directory' : 'file')
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
  $entries = [System.Collections.ArrayList]::new()
  foreach ($c in Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue) {
    [void]$entries.Add([ordered]@{
      name = $c.Name
      type = ($c.PSIsContainer ? 'directory' : 'file')
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
  # Verified on 7.6.6: Microsoft.VisualBasic ships in the .NET 10 shared framework and FileSystem
  # still routes DeleteFile/DeleteDirectory through the shell's recycle bin, so the 5.1 route is kept.
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
    # Both sides are canonical table names, so this is uniformity rather than a live hazard: utf-8 is
    # accepted for a utf-8-bom file because the BOM is a separate property, not a different encoding.
    if (-not (Test-SameText $expect.iana $doc.charset.iana) -and
        -not ((Test-SameText $expect.iana 'utf-8') -and (Test-SameText $doc.charset.iana 'utf-8-bom'))) {
      throw (New-OsError -Code 'E_CHARSET_MISMATCH' -Message ("'{0}' is {1}, not {2}" -f $path, $doc.charset.iana, $expect.iana))
    }
  }
  # The appended text adopts the file's EOL convention so the result stays coherent.
  $add = $content
  if (Test-SameText $doc.eol 'crlf') { $add = $add.Replace("`r`n", "`n").Replace("`n", "`r`n") }
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
    # Canonical table names on both sides; see the note in Invoke-FileAppend.
    if (-not (Test-SameText $expect.iana $doc.charset.iana) -and
        -not ((Test-SameText $expect.iana 'utf-8') -and (Test-SameText $doc.charset.iana 'utf-8-bom'))) {
      throw (New-OsError -Code 'E_CHARSET_MISMATCH' -Message ("'{0}' is {1}, not {2}" -f $path, $doc.charset.iana, $expect.iana))
    }
  }
  Get-CharBoundaryCheck -Doc $doc -Offset $offset -Path $path

  # Splice on the byte level so the inserted bytes use the file's own encoding.
  $enc = Get-EncodingObject -Charset $doc.charset
  $payloadStart = 0
  if ($doc.hasBom) { $payloadStart = $doc.bomLen }
  $add = $content
  if (Test-SameText $doc.eol 'crlf') { $add = $add.Replace("`r`n", "`n").Replace("`n", "`r`n") }
  $addBytes = $enc.GetBytes($add)

  $head = [byte[]]::new($offset)
  [Array]::Copy($doc.bytes, 0, $head, 0, $offset)
  $tail = [byte[]]::new($doc.bytes.Length - $offset)
  [Array]::Copy($doc.bytes, $offset, $tail, 0, $tail.Length)
  $out = [byte[]]::new($head.Length + $addBytes.Length + $tail.Length)
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
    # Here the caller's charset is an assertion about the file; both names are canonical table values.
    if (-not (Test-SameText $expect.iana $doc.charset.iana)) {
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
  $slice = [byte[]]::new($length)
  [Array]::Copy($doc.bytes, $start, $slice, 0, $length)
  $enc = Get-EncodingObject -Charset $doc.charset
  $text = Remove-BomChar -Text ($enc.GetString($slice))

  $normalized = $text.Replace("`r`n", "`n")
  $lineValues = @($normalized -split "`n")

  # Agent-first output. The previous shape returned text with a "N: " prefix on every line, which is
  # a human rendering: a caller that wanted the file's actual bytes had to strip it back off, and a
  # caller that wanted a line number had to parse it. The result now carries the raw slice in `text`
  # and the same content as structured objects in `lines`, so neither has to be reverse-engineered.
  # --with-numbers restores the prefixed form for a human reading a terminal; it is never the default.
  $withNumbers = Test-HasFlag -Parsed $Parsed -Name 'with-numbers'
  $lineObjects = [System.Collections.ArrayList]::new()
  $rendered = [System.Collections.ArrayList]::new()
  $n = 1
  foreach ($l in $lineValues) {
    [void]$lineObjects.Add([ordered]@{ number = $n; text = $l })
    if ($withNumbers) { [void]$rendered.Add(('{0}: {1}' -f $n, $l)) } else { [void]$rendered.Add($l) }
    $n++
  }
  $body = $rendered -join "`n"

  $maxBytes = Get-FlagValue -Parsed $Parsed -Name 'max-bytes' -Default '1048576'
  $limit = Get-IntArg -Text $maxBytes -Name 'max-bytes'
  $charLimit = [int]$limit
  $truncated = $false
  if ($body.Length -gt $charLimit) {
    $body = $body.Substring(0, $charLimit)
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
    lineCount = $lineValues.Length
    lines = $lineObjects.ToArray()
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
  # A verify verb's whole job is to answer "do these match", so the comparison is named rather than
  # left linguistic (see Test-SameText).
  $ok = (Test-SameText $expected.iana $doc.charset.iana)
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
  $body = [byte[]]::new($doc.bytes.Length - $bomLen)
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
    $checks['sha256'] = [ordered]@{ expected = $want; observed = $hex; match = (Test-SameText $want $hex) }
    # A digest is compared character for character: -eq would tolerate a control character embedded in
    # the caller's --sha256 value and report a match for a digest that does not match.
    if (-not (Test-SameText $want $hex)) { $allMatch = $false }
  }

  $expectBom = Get-FlagValue -Parsed $Parsed -Name 'bom' -Default $null
  if ($expectBom) {
    $anyProvided = $true
    # --bom is argument text, compared explicitly: "tru`ae" must not count as true.
    $want = (Test-SameText $expectBom 'true') -or (Test-SameText $expectBom 'yes') -or (Test-SameText $expectBom '1')
    $checks['bom'] = [ordered]@{ expected = $want; observed = $doc.hasBom; match = ($want -eq $doc.hasBom) }
    if ($want -ne $doc.hasBom) { $allMatch = $false }
  }

  $expectEol = Get-FlagValue -Parsed $Parsed -Name 'eol' -Default $null
  if ($expectEol) {
    $anyProvided = $true
    $checks['eol'] = [ordered]@{ expected = $expectEol; observed = $doc.eol; match = (Test-SameText $expectEol $doc.eol) }
    if (-not (Test-SameText $expectEol $doc.eol)) { $allMatch = $false }
  }

  # With no expectation supplied, "completion" can only report the observed facts; saying
  # complete:false would be misleading, so the caller is told that no assertion was made.
  return [ordered]@{
    path = $doc.path
    assertion = 'completion'
    asserted = $anyProvided
    complete = ($anyProvided ? $allMatch : $null)
    charset = $doc.charset.iana
    bom = $doc.hasBom
    eol = $doc.eol
    size = $doc.size
    lines = $doc.lines
    checks = $checks
  }
}

# ---------------------------------------------------------------------------
# file.search - returns a JSON ARRAY of matches. The array is the top-level result value, not a
# wrapper object, so an agent can iterate it directly without knowing a key name.
# ---------------------------------------------------------------------------
function Invoke-FileSearch {
  param($Parsed)
  $dirText = Get-Positional -Parsed $Parsed -Index 0 -Name 'directory'
  $name = Get-Positional -Parsed $Parsed -Index 1 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $dir = Resolve-FullPath $dirText
  if (-not (Test-Path -LiteralPath $dir)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("cannot search '{0}': not found" -f $dir))
  }
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
    throw (New-OsError -Code 'E_NOT_A_DIR' -Message ("cannot search '{0}': not a directory" -f $dir))
  }
  $useRegex = Test-HasFlag -Parsed $Parsed -Name 'regex'
  $recursive = Test-HasFlag -Parsed $Parsed -Name 'recursive'
  $maxDepthText = Get-FlagValue -Parsed $Parsed -Name 'max-depth' -Default '0'
  $maxDepth = Get-IntArg -Text $maxDepthText -Name 'max-depth'
  $limitText = Get-FlagValue -Parsed $Parsed -Name 'limit' -Default '500'
  $limit = Get-IntArg -Text $limitText -Name 'limit'
  $maxBytesText = Get-FlagValue -Parsed $Parsed -Name 'max-bytes' -Default '0'
  $maxBytes = Get-IntArg -Text $maxBytesText -Name 'max-bytes'
  $typeFilter = Get-FlagValue -Parsed $Parsed -Name 'type' -Default '*'

  if ($useRegex) {
    try { $pattern = [System.Text.RegularExpressions.Regex]::new($name) } catch {
      throw (New-OsError -Code 'E_TYPE' -Message ("'{0}' is not a valid regular expression: {1}" -f $name, $_.Exception.Message))
    }
  }

  # A non-recursive search lists the given directory only; recursive honours --max-depth when given.
  $items = [System.Collections.ArrayList]::new()
  $candidates = [System.Collections.ArrayList]::new()
  if ($recursive -or $maxDepth -gt 0) {
    [void]$candidates.AddRange(@(Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue))
  } else {
    [void]$candidates.AddRange(@(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue))
  }

  $truncated = $false
  foreach ($item in $candidates) {
    if ($maxDepth -gt 0) {
      $rel = $item.FullName.Substring($dir.Length).TrimStart('\', '/')
      $depth = ($rel -split '[\\/]').Count
      if ($item.PSIsContainer) { $depth = $depth - 0 } else { $depth = $depth - 1 }
      if ($depth -gt $maxDepth) { continue }
    }
    $isDir = [bool]$item.PSIsContainer
    $itemType = ($isDir ? 'directory' : 'file')
    # --type is argument text: 'fi`ale' must not select files.
    if (-not (Test-SameText $typeFilter '*') -and -not (Test-SameText $typeFilter '') -and
        -not (Test-SameText $itemType $typeFilter)) { continue }
    $matched = $false
    if ($useRegex) { $matched = $pattern.IsMatch($item.Name) }
    else { $matched = ($item.Name.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) }
    if (-not $matched) { continue }
    $size = 0
    if (-not $isDir) { $size = [int64]$item.Length }
    if ($maxBytes -gt 0 -and $size -gt $maxBytes) { continue }
    [void]$items.Add([ordered]@{
      path = $item.FullName
      name = $item.Name
      type = $itemType
      size = $size
      modified = $item.LastWriteTimeUtc.ToString('o')
      relative = $item.FullName.Substring($dir.Length).TrimStart('\', '/')
    })
    if ($items.Count -ge $limit) { $truncated = $true; break }
  }

  # The array is the result. Truncation is reported alongside it so a caller can tell a complete
  # answer from a capped one without inferring it from the count.
  return [ordered]@{
    matches = $items.ToArray()
    count = $items.Count
    truncated = $truncated
    limit = $limit
    directory = $dir
    pattern = $name
    regex = $useRegex
    recursive = ($recursive -or $maxDepth -gt 0)
  }
}

# ===== system.ps1 ==================================================

# Module: system.ps1 - Windows system inventory.

function Get-CimSafe {
  param([string]$ClassName, [string]$Namespace = 'root\cimv2')
  # The unary comma is essential: PowerShell unwraps a returned one-element array into the element
  # itself, so callers doing $result[0].Property would work by luck while $result.Count throws.
  # Returning a wrapper keeps the type stable for zero, one and many rows.
  #
  # The CIM cmdlets are used rather than Get-WmiObject because the WMI v1 cmdlets were removed in
  # PowerShell 6. They are also the faster path on .NET, which serialises CIM instances natively.
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

# The runtime description, for the two places that report it.
#
# PowerShell 7 removed ClrVersion and BuildVersion from $PSVersionTable, so the 5.1 expression
# `$PSVersionTable.CLRVersion.ToString()` throws here. FrameworkDescription is the official
# replacement and reports something more useful anyway: ".NET 10.0.12" rather than a bare CLR version.
function Get-RuntimeDescription {
  return [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
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
    # The field keeps its name so a caller already parsing `clr` does not break, but on 7.x it carries
    # the framework description. `edition` is added alongside rather than replacing anything.
    clr = (Get-RuntimeDescription)
    edition = $PSVersionTable.PSEdition
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
    $principal = [System.Security.Principal.WindowsPrincipal]::new($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $null
  }
}

# ===== execute.ps1 =================================================

# Module: execute.ps1 - execute.command / synchronous / asynchronous / query / kill.
#
# Two different things live in this module and the distinction matters:
#
#   execute.command      takes an argv ARRAY and runs it with NO shell. Nothing is parsed, so a value
#                        containing spaces, quotes or shell metacharacters reaches the child exactly as
#                        given. This is the form to prefer whenever the caller knows the program.
#   execute.synchronous  take shell COMMAND STRINGS and run each through cmd.exe. The verb is named
#   execute.asynchronous "command" and the documented examples are quoted strings, so a shell is the
#                        contract there rather than a hazard.
#
# execute.query and execute.kill are process lookups by pid, kept next to the launch verbs because they
# are how a caller inspects and stops what it started.

function Invoke-OneShellCommand {
  param([string]$CommandLine, [string]$WorkDir, [int]$TimeoutMs, [string]$EncodingName)
  $enc = $script:NoBom
  if ($EncodingName -and $EncodingName -ne 'utf-8') {
    try { $enc = [System.Text.Encoding]::GetEncoding([int](Resolve-Charset -Name $EncodingName).dotnet) } catch { $enc = $script:NoBom }
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  # cmd.exe on Windows, /bin/sh elsewhere: the command line is a shell command by definition here.
  if ($env:OS -eq 'Windows_NT') {
    $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
    $psi.Arguments = '/d /s /c "' + $CommandLine + '"'
  } else {
    $psi.FileName = '/bin/sh'
    $psi.Arguments = '-c ' + $CommandLine
  }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # The encoding the child's output is DECODED with. Without these two lines $enc was computed and then
  # never used, so --encoding was inert: output was decoded with the runtime default and a caller asking
  # for gbk got mojibake with no indication why. Setting the stream encodings is what makes the flag
  # mean something.
  $psi.StandardOutputEncoding = $enc
  $psi.StandardErrorEncoding = $enc
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }

  $started = [DateTime]::UtcNow
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $exited = $proc.WaitForExit($TimeoutMs)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(2000) | Out-Null } catch { }
  }
  $outText = ''
  $errText = ''
  try { $outText = $outTask.Result } catch { $outText = '' }
  try { $errText = $errTask.Result } catch { $errText = '' }
  $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  $exitCode = $(if ($exited) { $proc.ExitCode } else { $null })
  return [ordered]@{
    command = $CommandLine
    exitCode = $exitCode
    timedOut = (-not $exited)
    durationMs = $duration
    stdout = $outText
    stderr = $errText
  }
}

function Invoke-ExecuteBatch {
  param($Parsed, [bool]$Sequential)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb $(if ($Sequential) { 'execute synchronous' } else { 'execute asynchronous' })
  Assert-Allowed -Parsed $Parsed -Verb $(if ($Sequential) { 'execute synchronous' } else { 'execute asynchronous' }) -Perm 'W'
  $commands = @($Parsed.positionals)
  $workdir = Get-FlagValue -Parsed $Parsed -Name 'workdir' -Default $null
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '120000'
  $timeoutMs = Get-IntArg -Text $timeoutText -Name 'timeout'
  $encodingName = Get-FlagValue -Parsed $Parsed -Name 'encoding' -Default 'utf-8'

  $results = New-Object System.Collections.ArrayList
  $started = [DateTime]::UtcNow
  if ($Sequential) {
    # Stop at the first non-zero exit so a caller does not run later steps on a broken precondition.
    foreach ($cmd in $commands) {
      $one = Invoke-OneShellCommand -CommandLine $cmd -WorkDir $workdir -TimeoutMs $timeoutMs -EncodingName $encodingName
      [void]$results.Add($one)
      if ($one.exitCode -ne 0) { break }
    }
  } else {
    # Start every command first, then collect. Waiting inside the start loop would make it sequential.
    $running = New-Object System.Collections.ArrayList
    foreach ($cmd in $commands) {
      $psi = [System.Diagnostics.ProcessStartInfo]::new()
      if ($env:OS -eq 'Windows_NT') {
        $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
        $psi.Arguments = '/d /s /c "' + $cmd + '"'
      } else {
        $psi.FileName = '/bin/sh'
        $psi.Arguments = '-c ' + $cmd
      }
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      if ($workdir) { $psi.WorkingDirectory = $workdir }
      $p = [System.Diagnostics.Process]::Start($psi)
      [void]$running.Add([pscustomobject]@{
        command = $cmd; proc = $p
        outTask = $p.StandardOutput.ReadToEndAsync()
        errTask = $p.StandardError.ReadToEndAsync()
        started = [DateTime]::UtcNow
      })
    }
    foreach ($entry in $running) {
      $exited = $entry.proc.WaitForExit($timeoutMs)
      if (-not $exited) {
        try { $entry.proc.Kill() } catch { }
        try { $entry.proc.WaitForExit(2000) | Out-Null } catch { }
      }
      $outText = ''; $errText = ''
      try { $outText = $entry.outTask.Result } catch { }
      try { $errText = $entry.errTask.Result } catch { }
      [void]$results.Add([ordered]@{
        command = $entry.command
        exitCode = $(if ($exited) { $entry.proc.ExitCode } else { $null })
        timedOut = (-not $exited)
        durationMs = [int]([DateTime]::UtcNow - $entry.started).TotalMilliseconds
        stdout = $outText
        stderr = $errText
      })
    }
  }
  $total = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  $failed = 0
  foreach ($r in $results) { if ($r['exitCode'] -ne 0) { $failed++ } }
  return [ordered]@{
    mode = $(if ($Sequential) { 'synchronous' } else { 'asynchronous' })
    requested = $commands.Length
    executed = $results.Count
    failed = $failed
    allSucceeded = ($failed -eq 0 -and $results.Count -eq $commands.Length)
    totalDurationMs = $total
    results = $results.ToArray()
  }
}

# ---------------------------------------------------------------------------
# execute.command - an argv ARRAY run with NO shell.
#
# The distinction from the batch verbs above is the whole point of this verb: the batch verbs take
# command STRINGS and run them through cmd.exe, while this one takes argv and parses nothing, so a
# value containing spaces, quotes or metacharacters reaches the child exactly as given.
#
# THE 5.1 MODULE NEEDED TWO HELPER FUNCTIONS HERE THAT DO NOT EXIST IN THIS PORT. .NET Framework has no
# ProcessStartInfo.ArgumentList, so the only way to pass several arguments was to build ONE command
# line string by hand and implement CommandLineToArgvW's quoting rules -- doubling backslashes before a
# quote and at the end of an argument, escaping embedded quotes. That was the single largest source of
# subtle wrongness in the 5.1 code: an argument ending in a backslash would swallow its own closing
# quote and silently join the next argument.
#
# .NET 10 has ArgumentList, so each argument is handed over separately and the runtime does the quoting.
# The helpers are deliberately not carried over.
# ---------------------------------------------------------------------------
function Invoke-OneArgvCommand {
  param(
    [string[]]$Argv,
    [string]$WorkDir,
    [int]$TimeoutMs,
    [string]$StdinText,
    [hashtable]$Environment
  )
  if ($Argv.Count -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no program was given')
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Argv[0]
  for ($i = 1; $i -lt $Argv.Count; $i++) {
    # Each element becomes its own argv entry in the child. Note that ArgumentList is only consulted
    # when Arguments has not been set; the two are mutually exclusive, which is why nothing here ever
    # assigns Arguments.
    [void]$psi.ArgumentList.Add([string]$Argv[$i])
  }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($StdinText) { $psi.RedirectStandardInput = $true }
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
  if ($null -ne $Environment) {
    foreach ($k in $Environment.Keys) { $psi.Environment[[string]$k] = [string]$Environment[$k] }
  }

  $started = [DateTime]::UtcNow
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    # A program that cannot be started is E_NOT_FOUND rather than an internal error: the caller named
    # something that is not there, which is actionable.
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("could not start '{0}': {1}" -f $Argv[0], $_.Exception.Message) `
        -Hint 'the program must be an executable on PATH or an absolute path to one')
  }

  # Both pipes are drained concurrently. Reading one to completion before the other deadlocks as soon
  # as the unread pipe fills its buffer, which is how a captured command appears to hang forever.
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if ($StdinText) {
    try {
      $proc.StandardInput.Write($StdinText)
      $proc.StandardInput.Close()
    } catch {
      # A child that never reads stdin makes this fail; that is not a reason to fail the call.
    }
  }
  $exited = $proc.WaitForExit($TimeoutMs)
  $outText = ''
  $errText = ''
  if (-not $exited) {
    # The whole process TREE is killed, not just the direct child.
    #
    # A grandchild inherits the stdout and stderr handles, so it keeps the pipes open even after the
    # direct child dies. That has two effects, and both were observed: this function blocked on the
    # output await until the grandchild exited on its own, and - because the pipes are the ones this
    # script was itself launched with - the CALLER's own process stayed alive waiting for the pipe to
    # close. A 1.2s timeout on `cmd /c ping -n 20` therefore took 19-20 SECONDS end to end.
    # `taskkill /T` terminates the descendants, which closes the handles and lets the timeout mean what
    # it says.
    try {
      $kill = [System.Diagnostics.ProcessStartInfo]::new()
      $kill.FileName = "$env:SystemRoot\System32\taskkill.exe"
      $kill.Arguments = ('/T /F /PID ' + $proc.Id)
      $kill.UseShellExecute = $false
      $kill.CreateNoWindow = $true
      $kill.RedirectStandardOutput = $true
      $kill.RedirectStandardError = $true
      $killer = [System.Diagnostics.Process]::Start($kill)
      [void]$killer.WaitForExit(5000)
    } catch {
      # Falling back to the single-process kill is still better than leaving it running.
      try { $proc.Kill() } catch { }
    }
    try { $proc.WaitForExit(2000) | Out-Null } catch { }
    # Drain what was captured, with a bound: the pipes normally close once the tree is gone, but this
    # must not become the thing that hangs if a descendant somehow survives.
    try {
      if ($outTask.Wait(2000)) { $outText = $outTask.Result }
    } catch { }
    try {
      if ($errTask.Wait(2000)) { $errText = $errTask.Result }
    } catch { }
    $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
    return [ordered]@{
      argv = $Argv
      exitCode = $null
      timedOut = $true
      durationMs = $duration
      stdout = $outText
      stderr = $errText
      shell = $false
      note = 'killed at the deadline together with its descendants, so no orphan keeps the output pipes open'
    }
  }
  try { $outText = $outTask.Result } catch { }
  try { $errText = $errTask.Result } catch { }
  $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds

  return [ordered]@{
    argv = $Argv
    exitCode = $proc.ExitCode
    timedOut = $false
    durationMs = $duration
    stdout = $outText
    stderr = $errText
    shell = $false
  }
}

function Invoke-ExecuteCommand {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'execute command'
  Assert-Allowed -Parsed $Parsed -Verb 'execute command' -Perm 'W'
  $argv = @($Parsed.positionals)
  $workdir = Get-FlagValue -Parsed $Parsed -Name 'workdir' -Default $null
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '120000'
  $timeout = Get-IntArg -Text $timeoutText -Name 'timeout'
  $stdinText = Get-FlagValue -Parsed $Parsed -Name 'stdin' -Default $null

  $environment = $null
  $envPairs = @()
  if ($Parsed.flags.ContainsKey('env')) {
    # --env may be repeated; Get-FlagValue keeps only the last, so the raw flag value is used instead.
    $envPairs = @($Parsed.flags['env'])
  }
  if ($envPairs.Count -gt 0) {
    $environment = @{}
    foreach ($pair in $envPairs) {
      $eq = $pair.IndexOf('=')
      if ($eq -lt 1) {
        throw (New-OsError -Code 'E_USAGE' -Message ("--env expects NAME=value, got '{0}'" -f $pair))
      }
      $environment[$pair.Substring(0, $eq)] = $pair.Substring($eq + 1)
    }
  }

  # --shell switches to the batch form on purpose. Silently becoming a shell is refused, because the
  # difference between argv and a command string is precisely what this verb is about.
  if (Test-HasFlag -Parsed $Parsed -Name 'shell') {
    $one = Invoke-OneShellCommand -CommandLine ($argv -join ' ') -WorkDir $workdir -TimeoutMs $timeout -EncodingName 'utf-8'
    $one['shell'] = $true
    $one['note'] = '--shell ran this through a shell; the argv array was joined into one command line'
    return $one
  }

  if (Test-HasFlag -Parsed $Parsed -Name 'background') {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'execute command --background is not supported here' `
        -Hint 'use task launch to start something without waiting for it')
  }

  $result = Invoke-OneArgvCommand -Argv $argv -WorkDir $workdir -TimeoutMs $timeout -StdinText $stdinText -Environment $environment
  if ($result.timedOut) {
    # A timeout is a typed failure, not a successful call with a null exit code: the caller asked for a
    # command to run and did not get that.
    throw (New-OsError -Code 'E_TIMEOUT' -Message ("'{0}' did not finish within {1}ms" -f $argv[0], $timeout) `
        -Hint ("captured so far: stdout={0} bytes, stderr={1} bytes" -f $result.stdout.Length, $result.stderr.Length))
  }
  return $result
}

# ---------------------------------------------------------------------------
# execute.query / execute.kill - process lookups by pid.
#
# These live beside the launch verbs because they are how a caller inspects and stops what it started.
# execute.kill delegates to the task.kill implementation so the two cannot drift apart.
# ---------------------------------------------------------------------------
function Invoke-ExecuteQuery {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'execute query'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $targetPid = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0 -Name 'pid') -Name 'pid'
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no process with pid {0}" -f $targetPid))
  }
  $path = $null
  try { $path = $proc.Path } catch { }
  return [ordered]@{
    pid = $proc.Id
    name = $proc.ProcessName
    path = $path
    memoryBytes = [int64]$proc.WorkingSet64
    responding = [bool]$proc.Responding
    handleCount = $proc.HandleCount
    threadCount = $proc.Threads.Count
  }
}

function Invoke-ExecuteKill {
  param($Parsed)
  return (Invoke-TaskKill -Parsed $Parsed)
}

# ===== task.ps1 ====================================================

# Module: task.ps1 - process list / query / show / kill / launch.

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

  # The callback delegate is held in a SCRIPT-SCOPE variable for the duration of the enumeration. As a
  # local it could be collected while the native enumerator still held its function pointer, and the
  # process would crash rather than return an error. This is why $script:EnumWindowsResult exists rather than a
  # closure over a local.
  $script:EnumWindowsResult = New-Object System.Collections.ArrayList
  $callback = [DshNative+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$param)
    try {
      $wpid = [uint32]0
      [void][DshNative]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
      if ($wpid -eq $targetPid -and [DshNative]::IsWindowVisible($hWnd)) {
        [void]$script:EnumWindowsResult.Add($hWnd)
      }
    } catch {
      # A window can be destroyed mid-enumeration; skipping it is correct.
    }
    return $true
  }
  try {
    [void][DshNative]::EnumWindows($callback, [IntPtr]::Zero)
  } finally {
    $found = $script:EnumWindowsResult
    $script:EnumWindowsResult = $null
  }

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

# Quote one argument for a Windows command line, per the rules CommandLineToArgvW parses with.
#
# THIS HELPER IS STILL NEEDED HERE, unlike in execute.ps1, and the reason is specific: WMI's
# Win32_Process.Create takes a COMMAND LINE STRING, not an argv array, so there is no ArgumentList to
# hand the arguments to on that path. The WMI path is the one that matters, because a process started
# by [Process]::Start does not outlive this PowerShell process (see below). On the ProcessStartInfo
# fallback below, ArgumentList IS used.
#
# The rules: a backslash is only special before a double quote or at the end of an argument, where it
# must be doubled; an embedded quote is escaped with a backslash. Getting this wrong is the classic
# Windows bug where an argument ending in a backslash swallows its own closing quote.
function ConvertTo-WindowsArgument {
  param([string]$Argument)
  if ($Argument -eq '') { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append('"')
  $backslashes = 0
  foreach ($ch in $Argument.ToCharArray()) {
    if ($ch -eq '\') { $backslashes++; continue }
    if ($ch -eq '"') {
      [void]$sb.Append('\' * ($backslashes * 2 + 1))
      [void]$sb.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
    [void]$sb.Append($ch)
  }
  if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

# task launch <path> [--args a b c] [--workdir dir]
#
# Starts a program and returns its pid WITHOUT waiting for it. That is the difference from
# execute.command, which blocks and captures output: this verb answers "did it start", and the caller
# then uses execute.query or task.show to follow it up.
#
# The path is a real path, never a shell string, so a program in a directory with spaces starts
# correctly. When the path names a document rather than an executable, ShellExecute is used so the
# registered handler opens it, and the result says so, because the pid of a document handler is not the
# document.
function Invoke-TaskLaunch {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'task launch'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'task launch' -Perm 'W'
  $target = Get-Positional -Parsed $Parsed -Index 0
  $workdir = Get-FlagValue -Parsed $Parsed -Name 'workdir' -Default $null
  $childArgs = @()
  if ($Parsed.flags.ContainsKey('args')) { $childArgs = @($Parsed.flags['args']) }

  # A relative path is resolved against the working directory first, because "launch ./tool.exe" must
  # mean the file next to the caller rather than whatever resolves on PATH.
  $resolved = $target
  $exists = Test-Path -LiteralPath $target -PathType Leaf
  if ($exists) {
    $resolved = (Resolve-Path -LiteralPath $target).ProviderPath
    Assert-NotProtectedPath -Path $resolved
  } elseif ($target -match '[\\/]') {
    # It looks like a path but is not there: that is a not-found, not a PATH lookup.
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no such file: {0}" -f $target) `
        -Hint 'an argument containing a slash or backslash is treated as a path')
  }

  $isExecutable = $exists -and ($resolved -match '\.(exe|com|bat|cmd)$')

  if ($exists -and -not $isExecutable) {
    # A document: hand it to its registered handler.
    try {
      $quotedArgs = @($childArgs | ForEach-Object { ConvertTo-WindowsArgument -Argument $_ }) -join ' '
      $shell = New-Object -ComObject Shell.Application
      $shell.ShellExecute($resolved, $quotedArgs, $(if ($workdir) { $workdir } else { (Split-Path -Parent $resolved) }), 'open', 1)
      return [ordered]@{
        path = $resolved
        opened = $true
        mode = 'shell-execute'
        pid = $null
        note = 'a document was handed to its registered handler; no pid is reported because the handler is a separate process'
      }
    } catch {
      throw (New-OsError -Code 'E_IO' -Message ("the document could not be opened: {0}" -f $_.Exception.Message))
    }
  }

  # Started through WMI rather than with [Process]::Start, because a process started by Start() does
  # NOT outlive this one: PowerShell runs its child processes inside a job object that is terminated
  # when PowerShell exits, so a launched program was being killed the moment the verb returned. The verb
  # reported "started: true" and the process was already gone. WMI asks a service that outlives this
  # process to create it, so it survives.
  $procId = $null
  $via = 'wmi'
  try {
    $commandLine = '"' + $resolved + '"'
    if ($childArgs.Count -gt 0) {
      $commandLine += ' ' + (@($childArgs | ForEach-Object { ConvertTo-WindowsArgument -Argument $_ }) -join ' ')
    }
    $wmiArgs = @{ CommandLine = $commandLine }
    # Win32_Process.Create takes the working directory as a parameter; there is no way to set the
    # environment this way, which is the trade for the process actually surviving.
    if ($workdir) { $wmiArgs['CurrentDirectory'] = $workdir }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $wmiArgs -ErrorAction Stop
    if ($created.ReturnValue -ne 0) {
      throw (New-OsError -Code 'E_IO' -Message ("Win32_Process.Create returned {0}" -f $created.ReturnValue))
    }
    $procId = [int]$created.ProcessId
  } catch {
    # Fall back to Start() so a machine without WMI still launches something, but say which path was
    # used, because the process may not outlive this one and the caller needs to know that.
    try {
      $psi = [System.Diagnostics.ProcessStartInfo]::new()
      $psi.FileName = $resolved
      # On this path ArgumentList IS available, so the arguments are handed over separately and the
      # runtime quotes them. This is the fallback rather than the main path only because a process
      # started this way may be killed with this process.
      foreach ($a in $childArgs) { [void]$psi.ArgumentList.Add([string]$a) }
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $false
      if ($workdir) { $psi.WorkingDirectory = $workdir }
      $proc = [System.Diagnostics.Process]::Start($psi)
      $procId = $proc.Id
      $via = 'process-start'
    } catch {
      throw (New-OsError -Code 'E_NOT_FOUND' -Message ("could not start '{0}': {1}" -f $resolved, $_.Exception.Message))
    }
  }

  # Reported as started, with the pid, and explicitly NOT as healthy: this verb does not wait, so it
  # cannot know whether the program went on to fail.
  $result = [ordered]@{
    path = $resolved
    pid = $procId
    started = $true
    mode = 'executable'
    launchedVia = $via
    waitedForExit = $false
    note = 'the process was started but not waited for; use execute query or task show to follow it up'
  }
  if ($via -eq 'process-start') {
    $result['note'] = 'started without WMI, so the process may be terminated when this process exits'
  }
  return $result
}

# task kill <pid> [--force]
#
# Without --force this asks the process to close its main window and then waits briefly for it to act.
# That is a request, and some processes ignore it - a process showing a modal dialog, for instance, will
# not exit on CloseMainWindow. The result therefore reports what actually happened (terminated /
# stillRunning) rather than what was asked for, and escalates to termination only when the process is
# still there after the grace period.
#
# With --force this terminates the process outright. That is TerminateProcess: the process cannot refuse
# it and any unsaved state is lost, which is a materially different act rather than a stronger version
# of the same one, so it is an explicit opt-in and the result says so.
function Invoke-TaskKill {
  param($Parsed)
  $pidText = Get-Positional -Parsed $Parsed -Index 0 -Name 'pid'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'task kill' -Perm 'W'
  $force = Test-HasFlag -Parsed $Parsed -Name 'force'
  $targetPid = Get-IntArg -Text $pidText -Name 'pid'
  if ($targetPid -eq $PID) {
    # Killing the process that is reporting would leave the caller with no result at all.
    throw (New-OsError -Code 'E_USAGE' -Message 'refusing to kill the process running this verb')
  }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no process with pid {0}" -f $targetPid))
  }
  $name = $proc.ProcessName

  if ($force) {
    try {
      $proc.Kill()
      $proc.WaitForExit(5000) | Out-Null
    } catch {
      throw (New-OsError -Code 'E_IO' -Message ("pid {0} could not be terminated: {1}" -f $targetPid, $_.Exception.Message))
    }
    return [ordered]@{
      pid = $targetPid
      name = $name
      mode = 'force'
      requested = 'TerminateProcess'
      terminated = ($null -eq (Get-Process -Id $targetPid -ErrorAction SilentlyContinue))
      warning = 'a forced kill cannot be refused and discards unsaved state'
    }
  }

  $asked = $false
  try { $asked = [bool]$proc.CloseMainWindow() } catch { $asked = $false }
  if ($asked) {
    # A short grace period, then escalate. Without this the verb would leave a process running and
    # report success, which is the failure mode the caller most needs to avoid.
    try { $proc.WaitForExit(3000) | Out-Null } catch { }
  }
  $survivor = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $survivor -and -not $asked) {
    # No main window to ask, so there is nothing to request politely; terminate rather than pretend.
    try { $survivor.Kill(); $survivor.WaitForExit(5000) | Out-Null } catch { }
    $survivor = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  }
  $alive = ($null -ne $survivor)
  return [ordered]@{
    pid = $targetPid
    name = $name
    mode = 'graceful'
    requested = $(if ($asked) { 'CloseMainWindow' } else { 'TerminateProcess (no main window to ask)' })
    terminated = (-not $alive)
    stillRunning = $alive
    hint = $(if ($alive) { 'the process did not exit; re-run with --force to terminate it outright' } else { $null })
  }
}

# ===== environment.ps1 =============================================

# Module: environment.ps1 - environment.* and environment attribute.*

function Resolve-EnvironmentScope {
  param($Parsed, [string]$Default = 'user')
  $scope = Get-FlagValue -Parsed $Parsed -Name 'scope' -Default $Default
  # if/elseif rather than switch: PowerShell's switch iterates its input when the input is enumerable,
  # and a string is enumerable as characters. That has already produced concatenated garbage once in
  # this codebase, so the explicit form is used wherever the subject is a string.
  if ($scope -eq 'process') { return [System.EnvironmentVariableTarget]::Process }
  if ($scope -eq 'user') { return [System.EnvironmentVariableTarget]::User }
  if ($scope -eq 'machine') { return [System.EnvironmentVariableTarget]::Machine }
  throw (New-OsError -Code 'E_USAGE' -Message ("--scope must be process, user or machine, got '{0}'" -f $scope))
}

function Get-ScopeName {
  param($Target)
  if ($Target -eq [System.EnvironmentVariableTarget]::Process) { return 'process' }
  if ($Target -eq [System.EnvironmentVariableTarget]::User) { return 'user' }
  if ($Target -eq [System.EnvironmentVariableTarget]::Machine) { return 'machine' }
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

# Ordinal comparison of two environment values.
#
# This is not stylistic. From .NET 5, culture-invariant string comparison IGNORES NON-PRINTABLE
# CONTROL CHARACTERS, so with -eq a value carrying an embedded control character compares equal to the
# same value without it. Entry values come from the environment and are attacker-influenced in the
# sense that anything on the machine can set them, so "does this list already contain X" and "which
# entry did the caller name" must be exact answers. -ceq would also be case-sensitive-and-ordinal, but
# an explicit call says why.
function Test-EnvironmentValueEqual {
  param([string]$A, [string]$B)
  return [string]::Equals($A, $B, [System.StringComparison]::Ordinal)
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
  # A null value is how SetEnvironmentVariable deletes; the write is then READ BACK and verified,
  # because a silent no-op here would be indistinguishable from success.
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

function Invoke-EnvironmentAttributeList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  return (Get-AttributeList -Parsed $Parsed)
}

function Invoke-EnvironmentAttributeGet {
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
  if (-not (Test-EnvironmentValueEqual -A $name -B $attr)) {
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

function Invoke-EnvironmentAttributeAdd {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment attribute add'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute add' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute add'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $entries = Get-AttributeEntries -Name $attr -Target $target
  foreach ($e in $entries) {
    if (Test-EnvironmentValueEqual -A $e -B $value) {
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

function Invoke-EnvironmentAttributeSet {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'environment attribute set'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute set' -Perm 'W' -Positionals 3
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $index = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1 -Name 'index') -Name 'index'
  $value = Get-Positional -Parsed $Parsed -Index 2 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute set'
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

function Invoke-EnvironmentAttributeDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'environment attribute delete'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute delete' -Perm 'W' -Positionals 1
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute delete'
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
    # Only the FIRST match is removed, and the comparison is ordinal so that an entry differing from
    # the named value only by a control character is not silently the one that gets deleted.
    $kept = New-Object System.Collections.ArrayList
    foreach ($e in $entries) {
      if ((Test-EnvironmentValueEqual -A $e -B $valueText) -and $null -eq $removed) { $removed = $e; continue }
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

# ===== service.ps1 =================================================

# service.ps1 - system service inventory (SCM).
#
# Read-only. The lifecycle verbs (service.start / stop / restart) are declared in the verb table but
# deliberately unimplemented on both platforms: starting a service changes machine state and needs
# privilege, so it is a distinct piece of work rather than a variation on these two.

function Invoke-ServiceList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
  # No -ComputerName: PowerShell 7 removed it from the *-Service cmdlets in favour of Invoke-Command, so
  # this verb is local-only by construction on 7.x. The 5.1 module did not pass it either, so the
  # observable behaviour is unchanged.
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
  # A service name is compared against CIM rows below with -eq, which on .NET 5+ ignores non-printable
  # control characters. A service name cannot contain one, so this is left as -eq rather than made
  # ordinal; the distinction is recorded here so it is a decision rather than an oversight.
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

# ===== permission.ps1 ==============================================

# Module: permission.ps1 - permission.* verbs, the ACL layer, selfcheck and the capability matrix.
#
# Ported from powershell5.1/permission.ps1 for bin/dsh-os7.ps1. Verb names, flags, result field names
# and error codes are identical to the 5.1 module. What changed, and why:
#
#   * selfcheck reported $PSVersionTable.CLRVersion. That key does not exist in 7.x at all, so the
#     expression throws rather than degrading. The field keeps the name `clrVersion` (an agent already
#     parses it) and now carries
#     [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription, the official
#     replacement, which is more informative: ".NET 10.0.12" instead of a bare CLR version.
#   * selfcheck's `script` names the artefact that actually ran: bin/dsh-os7.ps1. The field keeps its
#     name; only the value is corrected, since reporting the 5.1 file name from the 7.6 script would be
#     a false statement about which implementation answered.
#   * String comparisons that can see argument text or file text name their comparison explicitly.
#     PowerShell's -eq is a linguistic comparison, and .NET's linguistic comparisons do not treat every
#     non-printable control character as ordinary text - measured, with BEL = [char]7:
#     ('lf' + BEL) -eq 'lf' is False on Windows PowerShell 5.1 but True on 7.6, so an unchanged -eq
#     would make this port answer a rule question differently from the script it replaces. file.ps1
#     documents the same trap at its Test-SameText helper; this module inlines [string]::Equals with an
#     explicit StringComparison rather than depending on a helper defined in an earlier module.
#
# The ACL layer needs no 7.x-specific work. It reads and writes the security descriptor through the
# advapi32 P/Invoke in native.ps1 and never calls Get-Acl/Set-Acl, so the 7.3 relocation of the
# ObjectSecurity type data into Microsoft.PowerShell.Security (which obliges callers of those cmdlets
# to import that module explicitly) does not apply here.

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
    # 'consent-delegate' is an identity token, so it is compared as one: ordinal and case-insensitive,
    # never linguistically. A value carrying a control character must not pass as the delegate.
    if (-not [string]::Equals([string]$doc.updatedBy, 'consent-delegate', [System.StringComparison]::OrdinalIgnoreCase)) { $trusted = $false }
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
  $items = [System.Collections.ArrayList]::new()
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
    empty = ($state.empty ?? $false)
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
      # The rule text comes from permission.json and the verb comes from argv, so both comparisons are
      # named rather than linguistic. A rule written "file.*" matches every verb under "file." because
      # the trailing asterisk is dropped and what remains is used as a prefix.
      $verbMatch = [string]::Equals([string]$r.verb, $verb, [System.StringComparison]::OrdinalIgnoreCase)
      if (-not $verbMatch -and $r.verb.EndsWith('.*', [System.StringComparison]::Ordinal)) {
        $prefix = $r.verb.Substring(0, $r.verb.Length - 1)
        # The prefix test keeps the case-sensitivity the 5.1 code had; only its tolerance of control
        # characters is dropped.
        $verbMatch = $verb.StartsWith($prefix, [System.StringComparison]::Ordinal)
      }
      if (-not $verbMatch) { continue }
      $value = '*'
      if ($null -ne $r.target -and $null -ne $r.target.PSObject.Properties['value']) { $value = [string]$r.target.value }
      if ([string]::Equals($value, '*', [System.StringComparison]::OrdinalIgnoreCase) -or
          [string]::Equals($value, $target, [System.StringComparison]::OrdinalIgnoreCase)) { $matched = $r; break }
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

# The well-known SID for "Everyone". Layer A denies write access to it, because denying Everyone
# covers every context that could open the file, including the automation one, without this process
# having to know which account the harness runs as.
$script:EveryoneSid = 'S-1-1-0'

function Test-AclEnforced {
  # Measured from the file's OWN access control list, never from a state file.
  #
  # This previously read a flag written under .temporary/acl-state.json, which meant the reported
  # strength was whatever that file happened to say: a stale or edited flag would report kernel
  # enforcement that was not in effect. The model requires this to be measured, so the descriptor is
  # read back and searched for an explicit deny.
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    Initialize-Native
    $state = [DshNative]::DescribeDenyState($path, $script:EveryoneSid)
    return ($state -eq 'DENY')
  } catch {
    return $false
  }
}

# The reason, not just the boolean, so selfcheck can explain what is missing.
function Get-AclEnforcementDetail {
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ enforced = $false; reason = 'permission.json does not exist'; aclState = 'NOFILE' }
  }
  try {
    Initialize-Native
    $state = [DshNative]::DescribeDenyState($path, $script:EveryoneSid)
    # if/elseif rather than switch: PowerShell's switch iterates an enumerable input, and a string is
    # enumerable as characters, which silently runs the body once per character.
    if ($state -eq 'DENY') { $reason = 'an explicit deny of write access for Everyone is present' }
    elseif ($state -eq 'NONE') { $reason = 'the file has a DACL but no deny entry for Everyone; run: dsh-os permission acl init' }
    elseif ($state -eq 'NODACL') { $reason = 'the file has no DACL, so nothing is being denied' }
    else { $reason = "the access control list could not be read ($state)" }
    return [ordered]@{ enforced = ($state -eq 'DENY'); reason = $reason; aclState = "$state"; sid = $script:EveryoneSid }
  } catch {
    return [ordered]@{ enforced = $false; reason = ("the ACL could not be read: {0}" -f $_.Exception.Message); aclState = 'ERROR' }
  }
}

# ---------------------------------------------------------------------------
# permission.grant / revoke / acl init
# ---------------------------------------------------------------------------

# Both write verbs are delegate-only, and that is enforced by there being no implementation here at
# all rather than by a permission check that could be argued with. The authorization file is written
# by the consent delegate plugin, which can reach the user's approval UI; a script cannot, so a script
# must not be able to create a durable grant. E_PERMISSION_DELEGATE_ONLY names the component that can.
function Invoke-PermissionGrant {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'permission grant'
  Assert-Allowed -Parsed $Parsed -Verb 'permission grant' -Perm 'W'
  throw (New-OsError -Code 'E_PERMISSION_DELEGATE_ONLY' `
      -Message 'permission grant can only be performed by the consent delegate' `
      -Hint 'this verb needs the user approval dialog, which the delegate plugin owns; a script cannot reach it')
}

function Invoke-PermissionRevoke {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'permission revoke'
  Assert-Allowed -Parsed $Parsed -Verb 'permission revoke' -Perm 'W'
  throw (New-OsError -Code 'E_PERMISSION_DELEGATE_ONLY' `
      -Message 'permission revoke can only be performed by the consent delegate' `
      -Hint 'revoking a durable decision also needs the user approval dialog')
}

# permission acl init - idempotently apply layer A.
#
# Idempotent in the sense that matters here: running it twice leaves the same access control list, and
# running it on a file that already carries the deny reports that nothing changed rather than adding a
# second identical entry.
#
# It requires elevation because rewriting the security descriptor of a protected object is a
# privileged operation. A refusal is reported as E_ELEVATION_REQUIRED rather than being swallowed.
function Invoke-PermissionAclInit {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Allowed -Parsed $Parsed -Verb 'permission acl init' -Perm 'W'
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("permission.json does not exist at {0}" -f $path) `
        -Hint 'create the file first; the repository ships an empty one as the documented initial state')
  }
  Initialize-Native

  $before = Get-AclEnforcementDetail
  if ($before.enforced) {
    # Already protected. Reported as a no-op rather than re-applying, which is what makes a second run
    # safe to call from anywhere.
    return [ordered]@{
      path = $path
      changed = $false
      enforced = $true
      sid = $script:EveryoneSid
      reason = $before.reason
    }
  }

  if (-not (Test-IsElevated)) {
    throw (New-OsError -Code 'E_ELEVATION_REQUIRED' `
        -Message 'setting the security descriptor of a protected file requires elevation' `
        -Hint 'this operation needs an elevated context; nothing was changed')
  }

  $result = [DshNative]::ApplyDeny($path, $script:EveryoneSid)
  if ($result -ne 'OK') {
    throw (New-OsError -Code 'E_IO' -Message ("the access control list could not be updated: {0}" -f $result))
  }

  # Read back rather than trusting the call: the point of layer A is what the kernel will enforce, so
  # the result reports the DACL as it now stands.
  $after = Get-AclEnforcementDetail
  return [ordered]@{
    path = $path
    changed = $true
    enforced = $after.enforced
    sid = $script:EveryoneSid
    reason = $after.reason
    aclState = $after.aclState
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
    # Probed rather than asserted. This said 'unavailable' as a hardcoded string until the text and
    # structure verbs were implemented, so a caller reading selfcheck would have concluded that
    # accessibility could never work here. A capability report that is not measured is a guess.
    accessibility = 'uia'
    accessibilityDetail = $null
    fonts = $null
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $caps['dpiAware'] = $true
    $caps['screens'] = [System.Windows.Forms.Screen]::AllScreens.Count
  } catch {
    $caps['screens'] = $null
  }
  try {
    # All four assemblies load on 7.6.6 (verified by probe), so the 5.1 form is kept: Add-Type
    # -AssemblyName still resolves them from the Windows Desktop runtime that pwsh ships with.
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    # Reaching the root element proves the layer answers, not merely that the assemblies loaded.
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $caps['accessibility'] = 'uia'
    $caps['accessibilityDetail'] = ('root=' + $root.Current.ClassName)
  } catch {
    $caps['accessibility'] = 'unavailable'
    $caps['accessibilityDetail'] = $_.Exception.Message
  }
  return $caps
}

function Invoke-Selfcheck {
  param($Parsed)
  $verbs = [System.Collections.ArrayList]::new()
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      # Length and ordinal prefixes rather than -eq/-StartsWith: a line holding one control character
      # is not an empty line, and "verb`0" is not the header.
      if ($line.Length -eq 0 -or $line.StartsWith('#', [System.StringComparison]::Ordinal) -or
          $line.StartsWith('verb', [System.StringComparison]::Ordinal)) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 4) { continue }
      [void]$verbs.Add([ordered]@{ verb = $f[0]; positionals = $f[1]; flags = $f[2]; perm = $f[3] })
    }
  }
  $enforcement = Get-AclEnforcementDetail
  return [ordered]@{
    # The artefact that actually answered. bin/dsh-os.ps1 is the Windows PowerShell 5.1 implementation;
    # this module set is assembled into bin/dsh-os7.ps1, so the field keeps its name and reports the
    # file that really ran rather than naming the other implementation.
    script = 'bin/dsh-os7.ps1'
    powershell = $PSVersionTable.PSVersion.ToString()
    # Kept under the 5.1 field name because an agent already parses `clrVersion`. $PSVersionTable has
    # no ClrVersion key in 7.x (6.0 removed it along with BuildVersion), so the 5.1 expression throws
    # instead of reporting anything; FrameworkDescription is the official replacement and reads
    # ".NET 10.0.12".
    clrVersion = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    encodesPlainStdout = $true
    capabilities = Get-PlatformCapabilities
    # The permission model requires selfcheck to report which enforcement strength is actually in
    # effect. It is MEASURED from the authorization file's security descriptor, and the reason is
    # reported next to the boolean so a false can be acted on instead of just wondered about.
    aclEnforced = $enforcement.enforced
    aclReason = $enforcement.reason
    verbCount = $verbs.Count
    verbs = $verbs.ToArray()
  }
}

# ===== window.ps1 ==================================================

# Module: window.ps1 - window.* and screenshot.
#
# Ported from powershell5.1/window.ps1 for bin/dsh-os7.ps1. Every verb name, argument, flag, result
# field and error code is the 5.1 contract, unchanged; the P/Invoke this module calls is declared once
# in native.ps1 and is not redeclared here.
#
# Everything here reads or moves windows on the interactive desktop, so every verb needs the
# input desktop to exist. A session with no window station (a service, a headless run) gets
# E_NO_DISPLAY rather than an empty list, because "no windows" and "no desktop to ask" are different
# answers and only one of them means the caller should give up.
#
# Window identity is deliberately NOT the numeric handle alone. A handle is reused after a window is
# destroyed, so a caller that stores one can later act on an unrelated window. Each result therefore
# carries title, class and pid next to the handle, and `name` matching re-reads those fields live.
#
# The one deliberate change from the 5.1 source is in the MATCHING, and it is a correctness fix rather
# than a port artefact: from .NET 5, culture-invariant string comparison ignores non-printable control
# characters, so 'Food' -eq "Foo`ad" is True and the 5.1 `-ceq` could match the wrong window whenever a
# title or a queried name carried a control character. Every title comparison below is therefore
# [string]::Equals(..., Ordinal) / String.IndexOf(..., OrdinalIgnoreCase); the comment at each site
# says why. Everything else is the 5.1 code.

# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------

# Whether this process can see a desktop at all.
function Test-DesktopAvailable {
  try {
    $dc = [DshNative]::GetDC([IntPtr]::Zero)
    if ($dc -eq [IntPtr]::Zero) { return $false }
    [void][DshNative]::ReleaseDC([IntPtr]::Zero, $dc)
    return $true
  } catch {
    return $false
  }
}

function Assert-Desktop {
  Initialize-Native
  if (-not (Test-DesktopAvailable)) {
    throw (New-OsError -Code 'E_NO_DISPLAY' -Message 'no interactive desktop is available to this process' `
        -Hint 'window verbs need a window station; a service or headless session has none')
  }
}

function Get-WindowTitle {
  param([IntPtr]$Handle)
  # The window text is read through [DshNative]::WindowText, which is the same GetWindowTextLengthW +
  # GetWindowTextW pair the 5.1 module called inline: it sizes the buffer as length + 2 so the
  # terminator has room, because a shorter buffer silently truncates the title while still returning a
  # well-formed string. The helper is declared once in native.ps1 and is not redeclared here.
  return [DshNative]::WindowText($Handle)
}

function Get-WindowClassName {
  param([IntPtr]$Handle)
  return [DshNative]::WindowClass($Handle)
}

function Get-WindowPid {
  param([IntPtr]$Handle)
  # $pid is a read-only automatic variable in PowerShell, so the out parameter needs another name.
  # That is still true in 7.x, so the local keeps the 5.1 name.
  $procId = [uint32]0
  [void][DshNative]::GetWindowThreadProcessId($Handle, [ref]$procId)
  return [int]$procId
}

function Get-WindowRectValue {
  param([IntPtr]$Handle)
  $r = [DshNative+RECT]::new()
  if (-not [DshNative]::GetWindowRect($Handle, [ref]$r)) { return $null }
  return [ordered]@{
    x = $r.Left
    y = $r.Top
    width = ($r.Right - $r.Left)
    height = ($r.Bottom - $r.Top)
  }
}

# All top-level windows in z-order, front to back.
#
# The callback delegate is held in a script-scope variable for the duration of the call. If it were
# only a local, the garbage collector could collect it while the native enumerator still held its
# function pointer, and the process would crash rather than return an error.
#
# $script:EnumWindowsResult is initialised explicitly rather than left to the first assignment:
# Set-StrictMode -Version Latest still throws on reading an unset $script: variable in 7.x exactly as
# in 5.1, so the declaration is load-bearing in both.
$script:EnumWindowsResult = $null
function Get-TopLevelWindows {
  param([switch]$IncludeUnnamed)

  Assert-Desktop
  $collected = [System.Collections.ArrayList]::new()
  $script:EnumWindowsResult = $collected
  $callback = [DshNative+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$param)
    try {
      $title = Get-WindowTitle -Handle $hWnd
      $isVisible = [DshNative]::IsWindowVisible($hWnd)
      # An owned window is a dialog or tool window whose owner already appears in the list; including
      # both would report the same UI twice. Unnamed visible windows are shell plumbing.
      $owner = [DshNative]::GetWindow($hWnd, [uint32][DshNative]::GW_OWNER)
      if ($owner -eq [IntPtr]::Zero -and ($IncludeUnnamed -or ($isVisible -and $title -ne ''))) {
        [void]$collected.Add([ordered]@{
          handle = ('0x{0:x}' -f $hWnd.ToInt64())
          title = $title
          class = (Get-WindowClassName -Handle $hWnd)
          pid = (Get-WindowPid -Handle $hWnd)
          visible = [bool]$isVisible
          rect = (Get-WindowRectValue -Handle $hWnd)
        })
      }
    } catch {
      # A window can be destroyed between enumeration and inspection. Skipping it is correct; failing
      # the whole enumeration because one window vanished is not.
    }
    return $true
  }
  try {
    [void][DshNative]::EnumWindows($callback, [IntPtr]::Zero)
  } finally {
    $script:EnumWindowsResult = $null
  }
  return , @($collected)
}

# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

# Resolve a name to exactly one window, or fail with a typed error.
#
# Ambiguity is an error rather than a silent first match: acting on the wrong window is a real-world
# mistake (closing the wrong document), while reporting E_WINDOW_AMBIGUOUS with the candidates lets
# the caller disambiguate by pid or by a longer name.
function Resolve-Window {
  param([string]$Name, [switch]$Exact, [int]$PidFilter = 0, [switch]$Regex)
  if ([string]::IsNullOrEmpty($Name)) {
    throw (New-OsError -Code 'E_USAGE' -Message 'a window name is required')
  }
  $all = Get-TopLevelWindows
  if ($PidFilter -gt 0) { $all = @($all | Where-Object { $_.pid -eq $PidFilter }) }

  $matches = [System.Collections.ArrayList]::new()
  foreach ($w in $all) {
    $hit = $false
    if ($Regex) {
      try { $hit = [bool]($w.title -match $Name) } catch { $hit = $false }
    } elseif ($Exact) {
      # Ordinal, not -ceq. .NET 5 made culture-invariant comparison ignore non-printable control
      # characters, so 'Foo' -ceq "Foo`a" is True here: a title carrying a control character would
      # match the wrong window. A window title is compared literally, so Ordinal is the right relation.
      $hit = [string]::Equals($w.title, $Name, [System.StringComparison]::Ordinal)
    } else {
      # Case-insensitive substring is the documented default: a caller usually has a fragment.
      # IndexOf with OrdinalIgnoreCase, so neither case folding nor control characters are ignored.
      $hit = ($w.title.IndexOf($Name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    if ($hit) { [void]$matches.Add($w) }
  }

  if ($matches.Count -eq 0) {
    throw (New-OsError -Code 'E_WINDOW_NOT_FOUND' -Message ("no window matches '{0}'" -f $Name) `
        -Hint 'run: dsh-os7 window list   (to see the titles that exist)')
  }
  if ($matches.Count -gt 1) {
    $titles = ($matches | ForEach-Object { $_.title }) -join ' | '
    throw (New-OsError -Code 'E_WINDOW_AMBIGUOUS' `
        -Message ("'{0}' matches {1} windows" -f $Name, $matches.Count) `
        -Hint ("candidates: " + $titles))
  }
  return $matches[0]
}

function Get-WindowHandleFromResult {
  param($Window)
  return [IntPtr][Convert]::ToInt64($Window.handle.Substring(2), 16)
}

# ---------------------------------------------------------------------------
# Read-only verbs
# ---------------------------------------------------------------------------

function Invoke-WindowList {
  param($Parsed)
  $windows = Get-TopLevelWindows
  return [ordered]@{
    count = $windows.Count
    windows = $windows
  }
}

function Invoke-WindowFind {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $name = Get-Positional -Parsed $Parsed -Index 0
  $exact = Test-HasFlag -Parsed $Parsed -Name 'exact'
  $regex = Test-HasFlag -Parsed $Parsed -Name 'regex'
  $pidText = Get-FlagValue -Parsed $Parsed -Name 'pid' -Default '0'
  $PidFilter = Get-IntArg -Text $pidText -Name 'pid'

  # find reports every match rather than demanding uniqueness: it is the discovery verb, and the
  # caller needs the candidate list to write a precise call afterwards.
  $all = Get-TopLevelWindows
  $hits = [System.Collections.ArrayList]::new()
  foreach ($w in $all) {
    if ($PidFilter -gt 0 -and $w.pid -ne $PidFilter) { continue }
    $hit = $false
    if ($regex) {
      try { $hit = [bool]($w.title -match $name) } catch { $hit = $false }
    } elseif ($exact) {
      # Ordinal, for the same reason as in Resolve-Window: -ceq would treat a title containing an
      # ignorable control character as equal to a name that does not contain it.
      $hit = [string]::Equals($w.title, $name, [System.StringComparison]::Ordinal)
    } else {
      $hit = ($w.title.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    if ($hit) { [void]$hits.Add($w) }
  }
  return [ordered]@{
    name = $name
    matchMode = $(if ($regex) { 'regex' } elseif ($exact) { 'exact' } else { 'contains' })
    count = $hits.Count
    matches = $hits.ToArray()
  }
}

function Invoke-WindowActive {
  param($Parsed)
  Assert-Desktop
  $h = [DshNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) {
    throw (New-OsError -Code 'E_WINDOW_NOT_FOUND' -Message 'there is no foreground window')
  }
  return [ordered]@{
    handle = ('0x{0:x}' -f $h.ToInt64())
    title = (Get-WindowTitle -Handle $h)
    class = (Get-WindowClassName -Handle $h)
    pid = (Get-WindowPid -Handle $h)
    rect = (Get-WindowRectValue -Handle $h)
  }
}

# ---------------------------------------------------------------------------
# Mutating verbs
# ---------------------------------------------------------------------------

# Shared result for a window that was acted on: the caller gets the identity back, so it can confirm
# afterwards that it moved the window it meant to.
function New-WindowActionResult {
  param([string]$Action, $Window)
  return [ordered]@{
    action = $Action
    handle = $Window.handle
    title = $Window.title
    pid = $Window.pid
    rect = (Get-WindowRectValue -Handle (Get-WindowHandleFromResult -Window $Window))
  }
}

function Invoke-WindowClose {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window close'
  Assert-Allowed -Parsed $Parsed -Verb 'window close' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  # WM_CLOSE asks the application to close, which lets it prompt to save. TerminateProcess would not,
  # and destroying a window a process still owns is not what "close" means to a user.
  [void][DshNative]::PostMessageW($h, [uint32][DshNative]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  return [ordered]@{
    action = 'close'
    handle = $w.handle
    title = $w.title
    pid = $w.pid
    requested = 'WM_CLOSE'
    # Reported as a request, not an outcome: the application decides when it actually closes.
    closed = ([DshNative]::IsWindow($h) -eq $false)
  }
}

function Invoke-WindowTop {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window top'
  Assert-Allowed -Parsed $Parsed -Verb 'window top' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  # SetWindowPos with HWND_TOP raises in z-order; SetForegroundWindow additionally gives focus, which
  # Windows refuses for a process that does not own the foreground. Both are attempted and the
  # foreground result is reported separately so a refusal is visible rather than implied.
  [void][DshNative]::SetWindowPos($h, [DshNative]::HWND_TOP, 0, 0, 0, 0,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_SHOWWINDOW)))
  $focused = [DshNative]::SetForegroundWindow($h)
  $r = New-WindowActionResult -Action 'top' -Window $w
  $r['focused'] = [bool]$focused
  return $r
}

function Invoke-WindowBottom {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window bottom'
  Assert-Allowed -Parsed $Parsed -Verb 'window bottom' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  [void][DshNative]::SetWindowPos($h, [DshNative]::HWND_BOTTOM, 0, 0, 0, 0,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_NOACTIVATE)))
  return (New-WindowActionResult -Action 'bottom' -Window $w)
}

function Invoke-WindowMove {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'window move'
  Assert-Allowed -Parsed $Parsed -Verb 'window move' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 2) -Name 'y'
  $h = Get-WindowHandleFromResult -Window $w
  # Restore first: a minimized window reports a rect of about -32000 and would otherwise stay hidden.
  if ([DshNative]::IsIconic($h)) { [void][DshNative]::ShowWindow($h, [DshNative]::SW_RESTORE) }
  [void][DshNative]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, 0, 0,
    ([uint32]([DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_NOACTIVATE)))
  $r = New-WindowActionResult -Action 'move' -Window $w
  $r['requested'] = [ordered]@{ x = $x; y = $y }
  return $r
}

function Invoke-WindowResize {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'window resize'
  Assert-Allowed -Parsed $Parsed -Verb 'window resize' -Perm 'W'
  # Values are validated BEFORE the window is resolved. Resolving first let a missing or ambiguous name
  # mask a malformed extent, so the caller was told about the wrong problem entirely.
  $width = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'width'
  $height = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 2) -Name 'height'
  if ($width -le 0 -or $height -le 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("width and height must be positive, got {0}x{1}" -f $width, $height))
  }
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  if ([DshNative]::IsIconic($h)) { [void][DshNative]::ShowWindow($h, [DshNative]::SW_RESTORE) }
  [void][DshNative]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $width, $height,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOACTIVATE)))
  $r = New-WindowActionResult -Action 'resize' -Window $w
  $r['requested'] = [ordered]@{ width = $width; height = $height }
  return $r
}

# minimize / maximize / restore differ only in the ShowWindow command.
function Invoke-WindowShowState {
  param($Parsed, [string]$Action, [int]$Command)
  # Initialize-Native comes FIRST here, and that ordering is load-bearing on PowerShell 7 in a way it
  # was not on 5.1. The three wrappers below pass the command as -Command ([DshNative]::SW_MINIMIZE),
  # and an argument expression is evaluated in the CALLER before this function starts running, so the
  # [DshNative] type literal is bound before Assert-Desktop's Initialize-Native has compiled the type.
  # On 5.1 that resolved anyway; on 7.6 it fails with "Cannot find type [DshNative]" reported as
  # E_INTERNAL, which is how all three verbs were broken. Compiling the type here does not help that
  # caller-side expression, so the wrappers call Initialize-Native first as well - between the two, the
  # type exists by the time any [DshNative] member in this path is touched.
  Initialize-Native
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb ("window " + $Action)
  Assert-Allowed -Parsed $Parsed -Verb ("window " + $Action) -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  [void][DshNative]::ShowWindow($h, $Command)
  $r = New-WindowActionResult -Action $Action -Window $w
  # Report the state actually observed afterwards, so a window that refused to change is visible.
  $r['minimized'] = [bool][DshNative]::IsIconic($h)
  $r['zoomed'] = [bool][DshNative]::IsZoomed($h)
  return $r
}

function Invoke-WindowMinimize {
  param($Parsed)
  # The type is compiled before the argument expression below is evaluated; see Invoke-WindowShowState.
  Initialize-Native
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'minimize' -Command ([DshNative]::SW_MINIMIZE))
}

function Invoke-WindowMaximize {
  param($Parsed)
  Initialize-Native
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'maximize' -Command ([DshNative]::SW_MAXIMIZE))
}

function Invoke-WindowRestore {
  param($Parsed)
  Initialize-Native
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'restore' -Command ([DshNative]::SW_RESTORE))
}

# ---------------------------------------------------------------------------
# screenshot
# ---------------------------------------------------------------------------

function Invoke-Screenshot {
  param($Parsed)
  $out = Get-FlagValue -Parsed $Parsed -Name 'out' -Default $null
  if ([string]::IsNullOrEmpty($out)) {
    throw (New-OsError -Code 'E_USAGE' -Message 'screenshot requires --out <path>' `
        -Hint 'the image bytes are written to a file; the result reports the path, size and geometry')
  }
  Assert-Desktop

  # Geometry: the four positionals are x y width height. Omitted means the whole virtual screen, which
  # spans every monitor, because capturing only the primary one silently loses the others.
  $pos = @($Parsed.positionals)
  $full = ($pos.Count -eq 0)
  if (-not $full -and $pos.Count -lt 4) {
    throw (New-OsError -Code 'E_USAGE' -Message 'screenshot takes either no geometry (full screen) or all four of x y width height')
  }
  if ($full) {
    $x = [DshNative]::GetSystemMetrics([DshNative]::SM_XVIRTUALSCREEN)
    $y = [DshNative]::GetSystemMetrics([DshNative]::SM_YVIRTUALSCREEN)
    $width = [DshNative]::GetSystemMetrics([DshNative]::SM_CXVIRTUALSCREEN)
    $height = [DshNative]::GetSystemMetrics([DshNative]::SM_CYVIRTUALSCREEN)
  } else {
    $x = Get-IntArg -Text $pos[0] -Name 'x'
    $y = Get-IntArg -Text $pos[1] -Name 'y'
    $width = Get-IntArg -Text $pos[2] -Name 'width'
    $height = Get-IntArg -Text $pos[3] -Name 'height'
  }
  if ($width -le 0 -or $height -le 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("capture area must be positive, got {0}x{1}" -f $width, $height))
  }

  $format = Get-FlagValue -Parsed $Parsed -Name 'format' -Default 'png'
  $format = $format.ToLowerInvariant()
  $isPng = [string]::Equals($format, 'png', [System.StringComparison]::Ordinal)
  $isJpeg = ([string]::Equals($format, 'jpeg', [System.StringComparison]::Ordinal) -or
             [string]::Equals($format, 'jpg', [System.StringComparison]::Ordinal))
  $isBmp = [string]::Equals($format, 'bmp', [System.StringComparison]::Ordinal)
  if (-not ($isPng -or $isJpeg -or $isBmp)) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unsupported format '{0}'" -f $format) `
        -Hint 'supported: png, jpeg, bmp')
  }

  $dest = Resolve-FullPath -Path $out
  Assert-NotProtectedPath -Path $dest
  $parent = Split-Path -Parent $dest
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("parent directory does not exist: {0}" -f $parent))
  }

  # System.Drawing is NOT part of the PowerShell 7 shared framework: it lives in the
  # Microsoft.WindowsDesktop.App runtime, which PowerShell on Windows carries. It is still loaded by
  # name at first use rather than assumed, and a failure to load stays the typed E_NOT_SUPPORTED it
  # was in 5.1 rather than surfacing as an untyped error from the encoder.
  try { Add-Type -AssemblyName System.Drawing -ErrorAction Stop } catch {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'System.Drawing is unavailable, so no image can be encoded')
  }

  $screenDc = [DshNative]::GetDC([IntPtr]::Zero)
  $memDc = [DshNative]::CreateCompatibleDC($screenDc)
  $bitmap = [DshNative]::CreateCompatibleBitmap($screenDc, $width, $height)
  $previous = [DshNative]::SelectObject($memDc, $bitmap)
  try {
    # SRCCOPY = 0x00CC0020. A false result means the blit failed, which is a real failure rather than
    # a black image, so it is reported instead of writing an all-black PNG.
    $ok = [DshNative]::BitBlt($memDc, 0, 0, $width, $height, $screenDc, $x, $y, 0x00CC0020)
    if (-not $ok) {
      throw (New-OsError -Code 'E_IO' -Message 'BitBlt failed; the screen could not be captured')
    }
    $image = [System.Drawing.Image]::FromHbitmap($bitmap)
    try {
      $imageFormat = [System.Drawing.Imaging.ImageFormat]::Png
      if ($isJpeg) { $imageFormat = [System.Drawing.Imaging.ImageFormat]::Jpeg }
      elseif ($isBmp) { $imageFormat = [System.Drawing.Imaging.ImageFormat]::Bmp }
      # Image.Save(string) writes through the file system, not through our byte-level Write-Atomic: the
      # encoder owns the bytes and can only stream to an open path or stream. The destination is
      # already resolved and boundary-checked above, so this is the one place in the surface that does
      # not publish through a temporary file.
      $image.Save($dest, $imageFormat)
    } finally {
      $image.Dispose()
    }
  } finally {
    [void][DshNative]::SelectObject($memDc, $previous)
    [void][DshNative]::DeleteObject($bitmap)
    [void][DshNative]::DeleteDC($memDc)
    [void][DshNative]::ReleaseDC([IntPtr]::Zero, $screenDc)
  }

  $size = (Get-Item -LiteralPath $dest).Length
  return [ordered]@{
    path = $dest
    format = $format
    size = $size
    region = [ordered]@{ x = $x; y = $y; width = $width; height = $height }
    fullScreen = $full
  }
}

# ---------------------------------------------------------------------------
# mouse
# ---------------------------------------------------------------------------
#
# Coordinates are screen pixels, matching what mouse.cursor and window rects report, so a caller can
# take a rectangle from window.list and click inside it without converting anything. The absolute
# SendInput form normalises to 0..65535 over the VIRTUAL screen, which is why the metrics lookups
# below are the virtual-screen ones: using the primary-monitor size would misplace every click on a
# multi-monitor desktop.

# If/elseif rather than switch, for the reason spelled out in Get-ElementField below: this module keeps
# the 5.1 choice of if/elseif wherever a matched string decides a branch.
function Get-MouseButtonFlags {
  param([string]$Button)
  $key = $Button.ToLowerInvariant()
  if ([string]::Equals($key, 'left', [System.StringComparison]::Ordinal)) {
    return @{ down = [DshNative]::MOUSEEVENTF_LEFTDOWN; up = [DshNative]::MOUSEEVENTF_LEFTUP }
  }
  if ([string]::Equals($key, 'right', [System.StringComparison]::Ordinal)) {
    return @{ down = [DshNative]::MOUSEEVENTF_RIGHTDOWN; up = [DshNative]::MOUSEEVENTF_RIGHTUP }
  }
  if ([string]::Equals($key, 'middle', [System.StringComparison]::Ordinal)) {
    return @{ down = [DshNative]::MOUSEEVENTF_MIDDLEDOWN; up = [DshNative]::MOUSEEVENTF_MIDDLEUP }
  }
  throw (New-OsError -Code 'E_USAGE' -Message ("unknown mouse button '{0}'" -f $Button) `
      -Hint 'accepted: left, right, middle')
}

function Move-CursorTo {
  param([int]$X, [int]$Y)
  # The cursor is moved with SetCursorPos rather than a synthetic MOUSEEVENTF_MOVE, so the hit test
  # performed by the target application sees the real pointer position. Many controls ignore injected
  # moves and later discard clicks that arrive at a position they do not believe the pointer is at.
  if (-not [DshNative]::SetCursorPos($X, $Y)) {
    throw (New-OsError -Code 'E_IO' -Message ("the cursor could not be moved to {0},{1}" -f $X, $Y))
  }
}

function Assert-Coordinates {
  param([int]$X, [int]$Y)
  # A point outside the virtual screen cannot be clicked, and reporting that is better than injecting
  # an event that lands nowhere.
  $vsX = [DshNative]::GetSystemMetrics([DshNative]::SM_XVIRTUALSCREEN)
  $vsY = [DshNative]::GetSystemMetrics([DshNative]::SM_YVIRTUALSCREEN)
  $vsW = [DshNative]::GetSystemMetrics([DshNative]::SM_CXVIRTUALSCREEN)
  $vsH = [DshNative]::GetSystemMetrics([DshNative]::SM_CYVIRTUALSCREEN)
  if ($X -lt $vsX -or $Y -lt $vsY -or $X -ge ($vsX + $vsW) -or $Y -ge ($vsY + $vsH)) {
    throw (New-OsError -Code 'E_RANGE' `
        -Message ("point {0},{1} is outside the virtual screen ({2},{3} {4}x{5})" -f $X, $Y, $vsX, $vsY, $vsW, $vsH))
  }
}

function Invoke-MouseClick {
  param($Parsed, [string]$DefaultButton = 'left')
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse click'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse click' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y

  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default $DefaultButton
  $countText = Get-FlagValue -Parsed $Parsed -Name 'count' -Default '1'
  $count = Get-IntArg -Text $countText -Name 'count'
  if ($count -lt 1) {
    throw (New-OsError -Code 'E_RANGE' -Message ("count must be at least 1, got {0}" -f $count))
  }
  $flags = Get-MouseButtonFlags -Button $button

  Move-CursorTo -X $x -Y $y
  for ($i = 0; $i -lt $count; $i++) {
    [DshNative]::SendMouse($flags.down, 0, 0, 0)
    [DshNative]::SendMouse($flags.up, 0, 0, 0)
  }
  $cursor = [DshNative+POINT]::new()
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    # The 5.1 test compared the button name against the literal 'right'. It stays a comparison of two
    # fixed literals rather than becoming the modern ternary, because the expression is reconstructed
    # here as the same if/else statement the 5.1 module used.
    action = $(if ($button -eq 'right') { 'context' } else { 'click' })
    button = $button
    count = $count
    requested = [ordered]@{ x = $x; y = $y }
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseContext {
  param($Parsed)
  $inner = @{ positionals = $Parsed.positionals; flags = $Parsed.flags; named = $Parsed.named }
  return (Invoke-MouseClick -Parsed $inner -DefaultButton 'right')
}

function Invoke-MouseOver {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse over'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse over' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  Move-CursorTo -X $x -Y $y
  $cursor = [DshNative+POINT]::new()
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    action = 'over'
    requested = [ordered]@{ x = $x; y = $y }
    # Read back rather than echoed: the real position proves the move happened.
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseWheel {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse wheel'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse wheel' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  Move-CursorTo -X $x -Y $y
  # The wheel has to turn where the pointer is, so the pointer is placed first. The x/y pair carries
  # the scroll distance, under the same convention as the other mouse verbs.
  $delta = $x
  [DshNative]::SendMouse([DshNative]::MOUSEEVENTF_WHEEL, 0, 0, [uint32]$delta)
  return [ordered]@{
    action = 'wheel'
    delta = $delta
    at = [ordered]@{ x = $x; y = $y }
  }
}

function Invoke-MouseDown {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse down'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse down' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default 'left'
  $flags = Get-MouseButtonFlags -Button $button
  Move-CursorTo -X $x -Y $y
  [DshNative]::SendMouse($flags.down, 0, 0, 0)
  # The button is deliberately left down. A caller that never issues mouse up leaves the desktop with
  # a held button, which is why mouse up takes no coordinates and always releases.
  return [ordered]@{
    action = 'down'
    button = $button
    at = [ordered]@{ x = $x; y = $y }
  }
}

function Invoke-MouseUp {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Allowed -Parsed $Parsed -Verb 'mouse up' -Perm 'W'
  Assert-Desktop
  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default 'left'
  $flags = Get-MouseButtonFlags -Button $button
  [DshNative]::SendMouse($flags.up, 0, 0, 0)
  $cursor = [DshNative+POINT]::new()
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    action = 'up'
    button = $button
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseCursor {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Desktop
  $cursor = [DshNative+POINT]::new()
  if (-not [DshNative]::GetCursorPos([ref]$cursor)) {
    throw (New-OsError -Code 'E_IO' -Message 'the cursor position could not be read')
  }
  return [ordered]@{
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

# ---------------------------------------------------------------------------
# keyboard
# ---------------------------------------------------------------------------

# Accepted key names, mapped to virtual-key codes. A name not in this table is refused rather than
# guessed at: an unrecognised key that silently became some other key would type the wrong thing, and
# there is no way for the caller to notice.
$script:KeyCodes = $null
function Get-KeyCodeTable {
  if ($null -ne $script:KeyCodes) { return $script:KeyCodes }
  $t = @{}
  # Letters and digits: the code is the character itself, upper-cased.
  foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz') { $t[[string]$c] = [int][char]([string]$c).ToUpperInvariant()[0] }
  foreach ($d in 0..9) { $t["$d"] = 0x30 + $d }
  # Function keys.
  for ($i = 1; $i -le 24; $i++) { $t["f$i"] = 0x6F + $i }
  $t['backspace'] = 0x08; $t['tab'] = 0x09; $t['enter'] = 0x0D; $t['return'] = 0x0D
  $t['shift'] = 0x10; $t['ctrl'] = 0x11; $t['control'] = 0x11; $t['alt'] = 0x12
  $t['pause'] = 0x13; $t['capslock'] = 0x14; $t['escape'] = 0x1B; $t['esc'] = 0x1B
  $t['space'] = 0x20; $t['pageup'] = 0x21; $t['pagedown'] = 0x22
  $t['end'] = 0x23; $t['home'] = 0x24; $t['left'] = 0x25; $t['up'] = 0x26
  $t['right'] = 0x27; $t['down'] = 0x28
  $t['printscreen'] = 0x2C; $t['insert'] = 0x2D; $t['delete'] = 0x2E; $t['del'] = 0x2E
  $t['win'] = 0x5B; $t['lwin'] = 0x5B; $t['rwin'] = 0x5C; $t['apps'] = 0x5D
  $t['numlock'] = 0x90; $t['scrolllock'] = 0x91
  $t['shiftleft'] = 0xA0; $t['shiftright'] = 0xA1
  $t['ctrlleft'] = 0xA2; $t['ctrlright'] = 0xA3
  $t['altleft'] = 0xA4; $t['altright'] = 0xA5
  # Punctuation by name, so a chord does not depend on the caller's keyboard layout for those keys.
  $t['semicolon'] = 0xBA; $t['equals'] = 0xBB; $t['comma'] = 0xBC; $t['minus'] = 0xBD
  $t['period'] = 0xBE; $t['slash'] = 0xBF; $t['backtick'] = 0xC0
  $t['bracketleft'] = 0xDB; $t['backslash'] = 0xDC; $t['bracketright'] = 0xDD; $t['quote'] = 0xDE
  # Numpad.
  $t['num0'] = 0x60; $t['num1'] = 0x61; $t['num2'] = 0x62; $t['num3'] = 0x63; $t['num4'] = 0x64
  $t['num5'] = 0x65; $t['num6'] = 0x66; $t['num7'] = 0x67; $t['num8'] = 0x68; $t['num9'] = 0x69
  $t['multiply'] = 0x6A; $t['add'] = 0x6B; $t['subtract'] = 0x6D; $t['decimal'] = 0x6E; $t['divide'] = 0x6F
  $script:KeyCodes = $t
  return $t
}

function Resolve-KeyCode {
  param([string]$Name)
  if ([string]::IsNullOrEmpty($Name)) {
    throw (New-OsError -Code 'E_TYPE' -Message 'a key name is required')
  }
  $key = $Name.Trim().ToLowerInvariant()
  $table = Get-KeyCodeTable
  # ContainsKey on a PowerShell hashtable: keys are stored case-insensitively but no culture-aware
  # comparison of the value is involved, so the control-character trap cannot reach it.
  if ($table.ContainsKey($key)) { return [int]$table[$key] }
  throw (New-OsError -Code 'E_TYPE' -Message ("unknown key name '{0}'" -f $Name) `
      -Hint 'run: dsh-os7 keyboard codes   (lists every accepted name on this platform)')
}

function Get-ModifierCodes {
  param([string[]]$Names)
  $codes = [System.Collections.ArrayList]::new()
  foreach ($n in $Names) { [void]$codes.Add((Resolve-KeyCode -Name $n)) }
  return , @($codes)
}

# Release any modifier this process may have left held. Called before a chord when --clearmodifiers is
# given, because a modifier the user is physically holding would otherwise combine with the injected
# chord and produce a different shortcut than the caller asked for.
function Clear-HeldModifiers {
  foreach ($vk in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
    [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  }
}

function Invoke-KeyboardDown {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard down'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard down' -Perm 'W'
  Assert-Desktop
  $vk = Resolve-KeyCode -Name (Get-Positional -Parsed $Parsed -Index 0)
  if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
  [DshNative]::SendKey([uint16]$vk, 0, 0)
  return [ordered]@{ action = 'down'; key = (Get-Positional -Parsed $Parsed -Index 0); vk = $vk }
}

function Invoke-KeyboardUp {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard up'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard up' -Perm 'W'
  Assert-Desktop
  $vk = Resolve-KeyCode -Name (Get-Positional -Parsed $Parsed -Index 0)
  [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  return [ordered]@{ action = 'up'; key = (Get-Positional -Parsed $Parsed -Index 0); vk = $vk }
}

function Invoke-KeyboardPress {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard press'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard press' -Perm 'W'
  Assert-Desktop
  $name = Get-Positional -Parsed $Parsed -Index 0
  $vk = Resolve-KeyCode -Name $name
  if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
  # The key is always released: a press that left the key down would keep it held for every later
  # keystroke on the desktop, and the caller has no way to see that it happened.
  [DshNative]::SendKey([uint16]$vk, 0, 0)
  [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  return [ordered]@{ action = 'press'; key = $name; vk = $vk }
}

# keyboard combination <down|up> key [key ...]
#
# The phase is an explicit positional rather than two verbs, so a chord is written the same way
# whichever direction it goes, and a caller cannot accidentally press a chord without releasing it.
function Invoke-KeyboardCombination {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'keyboard combination'
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard combination' -Perm 'W'
  Assert-Desktop
  $phase = (Get-Positional -Parsed $Parsed -Index 0).ToLowerInvariant()
  $isDown = [string]::Equals($phase, 'down', [System.StringComparison]::Ordinal)
  $isUp = [string]::Equals($phase, 'up', [System.StringComparison]::Ordinal)
  if (-not ($isDown -or $isUp)) {
    throw (New-OsError -Code 'E_USAGE' -Message ("phase must be 'down' or 'up', got '{0}'" -f $phase))
  }
  $names = @()
  $i = 1
  while ($i -lt @($Parsed.positionals).Count) {
    $t = [string]$Parsed.positionals[$i]
    # Accept both "a b c" and "a+b+c" so a chord can be written either way.
    foreach ($part in ($t -split '\+')) { if ($part -ne '') { $names += $part } }
    $i++
  }
  if ($names.Count -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'a chord needs at least one key name')
  }
  $codes = Get-ModifierCodes -Names $names
  if ($isDown) {
    if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
    # Press in order, so modifiers go down before the key they modify.
    foreach ($vk in $codes) { [DshNative]::SendKey([uint16]$vk, 0, 0) }
  } else {
    # Release in reverse, so the modified key comes up before its modifiers.
    $reversed = @($codes)
    [array]::Reverse($reversed)
    foreach ($vk in $reversed) {
      [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
    }
  }
  return [ordered]@{
    action = 'combination'
    phase = $phase
    keys = $names
    vk = $codes
  }
}

function Invoke-KeyboardType {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard type'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard type' -Perm 'W'
  Assert-Desktop
  $text = Get-Positional -Parsed $Parsed -Index 0
  $intervalText = Get-FlagValue -Parsed $Parsed -Name 'interval' -Default '0'
  $interval = Get-IntArg -Text $intervalText -Name 'interval'
  if ($interval -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("interval must not be negative, got {0}" -f $interval))
  }
  if ($text.Length -eq 0) {
    throw (New-OsError -Code 'E_NOT_TEXT' -Message 'there is no text to type')
  }

  # Each character is sent as a Unicode key event, which is why this method is used rather than
  # synthesising virtual keys: a virtual key depends on the active keyboard layout, so "%" on a German
  # layout is a different chord than on a US one. Unicode events carry the character itself, so the
  # same call types the same text on every layout, including non-ASCII.
  $sent = 0
  foreach ($ch in $text.ToCharArray()) {
    [DshNative]::SendUnicodeChar($ch)
    $sent++
    if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
  }
  return [ordered]@{
    action = 'type'
    method = 'unicode-sendinput'
    characters = $sent
    text = $text
  }
}

function Invoke-KeyboardCodes {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $table = Get-KeyCodeTable
  # Sorted exactly as the 5.1 module sorted it: Sort-Object with no -Culture, which uses the host's
  # current culture on both runtimes. Pinning an invariant culture here would have been a behavioural
  # change on a non-English host (the sorted order of the name list feeds a golden case), so the 5.1
  # call is kept as-is.
  $names = @($table.Keys | Sort-Object)
  return [ordered]@{
    platform = 'win32'
    count = $names.Length
    names = $names
  }
}

# ---------------------------------------------------------------------------
# clipboard
# ---------------------------------------------------------------------------

# The clipboard is a single global resource: only one process can hold it open, so every use is
# wrapped in try/finally and closed on every path. A leaked open clipboard makes every other
# application's copy and paste fail until this process exits.
function Invoke-ClipboardRead {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Initialize-Native
  Assert-Desktop

  $opened = $false
  try {
    $opened = [DshNative]::OpenClipboard([IntPtr]::Zero)
    if (-not $opened) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard is held by another process' `
          -Hint 'retry; another application is mid-copy')
    }
    $handle = [DshNative]::GetClipboardData([DshNative]::CF_UNICODETEXT)
    if ($handle -eq [IntPtr]::Zero) {
      # The clipboard is not empty in general, it just holds no text. E_NOT_TEXT says that precisely,
      # where a null value would be indistinguishable from a failed read.
      throw (New-OsError -Code 'E_NOT_TEXT' -Message 'the clipboard holds no text' `
          -Hint 'the clipboard may contain an image or files rather than text')
    }
    $ptr = [DshNative]::GlobalLock($handle)
    if ($ptr -eq [IntPtr]::Zero) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard text could not be locked for reading')
    }
    try {
      $text = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
    } finally {
      [void][DshNative]::GlobalUnlock($handle)
    }
    return [ordered]@{
      text = $text
      length = $text.Length
      format = 'CF_UNICODETEXT'
    }
  } finally {
    if ($opened) { [void][DshNative]::CloseClipboard() }
  }
}

function Invoke-ClipboardWrite {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'clipboard write'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'clipboard write' -Perm 'W'
  $text = Get-Positional -Parsed $Parsed -Index 0
  Initialize-Native
  Assert-Desktop

  $opened = $false
  try {
    $opened = [DshNative]::OpenClipboard([IntPtr]::Zero)
    if (-not $opened) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard is held by another process' `
          -Hint 'retry; another application is mid-copy')
    }
    if (-not [DshNative]::EmptyClipboard()) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard could not be emptied')
    }
    # GMEM_MOVEABLE is required by SetClipboardData. The buffer is deliberately never freed here: on
    # success the system takes ownership of the memory, and freeing it would leave the clipboard
    # pointing at released memory. On failure it leaks one small allocation, which is the safe side of
    # a choice with no third option.
    $bytes = ($text.Length + 1) * 2
    # [UIntPtr]$int is a cast PowerShell cannot perform; ::new is the conversion that works. This is
    # true in 7.x as well, so the 5.1 form is kept rather than swapped for a cast.
    $handle = [DshNative]::GlobalAlloc([DshNative]::GMEM_MOVEABLE, [UIntPtr]::new($bytes))
    if ($handle -eq [IntPtr]::Zero) {
      throw (New-OsError -Code 'E_IO' -Message 'memory for the clipboard text could not be allocated')
    }
    $ptr = [DshNative]::GlobalLock($handle)
    if ($ptr -eq [IntPtr]::Zero) {
      [void][DshNative]::GlobalFree($handle)
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard buffer could not be locked for writing')
    }
    try {
      # Copy the characters and a terminating null; the trailing zero is written explicitly because
      # the buffer is raw memory and nothing else will terminate the string.
      $chars = $text.ToCharArray()
      [System.Runtime.InteropServices.Marshal]::Copy($chars, 0, $ptr, $chars.Length)
      [System.Runtime.InteropServices.Marshal]::WriteInt16($ptr, $chars.Length * 2, [int16]0)
    } finally {
      [void][DshNative]::GlobalUnlock($handle)
    }
    if ([DshNative]::SetClipboardData([DshNative]::CF_UNICODETEXT, $handle) -eq [IntPtr]::Zero) {
      [void][DshNative]::GlobalFree($handle)
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard refused the text')
    }
    return [ordered]@{
      written = $text.Length
      format = 'CF_UNICODETEXT'
      text = $text
    }
  } finally {
    if ($opened) { [void][DshNative]::CloseClipboard() }
  }
}

# ---------------------------------------------------------------------------
# wait
# ---------------------------------------------------------------------------

# wait ms: an explicit sleep.
function Invoke-WaitMs {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'wait ms'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $ms = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'ms'
  if ($ms -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("ms must not be negative, got {0}" -f $ms))
  }
  if ($ms -gt 3600000) {
    # An hour is a generous ceiling. Beyond it the caller almost certainly passed seconds by mistake,
    # and silently sleeping for hours is worse than saying so.
    throw (New-OsError -Code 'E_RANGE' -Message ("ms must be at most 3600000 (one hour), got {0}" -f $ms) `
        -Hint 'the value is milliseconds; 1000 ms is one second')
  }
  $started = [DateTime]::UtcNow
  Start-Sleep -Milliseconds $ms
  return [ordered]@{
    requestedMs = $ms
    elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  }
}

# wait window: block until a window appears, or until it goes away with --absent.
function Invoke-WaitWindow {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'wait window'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $name = Get-Positional -Parsed $Parsed -Index 0
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '10000'
  $timeout = Get-IntArg -Text $timeoutText -Name 'timeout'
  if ($timeout -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("timeout must not be negative, got {0}" -f $timeout))
  }
  $intervalText = Get-FlagValue -Parsed $Parsed -Name 'interval' -Default '100'
  $interval = Get-IntArg -Text $intervalText -Name 'interval'
  if ($interval -lt 1) { $interval = 1 }
  $exact = Test-HasFlag -Parsed $Parsed -Name 'exact'
  $absent = Test-HasFlag -Parsed $Parsed -Name 'absent'

  Assert-Desktop
  $started = [DateTime]::UtcNow
  $attempts = 0
  while ($true) {
    $attempts++
    $found = $null
    foreach ($w in (Get-TopLevelWindows)) {
      $hit = $false
      if ($exact) {
        # Ordinal, as everywhere a title is compared: -ceq would ignore a control character inside the
        # title and report a window that is not the one asked for.
        $hit = [string]::Equals($w.title, $name, [System.StringComparison]::Ordinal)
      } else {
        $hit = ($w.title.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
      }
      if ($hit) { $found = $w; break }
    }
    $satisfied = $(if ($absent) { $null -eq $found } else { $null -ne $found })
    if ($satisfied) {
      return [ordered]@{
        name = $name
        condition = $(if ($absent) { 'absent' } else { 'present' })
        satisfied = $true
        attempts = $attempts
        elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
        window = $found
      }
    }
    if ([int]([DateTime]::UtcNow - $started).TotalMilliseconds -ge $timeout) {
      # Reporting the condition that was NOT met, plus how long we waited, is more useful to a caller
      # than a bare timeout: it says which way the wait failed.
      throw (New-OsError -Code 'E_TIMEOUT' `
          -Message ("window '{0}' did not become {1} within {2}ms" -f $name, $(if ($absent) { 'absent' } else { 'present' }), $timeout) `
          -Hint 'run: dsh-os7 window list   (to see the titles that exist now)')
    }
    Start-Sleep -Milliseconds $interval
  }
}

# ---------------------------------------------------------------------------
# text / structure - accessibility
# ---------------------------------------------------------------------------
#
# Both verbs ask the accessibility layer what is at a point, which is why the verb table lists
# E_ACCESSIBILITY_DENIED and E_ACCESSIBILITY_UNAVAILABLE: the API can be absent from the framework, or
# present but refusing to answer. Those are reported as distinct typed errors rather than as an empty
# result, because "there is no text here" and "I am not allowed to look" lead a caller to opposite
# next actions.
#
# The assemblies are loaded on first use, not at startup: Add-Type is expensive and most verbs never
# touch accessibility.

$script:UiaReady = $null
function Initialize-Uia {
  if ($null -ne $script:UiaReady) {
    if (-not $script:UiaReady) {
      throw (New-OsError -Code 'E_ACCESSIBILITY_UNAVAILABLE' `
          -Message 'UI Automation is not available in this PowerShell installation' `
          -Hint 'the text and structure verbs need UIAutomationClient and UIAutomationTypes')
    }
    return
  }
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    # AutomationElement.FromPoint takes a System.Windows.Point, which lives in WindowsBase and is NOT
    # pulled in by the two UIA assemblies. Without this the call fails with "Cannot find type
    # [System.Windows.Point]", which looks like an accessibility refusal but is really a missing
    # assembly - and it was being reported as E_ACCESSIBILITY_DENIED until this was found.
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    $script:UiaReady = $true
  } catch {
    $script:UiaReady = $false
    throw (New-OsError -Code 'E_ACCESSIBILITY_UNAVAILABLE' `
        -Message ("UI Automation could not be loaded: {0}" -f $_.Exception.Message) `
        -Hint 'the text and structure verbs need UIAutomationClient, UIAutomationTypes and WindowsBase')
  }
  Assert-Desktop
}

function Resolve-SourceFlag {
  param($Parsed)
  $source = Get-FlagValue -Parsed $Parsed -Name 'source' -Default 'auto'
  $source = $source.ToLowerInvariant()
  if (@('auto', 'uia', 'msaa') -notcontains $source) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unknown source '{0}'" -f $source) `
        -Hint 'accepted: auto, uia, msaa')
  }
  # Only the UIA backend is implemented. Saying so is better than silently answering from UIA when
  # the caller explicitly asked for MSAA, which reports a different element tree.
  if ([string]::Equals($source, 'msaa', [System.StringComparison]::Ordinal)) {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'the msaa source is not implemented in this build' `
        -Hint 'use source=uia or source=auto')
  }
  return $(if ([string]::Equals($source, 'auto', [System.StringComparison]::Ordinal)) { 'uia' } else { $source })
}

function Get-ElementAtPoint {
  param([int]$X, [int]$Y)
  try {
    # [System.Windows.Point]::new is the same constructor 5.1 called through New-Object. UI Automation
    # is loaded before this runs, which is what makes the type resolvable at all: the type literal is
    # bound when the statement executes, not when the function is defined.
    $point = [System.Windows.Point]::new($X, $Y)
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  } catch {
    throw (New-OsError -Code 'E_ACCESSIBILITY_DENIED' `
        -Message ("UI Automation refused to inspect the point {0},{1}: {2}" -f $X, $Y, $_.Exception.Message) `
        -Hint 'elevated windows can refuse inspection from a lower-privilege process')
  }
  if ($null -eq $el) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no accessible element at {0},{1}" -f $X, $Y))
  }
  return $el
}

function Get-ElementField {
  param($Element, [string]$Field)
  # Every property read can throw when an element disappears mid-walk, which happens constantly on a
  # live desktop. A missing field is reported as null rather than aborting the whole query.
  #
  # This is an if/elseif chain and NOT a switch. PowerShell's switch iterates its input when the input
  # is enumerable, and a STRING is enumerable as characters, so `switch ($Field)` ran the body once per
  # character: every case that matched some letter contributed a value and the result came back as an
  # array that the [string] cast then concatenated. That is why type/class/framework/automationId
  # arrived as long repeated strings while name (a property of only one case) looked correct.
  #
  # The comparisons stay -eq against fixed literals: this is a dispatch on one of seven known field
  # names, not a comparison of caller text, so the .NET 5 control-character rule cannot make two
  # different fields collide.
  try {
    if ($Field -eq 'name') { return [string]$Element.Current.Name }
    if ($Field -eq 'class') { return [string]$Element.Current.ClassName }
    # ControlType needs its ProgrammaticName: casting the object gives the type name, not the control.
    if ($Field -eq 'type') { return [string]$Element.Current.ControlType.ProgrammaticName }
    if ($Field -eq 'automationId') { return [string]$Element.Current.AutomationId }
    if ($Field -eq 'framework') { return [string]$Element.Current.FrameworkId }
    if ($Field -eq 'enabled') { return [bool]$Element.Current.IsEnabled }
    if ($Field -eq 'offscreen') { return [bool]$Element.Current.IsOffscreen }
    return $null
  } catch {
    return $null
  }
}

function Get-ElementRectValue {
  param($Element)
  try {
    $r = $Element.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch {
    return $null
  }
}

function ConvertTo-ElementObject {
  param($Element, [int]$Depth = 0)
  return [ordered]@{
    type = (Get-ElementField -Element $Element -Field 'type')
    name = (Get-ElementField -Element $Element -Field 'name')
    class = (Get-ElementField -Element $Element -Field 'class')
    automationId = (Get-ElementField -Element $Element -Field 'automationId')
    framework = (Get-ElementField -Element $Element -Field 'framework')
    enabled = (Get-ElementField -Element $Element -Field 'enabled')
    offscreen = (Get-ElementField -Element $Element -Field 'offscreen')
    rect = (Get-ElementRectValue -Element $Element)
    depth = $Depth
  }
}

# The text an element exposes, trying the patterns in order of how specific they are.
function Get-ElementText {
  param($Element)
  # ValuePattern is the right answer for an input control: it gives the content, not the label.
  try {
    $vp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $v = ([System.Windows.Automation.ValuePattern]$vp).Current.Value
      if (-not [string]::IsNullOrEmpty($v)) { return @{ text = [string]$v; via = 'ValuePattern' } }
    }
  } catch { }
  # TextPattern for documents and read-only text.
  try {
    $tp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $t = ([System.Windows.Automation.TextPattern]$tp).DocumentRange.GetText(-1)
      if (-not [string]::IsNullOrEmpty($t)) { return @{ text = [string]$t; via = 'TextPattern' } }
    }
  } catch { }
  # LegacyIAccessible carries a value for older controls that expose nothing else.
  try {
    $lp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$lp)) {
      $v = ([System.Windows.Automation.LegacyIAccessiblePattern]$lp).Current.Value
      if (-not [string]::IsNullOrEmpty($v)) { return @{ text = [string]$v; via = 'LegacyIAccessiblePattern' } }
    }
  } catch { }
  # The Name property is the last resort and is really a label, so it is reported with its source so
  # a caller can tell a control's content from its label.
  $name = Get-ElementField -Element $Element -Field 'name'
  if (-not [string]::IsNullOrEmpty($name)) { return @{ text = [string]$name; via = 'Name' } }
  return @{ text = ''; via = 'none' }
}

# Ancestors up to a limit, nearest first. Bounded because a walk can otherwise leave the window and
# climb to the desktop root, reporting text from an unrelated window.
function Get-AncestorChain {
  param($Element, [int]$Max = 8)
  $chain = [System.Collections.ArrayList]::new()
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $Element
  for ($i = 0; $i -lt $Max; $i++) {
    try { $current = $walker.GetParent($current) } catch { break }
    if ($null -eq $current) { break }
    [void]$chain.Add($current)
  }
  return , @($chain)
}

function Invoke-TextAtPoint {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'text'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  $source = Resolve-SourceFlag -Parsed $Parsed
  $maxText = Get-FlagValue -Parsed $Parsed -Name 'max-chars' -Default '4096'
  $maxChars = Get-IntArg -Text $maxText -Name 'max-chars'
  if ($maxChars -lt 1) {
    throw (New-OsError -Code 'E_RANGE' -Message ("max-chars must be at least 1, got {0}" -f $maxChars))
  }

  Initialize-Uia
  $element = Get-ElementAtPoint -X $x -Y $y
  $hit = ConvertTo-ElementObject -Element $element

  # Search the element, then its ancestors. A click lands on the innermost element, which for a text
  # editor is often a child that exposes nothing; the text lives on an ancestor.
  $via = 'none'
  $text = ''
  $sourceElement = $null
  $depthFound = 0
  $candidates = @($element) + @(Get-AncestorChain -Element $element)
  foreach ($candidate in $candidates) {
    $got = Get-ElementText -Element $candidate
    if (-not [string]::Equals($got.text, '', [System.StringComparison]::Ordinal)) {
      $text = $got.text
      $via = $got.via
      $sourceElement = ConvertTo-ElementObject -Element $candidate
      break
    }
    $depthFound++
  }

  $truncated = $false
  if ($text.Length -gt $maxChars) {
    $text = $text.Substring(0, $maxChars)
    $truncated = $true
  }

  if ([string]::Equals($via, 'none', [System.StringComparison]::Ordinal)) {
    # Nothing exposed text. That is a real answer, but an empty string would be indistinguishable
    # from a broken query, so the fields that were found are returned alongside it.
    return [ordered]@{
      point = [ordered]@{ x = $x; y = $y }
      source = $source
      found = $false
      reason = 'no element at this point exposes text'
      element = $hit
      ancestorsSearched = $depthFound
      text = ''
      via = 'none'
    }
  }

  return [ordered]@{
    point = [ordered]@{ x = $x; y = $y }
    source = $source
    found = $true
    text = $text
    length = $text.Length
    truncated = $truncated
    via = $via
    element = $hit
    # The element that actually supplied the text, which differs from the hit element when the search
    # walked up. Without it a caller cannot tell which control the text came from.
    textElement = $sourceElement
  }
}

function Invoke-StructureAtPoint {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'structure'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  $source = Resolve-SourceFlag -Parsed $Parsed
  $depthText = Get-FlagValue -Parsed $Parsed -Name 'depth' -Default '3'
  $depth = Get-IntArg -Text $depthText -Name 'depth'
  if ($depth -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("depth must not be negative, got {0}" -f $depth))
  }
  if ($depth -gt 12) {
    # A deep walk of a busy window is thousands of elements and a large envelope; the limit keeps a
    # single call from producing something unusable.
    throw (New-OsError -Code 'E_RANGE' -Message ("depth must be at most 12, got {0}" -f $depth) `
        -Hint 'a deep accessibility tree of a real window can be thousands of elements')
  }

  Initialize-Uia
  $element = Get-ElementAtPoint -X $x -Y $y

  function ConvertTo-StructureNode {
    param($Node, [int]$Level)
    # $script:StructureCount is explicit initialisation as well as shared state: Set-StrictMode would
    # throw on the first ++ if it were not initialised below before the walk starts.
    $script:StructureCount++
    $obj = ConvertTo-ElementObject -Element $Node -Depth $Level
    $children = [System.Collections.ArrayList]::new()
    if ($Level -lt $depth) {
      try {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($Node)
        while ($null -ne $child) {
          [void]$children.Add((ConvertTo-StructureNode -Node $child -Level ($Level + 1)))
          try { $child = $walker.GetNextSibling($child) } catch { break }
        }
      } catch { }
    }
    $obj['childCount'] = $children.Count
    # A node with no children gets no children field at all, which is the 5.1 shape and is what the
    # golden cases compare against.
    if ($children.Count -gt 0) { $obj['children'] = $children.ToArray() }
    return $obj
  }

  $script:StructureCount = 0
  $tree = ConvertTo-StructureNode -Node $element -Level 0
  # Collected with an explicit loop, not a pipeline. ConvertTo-ElementObject returns an ordered
  # dictionary, and a pipeline unrolls a dictionary into its KEYS, so the ForEach-Object form produced
  # raw strings joined together instead of one object per ancestor.
  $ancestors = [System.Collections.ArrayList]::new()
  foreach ($a in (Get-AncestorChain -Element $element)) {
    [void]$ancestors.Add((ConvertTo-ElementObject -Element $a))
  }
  $tree['ancestors'] = $ancestors.ToArray()

  return [ordered]@{
    point = [ordered]@{ x = $x; y = $y }
    source = $source
    depth = $depth
    nodeCount = $script:StructureCount
    root = $tree
  }
}

# ===== dispatch.ps1 ================================================

# Module: dispatch.ps1 - verb resolution and the dispatch table.

function Get-VerbKey {
  param($Parsed)
  if ($Parsed.positionals.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os7 selfcheck   (lists the full verb table)')
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
  # A case-insensitive dictionary, because verb keys are matched against caller input that may arrive
  # in any case. The 5.1 version used a plain hashtable, which is already case-insensitive in
  # PowerShell; this is explicit rather than relying on that.
  $set = [System.Collections.Generic.Dictionary[string, bool]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 1) { continue }
      $set[$f[0]] = $true
    }
  }
  # Verbs that have no group row in the table, so they are registered here rather than silently
  # resolving as a group name.
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
  # Rebuild a positional list matching the verb table (group, optional subverb, then the rest), then
  # fold any name="value" arguments into it. From here on every verb body is unaffected by which
  # calling form was used.
  $tail = $target.tail
  $rebuilt = @()
  foreach ($t in $tail) { $rebuilt += $t }
  $inner = @{ positionals = $rebuilt; flags = $Parsed.flags; named = $Parsed.named }
  $inner = Merge-NamedArguments -Parsed $inner -VerbKey $target.key

  # A switch is the right tool for a dispatch table of this size, and unlike the field-lookup case in
  # the 5.1 code the subject here is a verb key that is always a plain string, never an array.
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

    # -- assertions and read-only queries (no authorization needed) --
    'file.verify.charset' { return (Invoke-FileVerifyCharset -Parsed $inner) }
    'file.verify.encoding' { return (Invoke-FileVerifyEncoding -Parsed $inner) }
    'file.verify.completion' { return (Invoke-FileVerifyCompletion -Parsed $inner) }
    'file.search' { return (Invoke-FileSearch -Parsed $inner) }
    'execute.command' { return (Invoke-ExecuteCommand -Parsed $inner) }
    'execute.query' { return (Invoke-ExecuteQuery -Parsed $inner) }
    'execute.kill' { return (Invoke-ExecuteKill -Parsed $inner) }
    'execute.synchronous' { return (Invoke-ExecuteBatch -Parsed $inner -Sequential $true) }
    'execute.asynchronous' { return (Invoke-ExecuteBatch -Parsed $inner -Sequential $false) }
    'system.brand' { return (Invoke-SystemBrand -Parsed $inner) }
    'system.cpu' { return (Invoke-SystemCpu -Parsed $inner) }
    'system.gpu' { return (Invoke-SystemGpu -Parsed $inner) }
    'system.version' { return (Invoke-SystemVersion -Parsed $inner) }
    'system.info' { return (Invoke-SystemInfo -Parsed $inner) }
    'task.list' { return (Invoke-TaskList -Parsed $inner) }
    'task.query' { return (Invoke-TaskQuery -Parsed $inner) }
    'task.show' { return (Invoke-TaskShow -Parsed $inner) }
    'task.kill' { return (Invoke-TaskKill -Parsed $inner) }
    'task.launch' { return (Invoke-TaskLaunch -Parsed $inner) }
    'environment.list' { return (Invoke-EnvironmentList -Parsed $inner) }
    'environment.get' { return (Invoke-EnvironmentGet -Parsed $inner) }
    'environment.add' { return (Invoke-EnvironmentAdd -Parsed $inner) }
    'environment.set' { return (Invoke-EnvironmentSet -Parsed $inner) }
    'environment.delete' { return (Invoke-EnvironmentDelete -Parsed $inner) }
    'environment.attribute.list' { return (Invoke-EnvironmentAttributeList -Parsed $inner) }
    'environment.attribute.get' { return (Invoke-EnvironmentAttributeGet -Parsed $inner) }
    'environment.attribute.add' { return (Invoke-EnvironmentAttributeAdd -Parsed $inner) }
    'environment.attribute.set' { return (Invoke-EnvironmentAttributeSet -Parsed $inner) }
    'environment.attribute.delete' { return (Invoke-EnvironmentAttributeDelete -Parsed $inner) }
    'service.list' { return (Invoke-ServiceList -Parsed $inner) }
    'service.query' { return (Invoke-ServiceQuery -Parsed $inner) }
    'permission.query' { return (Invoke-PermissionQuery -Parsed $inner) }
    'permission.list' { return (Invoke-PermissionList -Parsed $inner) }
    'permission.audit' { return (Invoke-PermissionAudit -Parsed $inner) }
    'permission.grant' { return (Invoke-PermissionGrant -Parsed $inner) }
    'permission.revoke' { return (Invoke-PermissionRevoke -Parsed $inner) }
    'permission.acl.init' { return (Invoke-PermissionAclInit -Parsed $inner) }
    'window.list' { return (Invoke-WindowList -Parsed $inner) }
    'window.find' { return (Invoke-WindowFind -Parsed $inner) }
    'window.active' { return (Invoke-WindowActive -Parsed $inner) }
    'window.close' { return (Invoke-WindowClose -Parsed $inner) }
    'window.top' { return (Invoke-WindowTop -Parsed $inner) }
    'window.bottom' { return (Invoke-WindowBottom -Parsed $inner) }
    'window.move' { return (Invoke-WindowMove -Parsed $inner) }
    'window.resize' { return (Invoke-WindowResize -Parsed $inner) }
    'window.minimize' { return (Invoke-WindowMinimize -Parsed $inner) }
    'window.maximize' { return (Invoke-WindowMaximize -Parsed $inner) }
    'window.restore' { return (Invoke-WindowRestore -Parsed $inner) }
    'screenshot' { return (Invoke-Screenshot -Parsed $inner) }
    'clipboard.read' { return (Invoke-ClipboardRead -Parsed $inner) }
    'clipboard.write' { return (Invoke-ClipboardWrite -Parsed $inner) }
    'wait.ms' { return (Invoke-WaitMs -Parsed $inner) }
    'wait.window' { return (Invoke-WaitWindow -Parsed $inner) }
    'mouse.click' { return (Invoke-MouseClick -Parsed $inner) }
    'mouse.context' { return (Invoke-MouseContext -Parsed $inner) }
    'mouse.over' { return (Invoke-MouseOver -Parsed $inner) }
    'mouse.wheel' { return (Invoke-MouseWheel -Parsed $inner) }
    'mouse.down' { return (Invoke-MouseDown -Parsed $inner) }
    'mouse.up' { return (Invoke-MouseUp -Parsed $inner) }
    'mouse.cursor' { return (Invoke-MouseCursor -Parsed $inner) }
    'keyboard.down' { return (Invoke-KeyboardDown -Parsed $inner) }
    'keyboard.up' { return (Invoke-KeyboardUp -Parsed $inner) }
    'keyboard.press' { return (Invoke-KeyboardPress -Parsed $inner) }
    'keyboard.combination' { return (Invoke-KeyboardCombination -Parsed $inner) }
    'keyboard.type' { return (Invoke-KeyboardType -Parsed $inner) }
    'keyboard.codes' { return (Invoke-KeyboardCodes -Parsed $inner) }
    'text' { return (Invoke-TextAtPoint -Parsed $inner) }
    'structure' { return (Invoke-StructureAtPoint -Parsed $inner) }

    default {
      throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message ("verb '{0}' is not implemented in this build" -f $target.key) `
          -Hint 'run: dsh-os7 selfcheck   (lists every verb, so the unsupported ones are visible rather than silent)')
    }
  }
}

# ===== entry.ps1 ===================================================

# Module: entry.ps1 - the entry point: run, emit, exit.

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$watch = [System.Diagnostics.Stopwatch]::StartNew()
# $script:Verb holds the resolved dotted verb once dispatch has parsed it; before that the raw first
# token is the best label available.
$script:Verb = $null
try {
  if ($args.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os7 selfcheck')
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
  # DSH_OS_TRACE=1 sends the failing statement and call stack to stderr, which is where every human
  # diagnostic belongs; stdout stays parseable.
  #
  # The trace is written through [Console]::Error rather than Write-Error: Write-Error would add a
  # PowerShell error record to the stream and, under $ErrorActionPreference = 'Stop', could itself
  # throw inside the catch block that is trying to report the original failure.
  if ($env:DSH_OS_TRACE -eq '1') {
    [Console]::Error.WriteLine('--- dsh-os7 trace ---')
    [Console]::Error.WriteLine('code:     ' + $code)
    [Console]::Error.WriteLine('message:  ' + $message)
    [Console]::Error.WriteLine('position: ' + $_.InvocationInfo.PositionMessage)
    [Console]::Error.WriteLine('stack:    ' + ($_.ScriptStackTrace -replace "`n", ' <- '))
  }
  $errObj = New-ErrorObject -Code $code -Message $message -Hint $hint
  Write-Envelope -Verb $script:Verb -Result $null -ErrorObject $errObj -DurationMs ([int]$watch.ElapsedMilliseconds)
  exit (Get-ExitCode -Code $code)
}
