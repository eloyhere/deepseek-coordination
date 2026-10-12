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

  # Written through the raw stdout stream so the bytes are exactly what was produced: no console
  # encoding layer, and no BOM.
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
