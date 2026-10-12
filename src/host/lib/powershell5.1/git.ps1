#requires -version 5.1
<#
  git.ps1 - interactive git runner for Windows PowerShell 5.1 (.NET Framework 4.x).

  Standalone tool. It is NOT one of the dsh-os modules listed in tools/build.ps1, so it is never
  concatenated into bin/dsh-os.ps1 and it emits no JSON envelope: it is meant to be run by a person,
  who wants to see what will run before it runs. It follows dsh-os house rules anyway: no shell
  string is ever assembled for execution, arguments stay separate argv elements, and git is located
  by explicit search rather than assumed to be on PATH.

  ---------------------------------------------------------------------------------------------
  API BOUNDARY - what this file may use, and what it may NOT
  ---------------------------------------------------------------------------------------------
  This file targets Windows PowerShell 5.1 only. PowerShell 7.6 exposes a different API surface,
  and the two must not be assumed interchangeable:

    * $PSVersionTable.PSVersion has Build (and $PSVersionTable.CLRVersion exists) on 5.1, while
      7.6 added Patch/Revision and REMOVED CLRVersion and BuildVersion. Neither side may read the
      other's property.
    * Join-Path -ChildPath is [string] on 5.1. It accepts [string[]] only from 7.6, so every call
      here passes exactly one child.
    * Get-Command -CommandType Application works on 5.1; on 7.6 it returns nothing for executables
      on PATH, so the 7.6 file scans PATH itself instead of copying this call.
    * [Console]::OutputEncoding defaults to the OEM code page on 5.1 (so it is pinned below) and to
      UTF-8 on 7.6 (so it needs no pinning).
    * New-Object <Type>(args) is used here rather than [Type]::new(args): both parse on 5.1, but
      the 5.1 parser is the stricter one and New-Object is the form this codebase already uses.
    * $PSStyle does not exist on 5.1; 7.6 uses it and this file uses Write-Host -ForegroundColor.
    * Chinese prompt text is a literal in a UTF-8-with-BOM file. A BOM-less copy is decoded in the
      ANSI code page by 5.1 and every such literal becomes a parse error, so the BOM is load-bearing.

  Contract:
    * git is located deliberately, in this order, and never assumed:
        1. "environment"  GIT_EXE / GIT_HOME, then git already on PATH
        2. "known paths"  the Git-for-Windows registry keys, then the usual install roots
        3. "full disk"    a bounded walk of every fixed drive (skip with -NoDeepSearch)
      When nothing is found the script exits 127 with the searched locations on stderr rather than
      reporting some unrelated failure.
    * Every argument reaches git as a SEPARATE argv element. No command line is assembled for a
      shell, so a path or message containing spaces, quotes, &, | or $ is executed literally. The
      quoted command line that is printed is for reading and copy-paste only; it never runs.
    * Trailing arguments are taken as given and are NOT re-split, so
        .\git.ps1 commit "fix: a message with spaces"
      commits exactly that message. Only interactive text input is split into argv words (honouring
      "double" and 'single' quotes), because there it is the only structure available.
    * Prompts and the echoed command line go to stderr, so stdout carries git's output alone and
      "git.ps1 log > out.txt" stays clean.
    * "git add" with an empty answer is "git add ." - pressing Enter stages everything. When the
      input is not a terminal, the same empty answer is refused with an instruction instead of
      hanging on a read that can never complete.
    * Nothing runs until the command line has been echoed and confirmed, unless -Yes is given.

  Usage:
    .\git.ps1                       # numbered menu, then prompts
    .\git.ps1 add                   # asks for the paths, Enter means "."
    .\git.ps1 add "src/a b.txt"     # no prompt: the argument is taken as given
    .\git.ps1 commit "fix: spaces"  # trailing words are joined into one message
    .\git.ps1 status -DryRun        # print the command, run nothing
    .\git.ps1 log -Yes              # skip the confirmation prompt
    .\git.ps1 add . -GitPath C:\tools\git\cmd\git.exe

  Exit codes: git's own exit code, plus 2 usage error, 3 declined, 64 not interactive,
              127 git not found or not startable.
