# Module: entry.ps1 - the entry point: run, emit, exit.

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$watch = [System.Diagnostics.Stopwatch]::StartNew()
# $script:Verb holds the resolved dotted verb once dispatch has parsed it; before that the raw first
# token is the best label available.
$script:Verb = $null
try {
  if ($args.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os7 selfcheck')
  }
  $script:Verb = [string]$args[0]
  $result = Invoke-Dispatch -Argv $args
  $watch.Stop()
  Write-Envelope -Verb $script:Verb -Result $result -ErrorObject $null -DurationMs ([int]$watch.ElapsedMilliseconds)
  exit 0
} catch {
  $watch.Stop()
  $code = Get-ErrorCode -ErrorRecord $_
  $message = $_.Exception.Message
  $hint = Get-ErrorHint -ErrorRecord $_
  # DSH_OS_TRACE=1 sends the failing statement and call stack to stderr, which is where every human
  # diagnostic belongs; stdout stays parseable.
  #
  # The trace is written through [Console]::Error rather than Write-Error: Write-Error would add a
  # PowerShell error record to the stream and, under $ErrorActionPreference = 'Stop', could itself
  # throw inside the catch block that is trying to report the original failure.
  if ($env:DSH_OS_TRACE -eq '1') {
    [Console]::Error.WriteLine('--- dsh-os7 trace ---')
    [Console]::Error.WriteLine('code:     ' + $code)
    [Console]::Error.WriteLine('message:  ' + $message)
    [Console]::Error.WriteLine('position: ' + $_.InvocationInfo.PositionMessage)
    [Console]::Error.WriteLine('stack:    ' + ($_.ScriptStackTrace -replace "`n", ' <- '))
  }
  $errObj = New-ErrorObject -Code $code -Message $message -Hint $hint
  Write-Envelope -Verb $script:Verb -Result $null -ErrorObject $errObj -DurationMs ([int]$watch.ElapsedMilliseconds)
  exit (Get-ExitCode -Code $code)
}
