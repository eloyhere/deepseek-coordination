#requires -version 5.1
<#
  dsh-os - Windows implementation of the dsh-os atomic command surface.

  Contract: command.txt (authoritative), docs/os-spec.md (full spec), spec/verbs.tsv (verb table),
            spec/charsets.tsv (charset table).

  Design rules honoured here:
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

  This file is one of the modules assembled into bin/dsh-os.ps1 by tools/build.ps1. Edit the module,
  never the generated script. Modules are ASCII-only; the generated script carries the UTF-8 BOM.
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