#>
# NO [CmdletBinding()] here, and that is load-bearing.
#
# Under "powershell.exe -File script.ps1 <args>" a script carrying [CmdletBinding()] refuses every
# positional argument it has no parameter for:
#     git.ps1 commit "fix: a message"
#     -> A positional parameter cannot be found that accepts argument 'commit'.
# A plain param() block leaves all unbound positional arguments in $args, which is exactly what a
# pass-through runner needs. The switches below are still bound by name; -GitPath is parsed out of
# $args by hand further down because it takes a value.
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$NoDeepSearch,
  [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Get-NextArg - read args[$Index + 1] without letting a missing value trip StrictMode.
function Get-NextArg {
  param([string[]]$Items, [int]$Index)
  if (($Index + 1) -lt $Items.Count) { return [string]$Items[$Index + 1] }
  return ''
}

# ---------------------------------------------------------------------------
# Argument parsing.
#
# $args holds everything that is not one of the bound switches. The first token is the command; the
# rest are its arguments. -GitPath is the only option that takes a value and is removed here so it
# never reaches git. A leading-dash token is only read as an option when -GitPath is a KNOWN option;
# anything else starting with '-' is left alone and flows to git untouched, so "git.ps1 log --oneline"
# and "git.ps1 commit --amend" keep working.
# ---------------------------------------------------------------------------
$script:AllArgs = @($args)
$GitPath = ''
$script:Positionals = New-Object System.Collections.ArrayList
$argIndex = 0
while ($argIndex -lt $script:AllArgs.Count) {
  $token = [string]$script:AllArgs[$argIndex]
  if ($token -eq '-GitPath') {
    $GitPath = Get-NextArg -Items $script:AllArgs -Index $argIndex
    if ($GitPath -eq '') { throw '-GitPath needs a value: -GitPath "C:\Program Files\Git\cmd\git.exe"' }
    $argIndex += 2
    continue
  }
  [void]$script:Positionals.Add($token)
  $argIndex++
}

$Command = ''
if ($script:Positionals.Count -gt 0) { $Command = [string]$script:Positionals[0] }
$script:TrailingArgs = @()
if ($script:Positionals.Count -gt 1) {
  $script:TrailingArgs = @($script:Positionals[1..($script:Positionals.Count - 1)])
}

# ---------------------------------------------------------------------------
# Streams.
#   stdout: git's own output, untouched.
#   stderr: prompts, the echoed command line, warnings, the "not found" report.
# Keeping them apart is what makes output redirectable.
# ---------------------------------------------------------------------------
$script:UseColor = -not $Quiet
try {
  # A redirected stderr is not a terminal; escape sequences there would corrupt a log file.
  if ([Console]::IsErrorRedirected) { $script:UseColor = $false }
} catch {
  $script:UseColor = $false
}
try {
  # 5.1 starts on the OEM code page. git emits UTF-8, so without this pin a non-ASCII commit
  # message is displayed as garbage. (7.6 already defaults to UTF-8 and does not need this.)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # A hostless or redirected console can refuse this; the bytes written are unaffected.
}

function Write-Line {
  param([string]$Text = '', [string]$Color = '')
  if ($script:UseColor -and $Color -ne '') {
    Write-Host $Text -ForegroundColor $Color
  } else {
    Write-Host $Text
  }
}

function Write-ErrLine {
  param([string]$Text = '')
  [Console]::Error.WriteLine($Text)
}

function Write-Fail {
  param([string]$Text)
  [Console]::Error.WriteLine('git.ps1: ' + $Text)
}

# ---------------------------------------------------------------------------
# Interaction. Each read reports whether an answer was actually available, so a non-interactive
# caller is told to pass arguments rather than left waiting on a read that cannot complete.
# ---------------------------------------------------------------------------
function Test-CanPrompt {
  try {
    if ([Console]::IsInputRedirected) { return $false }
  } catch {
    return $false
  }
  return $true
}

# Read-Prompt <label> [default] -> $script:Answer ('' when the user just pressed Enter).
#
# [Console]::In.ReadLine() is used instead of Read-Host on purpose: Read-Host consumes redirected
# stdin, and a blank line from it is indistinguishable from "no input available". ReadLine returns
# $null at end of input, which is exactly the signal needed to refuse rather than loop.
function Read-Prompt {
  param([string]$Label, [string]$Default = '')
  $script:Answer = ''
  if (-not (Test-CanPrompt)) {
    throw ('no value for "' + $Label + '" and stdin is not a terminal: pass the value as an ' +
      'argument instead, for example: git.ps1 add "path"')
  }
  $suffix = if ($Default -ne '') { ' [' + $Default + ']' } else { '' }
  Write-Line ''
  Write-Line ('  ' + $Label + $suffix) 'Cyan'
  Write-Host '  > ' -NoNewline
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { throw ('end of input while reading "' + $Label + '"') }
  if ($line -eq '' -and $Default -ne '') { $line = $Default }
  $script:Answer = $line.Trim()
}

function Read-Confirm {
  param([string]$Question, [string]$Default = 'y')
  if ($Yes) { return $true }
  if (-not (Test-CanPrompt)) {
    throw ('confirmation is required for "' + $Question + '" and stdin is not a terminal: re-run with -Yes')
  }
  $hint = if ($Default -eq 'y') { '[Y/n]' } else { '[y/N]' }
  Write-Host ('  ' + $Question + ' ' + $hint + ' ') -NoNewline
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { return $false }
  $line = $line.Trim().ToLowerInvariant()
  if ($line -eq '') { return ($Default -eq 'y') }
  return ($line -eq 'y' -or $line -eq 'yes')
}

# Split-ArgumentText - break interactive input into argv words.
#
# This is the ONLY place a line of text becomes several arguments, and it is quote-aware so that
# "a b.txt" stays one argument. It exists because a prompt can only produce a string; every other
# path into this script carries the caller's own argv, which needs no splitting at all.
function Split-ArgumentText {
  param([string]$Text)
  $words = New-Object System.Collections.ArrayList
  if ([string]::IsNullOrEmpty($Text)) { return $words.ToArray() }
  $current = New-Object System.Text.StringBuilder
  $quote = [char]0
  $inWord = $false
  foreach ($ch in $Text.ToCharArray()) {
    if ($quote -ne [char]0) {
      if ($ch -eq $quote) { $quote = [char]0 } else { [void]$current.Append($ch) }
      continue
    }
    if ($ch -eq '"' -or $ch -eq "'") { $quote = $ch; $inWord = $true; continue }
    if ($ch -eq ' ' -or $ch -eq "`t") {
      if ($inWord) { [void]$words.Add($current.ToString()); [void]$current.Clear(); $inWord = $false }
      continue
    }
    [void]$current.Append($ch)
    $inWord = $true
  }
  if ($inWord) { [void]$words.Add($current.ToString()) }
  return $words.ToArray()
}

# ---------------------------------------------------------------------------
# Quoting, for display only.
#   Always double quotes, as specified: one rule, no judgement call about which argument "needs"
#   quoting. Embedded double quotes and trailing backslashes are escaped the way cmd.exe expects,
#   because that is the shell such a line would realistically be pasted into. git never sees this
#   string, so the escaping cannot corrupt an argument on the real execution path.
# ---------------------------------------------------------------------------
function ConvertTo-DisplayToken {
  param([string]$Value)
  $v = $Value -replace '(\\*)"', '$1$1\"'
  $v = $v -replace '(\\+)$', '$1$1'
  return '"' + $v + '"'
}

function Format-DisplayCommand {
  param([string]$GitExe, [string[]]$Argv)
  $parts = New-Object System.Collections.ArrayList
  [void]$parts.Add((ConvertTo-DisplayToken -Value $GitExe))
  foreach ($a in $Argv) { [void]$parts.Add((ConvertTo-DisplayToken -Value $a)) }
  return ($parts -join ' ')
}

# ---------------------------------------------------------------------------
# git discovery.
# ---------------------------------------------------------------------------
$script:GitSource = ''
$script:GitVersion = ''

function Test-GitCandidate {
  param([string]$Candidate)
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
  } catch {
    return $false
  }
  $probe = @(& $Candidate '--version' 2>$null)
  if ($LASTEXITCODE -ne 0) { return $false }
  $script:GitVersion = [string]($probe | Select-Object -First 1)
  return $true
}

