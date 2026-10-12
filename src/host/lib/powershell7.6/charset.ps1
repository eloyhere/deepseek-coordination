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
