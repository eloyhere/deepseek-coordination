# Module: task.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

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
  $found = New-Object System.Collections.ArrayList
  $callback = [DshNative+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$param)
    $wpid = [uint32]0
    [void][DshNative]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ($wpid -eq $targetPid -and [DshNative]::IsWindowVisible($hWnd)) {
      [void]$found.Add($hWnd)
    }
    return $true
  }
  [void][DshNative]::EnumWindows($callback, [IntPtr]::Zero)

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

# task kill <pid> [--force]
#
# Without --force this asks the process to close its main window and then waits briefly for it to act.
# That is a request, and some processes ignore it - a process showing a modal dialog, for instance,
# will not exit on CloseMainWindow. The result therefore reports what actually happened
# (terminated / stillRunning) rather than what was asked for, and escalates to termination only when
# the process is still there after the grace period.
#
# With --force this terminates the process outright. That is TerminateProcess: the process cannot
# refuse it and any unsaved state is lost, which is a materially different act rather than a stronger
# version of the same one, so it is an explicit opt-in and the result says so.
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

