# Module: execute.ps1 - execute.command / synchronous / asynchronous / query / kill.
#
# Two different things live in this module and the distinction matters:
#
#   execute.command      takes an argv ARRAY and runs it with NO shell. Nothing is parsed, so a value
#                        containing spaces, quotes or shell metacharacters reaches the child exactly as
#                        given. This is the form to prefer whenever the caller knows the program.
#   execute.synchronous  take shell COMMAND STRINGS and run each through cmd.exe. The verb is named
#   execute.asynchronous "command" and the documented examples are quoted strings, so a shell is the
#                        contract there rather than a hazard.
#
# execute.query and execute.kill are process lookups by pid, kept next to the launch verbs because they
# are how a caller inspects and stops what it started.

function Invoke-OneShellCommand {
  param([string]$CommandLine, [string]$WorkDir, [int]$TimeoutMs, [string]$EncodingName)
  $enc = $script:NoBom
  if ($EncodingName -and $EncodingName -ne 'utf-8') {
    try { $enc = [System.Text.Encoding]::GetEncoding([int](Resolve-Charset -Name $EncodingName).dotnet) } catch { $enc = $script:NoBom }
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  # cmd.exe on Windows, /bin/sh elsewhere: the command line is a shell command by definition here.
  if ($env:OS -eq 'Windows_NT') {
    $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
    $psi.Arguments = '/d /s /c "' + $CommandLine + '"'
  } else {
    $psi.FileName = '/bin/sh'
    $psi.Arguments = '-c ' + $CommandLine
  }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }

  $started = [DateTime]::UtcNow
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $exited = $proc.WaitForExit($TimeoutMs)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(2000) | Out-Null } catch { }
  }
  $outText = ''
  $errText = ''
  try { $outText = $outTask.Result } catch { $outText = '' }
  try { $errText = $errTask.Result } catch { $errText = '' }
  $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  $exitCode = $(if ($exited) { $proc.ExitCode } else { $null })
  return [ordered]@{
    command = $CommandLine
    exitCode = $exitCode
    timedOut = (-not $exited)
    durationMs = $duration
    stdout = $outText
    stderr = $errText
  }
}

function Invoke-ExecuteBatch {
  param($Parsed, [bool]$Sequential)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb $(if ($Sequential) { 'execute synchronous' } else { 'execute asynchronous' })
  Assert-Allowed -Parsed $Parsed -Verb $(if ($Sequential) { 'execute synchronous' } else { 'execute asynchronous' }) -Perm 'W'
  $commands = @($Parsed.positionals)
  $workdir = Get-FlagValue -Parsed $Parsed -Name 'workdir' -Default $null
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '120000'
  $timeoutMs = Get-IntArg -Text $timeoutText -Name 'timeout'
  $encodingName = Get-FlagValue -Parsed $Parsed -Name 'encoding' -Default 'utf-8'

  $results = New-Object System.Collections.ArrayList
  $started = [DateTime]::UtcNow
  if ($Sequential) {
    # Stop at the first non-zero exit so a caller does not run later steps on a broken precondition.
    foreach ($cmd in $commands) {
      $one = Invoke-OneShellCommand -CommandLine $cmd -WorkDir $workdir -TimeoutMs $timeoutMs -EncodingName $encodingName
      [void]$results.Add($one)
      if ($one.exitCode -ne 0) { break }
    }
  } else {
    # Start every command first, then collect. Waiting inside the start loop would make it sequential.
    $running = New-Object System.Collections.ArrayList
    foreach ($cmd in $commands) {
      $psi = [System.Diagnostics.ProcessStartInfo]::new()
      if ($env:OS -eq 'Windows_NT') {
        $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
        $psi.Arguments = '/d /s /c "' + $cmd + '"'
      } else {
        $psi.FileName = '/bin/sh'
        $psi.Arguments = '-c ' + $cmd
      }
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      if ($workdir) { $psi.WorkingDirectory = $workdir }
      $p = [System.Diagnostics.Process]::Start($psi)
      [void]$running.Add([pscustomobject]@{
        command = $cmd; proc = $p
        outTask = $p.StandardOutput.ReadToEndAsync()
        errTask = $p.StandardError.ReadToEndAsync()
        started = [DateTime]::UtcNow
      })
    }
    foreach ($entry in $running) {
      $exited = $entry.proc.WaitForExit($timeoutMs)
      if (-not $exited) {
        try { $entry.proc.Kill() } catch { }
        try { $entry.proc.WaitForExit(2000) | Out-Null } catch { }
      }
      $outText = ''; $errText = ''
      try { $outText = $entry.outTask.Result } catch { }
      try { $errText = $entry.errTask.Result } catch { }
      [void]$results.Add([ordered]@{
        command = $entry.command
        exitCode = $(if ($exited) { $entry.proc.ExitCode } else { $null })
        timedOut = (-not $exited)
        durationMs = [int]([DateTime]::UtcNow - $entry.started).TotalMilliseconds
        stdout = $outText
        stderr = $errText
      })
    }
  }
  $total = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  $failed = 0
  foreach ($r in $results) { if ($r['exitCode'] -ne 0) { $failed++ } }
  return [ordered]@{
    mode = $(if ($Sequential) { 'synchronous' } else { 'asynchronous' })
    requested = $commands.Length
    executed = $results.Count
    failed = $failed
    allSucceeded = ($failed -eq 0 -and $results.Count -eq $commands.Length)
    totalDurationMs = $total
    results = $results.ToArray()
  }
}