function Get-GitFromEnvironment {
  # Phase 1: the environment decides. GIT_EXE wins outright; GIT_HOME is an install root whose
  # cmd\git.exe is the launcher; PATH is the last word within this phase.
  $value = [Environment]::GetEnvironmentVariable('GIT_EXE')
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    if (Test-GitCandidate -Candidate $value) { return $value }
    Write-ErrLine ('  note: GIT_EXE is set to "' + $value + '" but that is not a runnable git')
  }
  $gitHome = [Environment]::GetEnvironmentVariable('GIT_HOME')
  if (-not [string]::IsNullOrWhiteSpace($gitHome)) {
    # One child per Join-Path call: -ChildPath is [string] on 5.1 and only became [string[]] in 7.6.
    foreach ($leaf in @('cmd\git.exe', 'bin\git.exe', 'git.exe', 'mingw64\bin\git.exe')) {
      $candidate = Join-Path $gitHome $leaf
      if (Test-GitCandidate -Candidate $candidate) { return $candidate }
    }
    Write-ErrLine ('  note: GIT_HOME is set to "' + $gitHome + '" but it holds no runnable git')
  }
  # -CommandType Application is honoured by 5.1: it resolves PATH entries and rejects aliases and
  # functions, which is why the result is still probed with --version rather than trusted.
  $found = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $found -and (Test-GitCandidate -Candidate $found.Source)) { return $found.Source }
  return $null
}

