# Module: paths.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

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
  # The PowerShell 7 entry point is protected here too, and symmetrically dsh-os.ps1 is protected in
  # the 7.6 list. Every entry point belongs to the same boundary: the script a surface is executed from
  # is part of that surface, whichever runtime it targets, so none of them may be rewritten by a verb.
  'src\host\bin\dsh-os7.ps1',
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