# ---------------------------------------------------------------------------
# execute.command - an argv ARRAY run with NO shell.
#
# The distinction from the batch verbs above is the whole point of this verb: the batch verbs take
# command STRINGS and run them through cmd.exe, while this one takes argv and parses nothing, so a
# value containing spaces, quotes or metacharacters reaches the child exactly as given.
#
# THE 5.1 MODULE NEEDED TWO HELPER FUNCTIONS HERE THAT DO NOT EXIST IN THIS PORT. .NET Framework has no
# ProcessStartInfo.ArgumentList, so the only way to pass several arguments was to build ONE command
# line string by hand and implement CommandLineToArgvW's quoting rules -- doubling backslashes before a
# quote and at the end of an argument, escaping embedded quotes. That was the single largest source of
# subtle wrongness in the 5.1 code: an argument ending in a backslash would swallow its own closing
# quote and silently join the next argument.
#
# .NET 10 has ArgumentList, so each argument is handed over separately and the runtime does the quoting.
# The helpers are deliberately not carried over.
# ---------------------------------------------------------------------------
function Invoke-OneArgvCommand {
  param(
    [string[]]$Argv,
    [string]$WorkDir,
    [int]$TimeoutMs,
    [string]$StdinText,
    [hashtable]$Environment
  )
  if ($Argv.Count -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no program was given')
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $Argv[0]
  for ($i = 1; $i -lt $Argv.Count; $i++) {
    # Each element becomes its own argv entry in the child. Note that ArgumentList is only consulted
    # when Arguments has not been set; the two are mutually exclusive, which is why nothing here ever
    # assigns Arguments.
    [void]$psi.ArgumentList.Add([string]$Argv[$i])
  }
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($StdinText) { $psi.RedirectStandardInput = $true }
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
  if ($null -ne $Environment) {
    foreach ($k in $Environment.Keys) { $psi.Environment[[string]$k] = [string]$Environment[$k] }
  }

  $started = [DateTime]::UtcNow
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  } catch {
    # A program that cannot be started is E_NOT_FOUND rather than an internal error: the caller named
    # something that is not there, which is actionable.
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("could not start '{0}': {1}" -f $Argv[0], $_.Exception.Message) `
        -Hint 'the program must be an executable on PATH or an absolute path to one')
  }

  # Both pipes are drained concurrently. Reading one to completion before the other deadlocks as soon
  # as the unread pipe fills its buffer, which is how a captured command appears to hang forever.
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  if ($StdinText) {
    try {
      $proc.StandardInput.Write($StdinText)
      $proc.StandardInput.Close()
    } catch {
      # A child that never reads stdin makes this fail; that is not a reason to fail the call.
    }
  }
  $exited = $proc.WaitForExit($TimeoutMs)
  $outText = ''
  $errText = ''
  if (-not $exited) {
    # The whole process TREE is killed, not just the direct child.
    #
    # A grandchild inherits the stdout and stderr handles, so it keeps the pipes open even after the
    # direct child dies. That has two effects, and both were observed: this function blocked on the
    # output await until the grandchild exited on its own, and - because the pipes are the ones this
    # script was itself launched with - the CALLER's own process stayed alive waiting for the pipe to
    # close. A 1.2s timeout on `cmd /c ping -n 20` therefore took 19-20 SECONDS end to end.
    # `taskkill /T` terminates the descendants, which closes the handles and lets the timeout mean what
    # it says.
    try {
      $kill = [System.Diagnostics.ProcessStartInfo]::new()
      $kill.FileName = "$env:SystemRoot\System32\taskkill.exe"
      $kill.Arguments = ('/T /F /PID ' + $proc.Id)
      $kill.UseShellExecute = $false
      $kill.CreateNoWindow = $true
      $kill.RedirectStandardOutput = $true
      $kill.RedirectStandardError = $true
      $killer = [System.Diagnostics.Process]::Start($kill)
      [void]$killer.WaitForExit(5000)
    } catch {
      # Falling back to the single-process kill is still better than leaving it running.
      try { $proc.Kill() } catch { }
    }
    try { $proc.WaitForExit(2000) | Out-Null } catch { }
    # Drain what was captured, with a bound: the pipes normally close once the tree is gone, but this
    # must not become the thing that hangs if a descendant somehow survives.
    try {
      if ($outTask.Wait(2000)) { $outText = $outTask.Result }
    } catch { }
    try {
      if ($errTask.Wait(2000)) { $errText = $errTask.Result }
    } catch { }
    $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
    return [ordered]@{
      argv = $Argv
      exitCode = $null
      timedOut = $true
      durationMs = $duration
      stdout = $outText
      stderr = $errText
      shell = $false
      note = 'killed at the deadline together with its descendants, so no orphan keeps the output pipes open'
    }
  }
  try { $outText = $outTask.Result } catch { }
  try { $errText = $errTask.Result } catch { }
  $duration = [int]([DateTime]::UtcNow - $started).TotalMilliseconds

  return [ordered]@{
    argv = $Argv
    exitCode = $proc.ExitCode
    timedOut = $false
    durationMs = $duration
    stdout = $outText
    stderr = $errText
    shell = $false
  }
}

function Invoke-ExecuteCommand {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'execute command'
  Assert-Allowed -Parsed $Parsed -Verb 'execute command' -Perm 'W'
  $argv = @($Parsed.positionals)
  $workdir = Get-FlagValue -Parsed $Parsed -Name 'workdir' -Default $null
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '120000'
  $timeout = Get-IntArg -Text $timeoutText -Name 'timeout'
  $stdinText = Get-FlagValue -Parsed $Parsed -Name 'stdin' -Default $null

  $environment = $null
  $envPairs = @()
  if ($Parsed.flags.ContainsKey('env')) {
    # --env may be repeated; Get-FlagValue keeps only the last, so the raw flag value is used instead.
    $envPairs = @($Parsed.flags['env'])
  }
  if ($envPairs.Count -gt 0) {
    $environment = @{}
    foreach ($pair in $envPairs) {
      $eq = $pair.IndexOf('=')
      if ($eq -lt 1) {
        throw (New-OsError -Code 'E_USAGE' -Message ("--env expects NAME=value, got '{0}'" -f $pair))
      }
      $environment[$pair.Substring(0, $eq)] = $pair.Substring($eq + 1)
    }
  }

  # --shell switches to the batch form on purpose. Silently becoming a shell is refused, because the
  # difference between argv and a command string is precisely what this verb is about.
  if (Test-HasFlag -Parsed $Parsed -Name 'shell') {
    $one = Invoke-OneShellCommand -CommandLine ($argv -join ' ') -WorkDir $workdir -TimeoutMs $timeout -EncodingName 'utf-8'
    $one['shell'] = $true
    $one['note'] = '--shell ran this through a shell; the argv array was joined into one command line'
    return $one
  }

  if (Test-HasFlag -Parsed $Parsed -Name 'background') {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'execute command --background is not supported here' `
        -Hint 'use task launch to start something without waiting for it')
  }

  $result = Invoke-OneArgvCommand -Argv $argv -WorkDir $workdir -TimeoutMs $timeout -StdinText $stdinText -Environment $environment
  if ($result.timedOut) {
    # A timeout is a typed failure, not a successful call with a null exit code: the caller asked for a
    # command to run and did not get that.
    throw (New-OsError -Code 'E_TIMEOUT' -Message ("'{0}' did not finish within {1}ms" -f $argv[0], $timeout) `
        -Hint ("captured so far: stdout={0} bytes, stderr={1} bytes" -f $result.stdout.Length, $result.stderr.Length))
  }
  return $result
}

# ---------------------------------------------------------------------------
# execute.query / execute.kill - process lookups by pid.
#
# These live beside the launch verbs because they are how a caller inspects and stops what it started.
# execute.kill delegates to the task.kill implementation so the two cannot drift apart.
# ---------------------------------------------------------------------------
function Invoke-ExecuteQuery {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'execute query'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $targetPid = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0 -Name 'pid') -Name 'pid'
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no process with pid {0}" -f $targetPid))
  }
  $path = $null
  try { $path = $proc.Path } catch { }
  return [ordered]@{
    pid = $proc.Id
    name = $proc.ProcessName
    path = $path
    memoryBytes = [int64]$proc.WorkingSet64
    responding = [bool]$proc.Responding
    handleCount = $proc.HandleCount
    threadCount = $proc.Threads.Count
  }
}

function Invoke-ExecuteKill {
  param($Parsed)
  return (Invoke-TaskKill -Parsed $Parsed)
}