function Get-GitFromKnownPaths {
  # Phase 2a: the registry. Git for Windows records its install root here, which is exactly the case
  # a hardcoded path list misses when someone installed it to D:\Git.
  foreach ($key in @('HKLM:\SOFTWARE\GitForWindows',
                     'HKLM:\SOFTWARE\WOW6432Node\GitForWindows',
                     'HKCU:\SOFTWARE\GitForWindows')) {
    $item = $null
    try { $item = Get-ItemProperty -Path $key -ErrorAction Stop } catch { continue }
    foreach ($name in @('InstallPath', 'InstallDir')) {
      $value = $null
      try { $value = $item.$name } catch { $value = $null }
      if ([string]::IsNullOrWhiteSpace($value)) { continue }
      foreach ($leaf in @('cmd\git.exe', 'bin\git.exe', 'git.exe', 'mingw64\bin\git.exe')) {
        $candidate = Join-Path $value $leaf
        if (Test-GitCandidate -Candidate $candidate) { return $candidate }
      }
    }
  }

  # Phase 2b: the usual install roots, bounded. Each entry is "look under here", not "git lives
  # here", because the directory differs per installer and Scoop/Chocolatey both matter.
  $seeds = New-Object System.Collections.ArrayList
  foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'SystemDrive')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($value)) { [void]$seeds.Add($value) }
  }
  [void]$seeds.Add((Join-Path $env:ProgramFiles 'Git'))
  $userProfile = $env:USERPROFILE
  [void]$seeds.Add((Join-Path $userProfile 'scoop'))
  [void]$seeds.Add((Join-Path $userProfile 'scoop\shims'))
  [void]$seeds.Add((Join-Path $userProfile 'scoop\apps\git'))
  [void]$seeds.Add((Join-Path $userProfile 'AppData\Local\GitHubDesktop'))
  [void]$seeds.Add((Join-Path $userProfile 'AppData\Local\Programs\Git'))
  [void]$seeds.Add((Join-Path $userProfile 'AppData\Local\SourceTree'))
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    [void]$seeds.Add((Join-Path $env:LOCALAPPDATA 'Programs'))
  }
  $roots = @($seeds | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  return (Find-GitUnder -Roots $roots -MaxDepth 3 -TimeoutSeconds 60)
}

