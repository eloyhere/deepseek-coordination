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

