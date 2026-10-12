# Module: charset.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

# Lazy cache for spec/charsets.tsv. Initialised here because Get-CharsetTable reads it
# before any assignment on the first call; the split moved the declaration away from the
# function that depends on it, and an unset $script: variable is a hard error under
# Set-StrictMode.
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