function Get-GitFromFullDisk {
  # Phase 3: every fixed drive, bounded three ways, because an unbounded walk of a system disk is a
  # hang that looks like a bug: a depth cap, a wall-clock budget, and a prune list for trees that
  # provably never hold an installed git yet contain a great many files.
  $roots = New-Object System.Collections.ArrayList
  try {
    foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction Stop)) {
      if ($drive.Root -and (Test-Path -LiteralPath $drive.Root)) { [void]$roots.Add($drive.Root) }
    }
  } catch {
    # A drive that cannot be enumerated is not a reason to abandon the search.
  }
  if ($roots.Count -eq 0) { return $null }
  Write-ErrLine '  searching every drive for git.exe (depth 6; this can take a while)'
  return (Find-GitUnder -Roots $roots -MaxDepth 6 -TimeoutSeconds 180)
}

function Find-GitUnder {
  param([string[]]$Roots, [int]$MaxDepth, [int]$TimeoutSeconds)
  $prune = @('Windows', 'node_modules', '$Recycle.Bin', 'System Volume Information', 'WinSxS',
    'Windows.old', 'Recovery', 'perflogs', 'Temp', 'tmp', 'Cache', 'cache')
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $scanned = 0
  $truncated = $false
  # An explicit stack rather than recursion: PowerShell's recursion limit is far below what a deep
  # tree needs, and a stack makes the "stop right now" cases cheap to honour.
  $stack = New-Object System.Collections.Stack
  foreach ($root in $Roots) { $stack.Push(@{ path = $root; depth = 0 }) }
  while ($stack.Count -gt 0) {
    $node = $stack.Pop()
    $dir = [string]$node.path
    $depth = [int]$node.depth
    if ($prune -contains (Split-Path -Leaf $dir)) { continue }
    $scanned++
    if (($scanned % 4000) -eq 0 -and $watch.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
      $truncated = $true
      break
    }
    $candidate = Join-Path $dir 'git.exe'
    try {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        if (Test-GitCandidate -Candidate $candidate) { return $candidate }
      }
    } catch {
      # An unreadable directory is expected (ACLs, junctions); keep walking.
    }
    if ($depth -ge $MaxDepth) { continue }
    try {
      foreach ($child in [System.IO.Directory]::GetDirectories($dir)) {
        $stack.Push(@{ path = $child; depth = ($depth + 1) })
      }
    } catch {
      # .NET throws on the first unreadable child, so the whole enumeration is guarded; a partial
      # listing is still worth walking.
      try {
        foreach ($child in (Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
          $stack.Push(@{ path = $child.FullName; depth = ($depth + 1) })
        }
      } catch {
        # Nothing here is readable at all.
      }
    }
  }
  if ($truncated) {
    Write-ErrLine ('  note: the full-disk search hit its ' + $TimeoutSeconds + 's budget after ' +
      $scanned + ' directories and may have stopped early')
  }
  return $null
}

function Resolve-GitExe {
  if (-not [string]::IsNullOrWhiteSpace($GitPath)) {
    if (Test-GitCandidate -Candidate $GitPath) {
      $script:GitSource = 'argument -GitPath'
      return $GitPath
    }
    Write-Fail ('-GitPath "' + $GitPath + '" is not a runnable git')
    exit 127
  }
  $script:GitVersion = ''
  Write-Line '  git.ps1 - locating git'
  $found = Get-GitFromEnvironment
  if ($found) { $script:GitSource = 'environment (GIT_EXE / GIT_HOME / PATH)'; return $found }
  Write-ErrLine '  not in the environment; checking the known install locations'
  $found = Get-GitFromKnownPaths
  if ($found) { $script:GitSource = 'known install paths'; return $found }
  if ($NoDeepSearch) {
    Write-ErrLine '  not in the known install locations (-NoDeepSearch was given, so the drive walk was skipped)'
  } else {
    Write-ErrLine '  not in the known install locations; walking every drive'
    $found = Get-GitFromFullDisk
    if ($found) { $script:GitSource = 'full-disk search'; return $found }
  }
  return $null
}

