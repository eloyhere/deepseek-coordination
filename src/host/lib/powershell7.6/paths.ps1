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
