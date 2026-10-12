# Module: execute.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

function Invoke-OneShellCommand {
  param([string]$CommandLine, [string]$WorkDir, [int]$TimeoutMs, [string]$EncodingName)
  $enc = $script:NoBom
  if ($EncodingName -and $EncodingName -ne 'utf-8') {
    try { $enc = [System.Text.Encoding]::GetEncoding([int](Resolve-Charset -Name $EncodingName).dotnet) } catch { $enc = $script:NoBom }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
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
    $proc.WaitForExit()
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
      $enc = $script:NoBom
      $psi = New-Object System.Diagnostics.ProcessStartInfo
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
        $entry.proc.WaitForExit()
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