# ---------------------------------------------------------------------------
# git invocation.
# ---------------------------------------------------------------------------
function Invoke-Git {
  param([string[]]$GitArgv)
  $gitExe = $script:GitExe
  Write-ErrLine ''
  Write-ErrLine '  equivalent command line (every argument double quoted):'
  Write-ErrLine ('    ' + (Format-DisplayCommand -GitExe $gitExe -Argv $GitArgv))
  Write-ErrLine ''
  if ($DryRun) {
    Write-ErrLine '  -DryRun: nothing was executed.'
    return 0
  }
  if (-not (Read-Confirm -Question 'run it?' -Default 'y')) {
    Write-ErrLine '  declined; nothing was executed.'
    return 3
  }
  Write-ErrLine ''
  $code = 0
  try {
    # The array is splatted straight to the executable: no shell, no re-parsing, no string.
    & $gitExe @GitArgv
    $code = $LASTEXITCODE
  } catch {
    Write-Fail ('could not run "' + $gitExe + '": ' + $_.Exception.Message)
    return 127
  }
  Write-ErrLine ''
  Write-ErrLine ('  git exited with code ' + $code)
  return $code
}

# ---------------------------------------------------------------------------
# Command specifications: prompt text, whether the caller's trailing arguments are one value or a
# list, and what Enter means when a field is left empty.
#
#   s    - one prompt, kept as a single argument (spaces included)
#   sw   - one prompt, split on whitespace into several arguments
#   raw  - every remaining argument goes to git unchanged
#   none - no input at all
# ---------------------------------------------------------------------------
function New-CommandSpec {
  param([string]$Usage, [string]$Help, [object[]]$Prompts = @(),
        [string]$Accept = 'none', [string]$Default = '', [string]$DefaultFor = '')
  return @{ Usage = $Usage; Help = $Help; Prompts = @($Prompts)
            Accept = $Accept; Default = $Default; DefaultFor = $DefaultFor }
}

