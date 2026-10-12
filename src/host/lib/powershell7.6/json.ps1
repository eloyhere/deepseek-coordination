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
