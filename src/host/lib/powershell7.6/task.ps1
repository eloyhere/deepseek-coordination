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