$script:GitCommands = [ordered]@{
  'add'      = New-CommandSpec -Usage 'add [path...]' -Help 'stage changes' -Prompts @('路径 / pathspec') -Accept 'sw' -Default '.' -DefaultFor '路径 / pathspec'
  'commit'   = New-CommandSpec -Usage 'commit [message]' -Help 'record staged changes' -Prompts @('提交信息 / commit message') -Accept 's'
  'status'   = New-CommandSpec -Usage 'status' -Help 'show the working tree state'
  'diff'     = New-CommandSpec -Usage 'diff [path...]' -Help 'show unstaged changes' -Prompts @('路径（可空） / path') -Accept 'sw'
  'log'      = New-CommandSpec -Usage 'log [count]' -Help 'show recent history' -Prompts @('显示条数 / count') -Accept 's' -Default '20'
  'branch'   = New-CommandSpec -Usage 'branch [name]' -Help 'list or create a branch' -Prompts @('分支名（回车 = 列出全部） / branch name') -Accept 's'
  'checkout' = New-CommandSpec -Usage 'checkout [ref]' -Help 'switch branch or restore files' -Prompts @('分支 / 提交 / 文件') -Accept 's'
  'switch'   = New-CommandSpec -Usage 'switch [branch]' -Help 'switch branch' -Prompts @('分支名 / branch') -Accept 's'
  'merge'    = New-CommandSpec -Usage 'merge [ref]' -Help 'merge a branch into the current one' -Prompts @('分支 / 提交') -Accept 's'
  'pull'     = New-CommandSpec -Usage 'pull [remote] [branch]' -Help 'fetch and integrate' -Prompts @('远端（回车 = origin）', '分支（回车 = 跟踪分支）') -Accept 'sw'
  'push'     = New-CommandSpec -Usage 'push [remote] [branch]' -Help 'publish local commits' -Prompts @('远端（回车 = origin）', '分支（回车 = 当前分支）', '附加选项，如 -u 或 --force-with-lease（可空）') -Accept 'sw'
  'fetch'    = New-CommandSpec -Usage 'fetch [remote]' -Help 'download refs without merging' -Prompts @('远端（可空） / remote') -Accept 's'
  'clone'    = New-CommandSpec -Usage 'clone <repository> [directory]' -Help 'copy a repository' -Prompts @('仓库地址 / repository', '目标目录（可空）') -Accept 's'
  'restore'  = New-CommandSpec -Usage 'restore <path...>' -Help 'discard working-tree changes' -Prompts @('路径 / path') -Accept 'sw'
  'reset'    = New-CommandSpec -Usage 'reset [mode] <target>' -Help 'move HEAD or unstage' -Prompts @('模式 / mode', '目标 / target') -Accept 'sw' -Default '--mixed'
  'stash'    = New-CommandSpec -Usage 'stash [push|pop|list|drop]' -Help 'shelve working-tree changes' -Prompts @('动作 / action', '说明（仅 push 用，可空） / message') -Accept 's' -Default 'push'
  'tag'      = New-CommandSpec -Usage 'tag [name] [message]' -Help 'list or create a tag' -Prompts @('标签名（回车 = 列出全部） / tag name', '附注说明（可空） / message') -Accept 's'
  'remote'   = New-CommandSpec -Usage 'remote [-v]' -Help 'list or manage remotes' -Prompts @('动作 / action', '远端名', '地址 URL') -Accept 'sw' -Default '-v'
  'rm'       = New-CommandSpec -Usage 'rm [-r] [-f] <path...>' -Help 'remove files and stage the removal' -Prompts @('路径 / path') -Accept 'sw'
  'mv'       = New-CommandSpec -Usage 'mv <source> <destination>' -Help 'move or rename and stage it' -Prompts @('源 / source', '目标 / destination') -Accept 's'
}

$script:MenuOrder = @(
  'add', 'commit', 'status', 'diff', 'log', 'branch', 'checkout', 'switch', 'merge',
  'pull', 'push', 'fetch', 'clone', 'restore', 'reset', 'stash', 'tag', 'remote', 'rm', 'mv'
)

function Show-Menu {
  Write-Line ''
  Write-Line '  可用命令 / available commands' 'Cyan'
  $index = 0
  foreach ($name in $script:MenuOrder) {
    $index++
    $spec = $script:GitCommands[$name]
    Write-Line ('   {0,2}. {1,-9} {2}' -f $index, $name, $spec.Help)
  }
  Write-Line ''
}

function Resolve-CommandName {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) {
    if (-not (Test-CanPrompt)) {
      throw 'no command given and stdin is not a terminal: pass one as the first argument (git.ps1 add)'
    }
    Show-Menu
    Read-Prompt -Label '命令名或编号 / command name or number'
    $answer = $script:Answer
    if ($answer -cmatch '^[0-9]+$') {
      $index = [int]$answer
      if ($index -ge 1 -and $index -le $script:MenuOrder.Count) { return $script:MenuOrder[$index - 1] }
      throw ('there is no menu entry ' + $answer)
    }
    if ($answer -eq '') { throw 'no command selected' }
    $Name = $answer
  }
  $key = $Name.Trim().ToLowerInvariant()
  if (-not $script:GitCommands.Contains($key)) {
    throw ('unknown command "' + $Name + '"; known: ' + (($script:MenuOrder) -join ', '))
  }
  return $key
}

# Get-CommandArguments - the command spec plus whatever the caller supplied, turned into git's argv.
function Get-CommandArguments {
  param([string]$Name, [hashtable]$Spec)
  $prompts = @($Spec.Prompts)
  $out = New-Object System.Collections.ArrayList
  [void]$out.Add($Name)

  if ($Spec.Accept -eq 'none') {
    if ($script:TrailingArgs.Count -gt 0) {
      throw ($Name + ' takes no arguments, but got: ' + ($script:TrailingArgs -join ' '))
    }
    return $out.ToArray()
  }

  # Arguments were supplied, so there is nothing to ask: a prompt exists only for the case where the
  # caller gave no value at all. This is what makes
  #   git.ps1 add "src/a b.txt" "src/c.txt"
  # stage exactly those two paths instead of prompting and then ignoring what was typed.
  if ($script:TrailingArgs.Count -gt 0) {
    if ($Spec.Accept -eq 's') {
      # 's': the caller's argv becomes the single value, joined so that both
      #   commit "fix: a b"    (one element) and
      #   commit fix: a b      (three elements)
      # produce the one message the caller meant. Nothing is re-split afterwards.
      [void]$out.Add(($script:TrailingArgs -join ' '))
    } else {
      # 'raw' and 'sw': every element is handed through as its own argument, so a caller-supplied
      # path containing spaces survives untouched.
      foreach ($a in $script:TrailingArgs) { [void]$out.Add($a) }
    }
    return $out.ToArray()
  }

  # Interactive: one prompt per field. A field answered with Enter keeps its default, or drops out
  # of the argument list entirely when it has none - which is what turns "git add" + Enter into
  # "git add ." while leaving "git push" + Enter as a plain "git push".
  for ($i = 0; $i -lt $prompts.Count; $i++) {
    $default = ''
    if ($Spec.Default -ne '' -and $i -eq 0) { $default = $Spec.Default }
    Read-Prompt -Label ([string]$prompts[$i]) -Default $default
    $answer = $script:Answer
    if ($answer -eq '') { continue }
    if ($Spec.Accept -eq 'sw') {
      foreach ($word in (Split-ArgumentText -Text $answer)) { [void]$out.Add($word) }
    } else {
      [void]$out.Add($answer)
    }
  }
  return $out.ToArray()
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
$script:Answer = ''
$script:GitExe = ''

$resolved = Resolve-GitExe
if (-not $resolved) {
  Write-ErrLine ''
  Write-Fail 'git was not found anywhere on this machine.'
  Write-ErrLine '  searched, in order:'
  Write-ErrLine '    1. environment   GIT_EXE, GIT_HOME, PATH'
  Write-ErrLine '    2. known paths   HKLM/HKCU SOFTWARE\GitForWindows, Program Files, ProgramData,'
  Write-ErrLine '                     %LOCALAPPDATA%\Programs, scoop, GitHub Desktop, SourceTree'
  if ($NoDeepSearch) {
    Write-ErrLine '    3. full disk     SKIPPED (-NoDeepSearch)'
  } else {
    Write-ErrLine '    3. full disk     every fixed drive, depth 6, 180s budget'
  }
  Write-ErrLine '  install Git for Windows, put git on PATH, or point at it directly:'
  Write-ErrLine '    .\git.ps1 add -GitPath "C:\Program Files\Git\cmd\git.exe"'
  exit 127
}
$script:GitExe = $resolved

$name = Resolve-CommandName -Name $Command
$spec = $script:GitCommands[$name]
$gitArgv = Get-CommandArguments -Name $name -Spec $spec

$versionText = ''
if ($script:GitVersion -ne '') { $versionText = '  (' + $script:GitVersion + ')' }
Write-Line ''
Write-Line ('  git: ' + $script:GitExe + $versionText) 'Green'
Write-Line ('  found via: ' + $script:GitSource)
Write-Line ('  command: git ' + $spec.Usage)

exit (Invoke-Git -GitArgv $gitArgv)