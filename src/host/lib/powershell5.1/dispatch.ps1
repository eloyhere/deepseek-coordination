# Module: dispatch.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

function Get-VerbKey {
  param($Parsed)
  if ($Parsed.positionals.Length -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'no verb given' -Hint 'run: dsh-os selfcheck   (lists the full verb table)')
  }
  # Verbs are one to three tokens deep: "selfcheck", "file charset", "file verify charset". A token
  # continues the verb only when it looks like a verb word (lowercase, no digits at the start) and
  # some verb in the table starts with the extended key. Membership is deliberately not required at
  # each step: "file.verify" is not itself a verb, but "file.verify.charset" is.
  $key = [string]$Parsed.positionals[0]
  $consumed = 1
  $known = Get-KnownVerbs
  while ($consumed -lt 3 -and $consumed -lt $Parsed.positionals.Length) {
    $token = [string]$Parsed.positionals[$consumed]
    if ($token.StartsWith('-')) { break }
    if ($token -notmatch '^[a-z][a-z0-9-]*$') { break }
    $candidate = $key + '.' + $token
    $extends = $false
    foreach ($knownVerb in $known.Keys) {
      if ($knownVerb -eq $candidate -or $knownVerb.StartsWith($candidate + '.')) { $extends = $true; break }
    }
    if (-not $extends) { break }
    $key = $candidate
    $consumed++
  }
  $tail = @()
  for ($i = $consumed; $i -lt $Parsed.positionals.Length; $i++) { $tail += $Parsed.positionals[$i] }
  return @{ key = $key; tail = $tail }
}

$script:KnownVerbs = $null

function Get-KnownVerbs {
  if ($null -ne $script:KnownVerbs) { return $script:KnownVerbs }
  $set = @{}
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 1) { continue }
      $set[$f[0]] = $true
    }
  }
  # selfcheck is a top-level verb with no group.
  $set['selfcheck'] = $true
  $set['text'] = $true
  $set['structure'] = $true
  $set['screenshot'] = $true
  $script:KnownVerbs = $set
  return $set
}

function Test-KnownVerb {
  param([string]$Key)
  return (Get-KnownVerbs).ContainsKey($Key)
}

function Invoke-Dispatch {
  param([string[]]$Argv)
  $Parsed = Parse-Arguments -Argv $Argv
  $script:Pretty = (Test-HasFlag -Parsed $Parsed -Name 'pretty')
  $script:Quiet = (Test-HasFlag -Parsed $Parsed -Name 'quiet')

  $target = Get-VerbKey -Parsed $Parsed
  $script:Verb = $target.key
  # Rebuild a positional list matching the verb table (group, optional subverb, then the rest), then
  # fold any name="value" arguments into it. From here on every verb body is unaffected by which
  # calling form was used.
  $tail = $target.tail
  $rebuilt = @()
  foreach ($t in $tail) { $rebuilt += $t }
  $inner = @{ positionals = $rebuilt; flags = $Parsed.flags; named = $Parsed.named }
  $inner = Merge-NamedArguments -Parsed $inner -VerbKey $target.key

  switch ($target.key) {
    'file.create' { return (Invoke-FileCreate -Parsed $inner) }
    'file.charset' { return (Invoke-FileCharset -Parsed $inner) }
    'file.encode' { return (Invoke-FileEncode -Parsed $inner) }
    'file.length' { return (Invoke-FileLength -Parsed $inner) }
    'file.information' { return (Invoke-FileInformation -Parsed $inner) }
    'file.list' { return (Invoke-FileList -Parsed $inner) }
    'file.delete' { return (Invoke-FileDelete -Parsed $inner) }
    'file.move' { return (Invoke-FileMove -Parsed $inner) }
    'file.copy' { return (Invoke-FileCopy -Parsed $inner) }
    'file.mkdir' { return (Invoke-FileMkdir -Parsed $inner) }
    'file.append' { return (Invoke-FileAppend -Parsed $inner) }
    'file.insert' { return (Invoke-FileInsert -Parsed $inner) }
    'file.view' { return (Invoke-FileView -Parsed $inner) }
    'selfcheck' { return (Invoke-Selfcheck -Parsed $Parsed) }

    # -- round 2: assertions and read-only queries (no authorization needed) --
    'file.verify.charset' { return (Invoke-FileVerifyCharset -Parsed $inner) }
    'file.verify.encoding' { return (Invoke-FileVerifyEncoding -Parsed $inner) }
    'file.verify.completion' { return (Invoke-FileVerifyCompletion -Parsed $inner) }
    'file.search' { return (Invoke-FileSearch -Parsed $inner) }
    'execute.command' { return (Invoke-ExecuteCommand -Parsed $inner) }
    'execute.query' { return (Invoke-ExecuteQuery -Parsed $inner) }
    'execute.kill' { return (Invoke-ExecuteKill -Parsed $inner) }
    'execute.synchronous' { return (Invoke-ExecuteBatch -Parsed $inner -Sequential $true) }
    'execute.asynchronous' { return (Invoke-ExecuteBatch -Parsed $inner -Sequential $false) }
    'system.brand' { return (Invoke-SystemBrand -Parsed $inner) }
    'system.cpu' { return (Invoke-SystemCpu -Parsed $inner) }
    'system.gpu' { return (Invoke-SystemGpu -Parsed $inner) }
    'system.version' { return (Invoke-SystemVersion -Parsed $inner) }
    'system.info' { return (Invoke-SystemInfo -Parsed $inner) }
    'task.list' { return (Invoke-TaskList -Parsed $inner) }
    'task.query' { return (Invoke-TaskQuery -Parsed $inner) }
    'task.show' { return (Invoke-TaskShow -Parsed $inner) }
    'task.kill' { return (Invoke-TaskKill -Parsed $inner) }
    'task.launch' { return (Invoke-TaskLaunch -Parsed $inner) }
    'environment.list' { return (Invoke-EnvironmentList -Parsed $inner) }
    'environment.get' { return (Invoke-EnvironmentGet -Parsed $inner) }
    'environment.add' { return (Invoke-EnvironmentAdd -Parsed $inner) }
    'environment.set' { return (Invoke-EnvironmentSet -Parsed $inner) }
    'environment.delete' { return (Invoke-EnvironmentDelete -Parsed $inner) }
    'environment.attribute.list' { return (Invoke-EnvironmentAttributeList -Parsed $inner) }
    'environment.attribute.get' { return (Invoke-EnvironmentAttributeGet -Parsed $inner) }
    'environment.attribute.add' { return (Invoke-EnvironmentAttributeAdd -Parsed $inner) }
    'environment.attribute.set' { return (Invoke-EnvironmentAttributeSet -Parsed $inner) }
    'environment.attribute.delete' { return (Invoke-EnvironmentAttributeDelete -Parsed $inner) }
    'service.list' { return (Invoke-ServiceList -Parsed $inner) }
    'service.query' { return (Invoke-ServiceQuery -Parsed $inner) }
    'permission.query' { return (Invoke-PermissionQuery -Parsed $inner) }
    'permission.list' { return (Invoke-PermissionList -Parsed $inner) }
    'permission.audit' { return (Invoke-PermissionAudit -Parsed $inner) }
    'permission.grant' { return (Invoke-PermissionGrant -Parsed $inner) }
    'permission.revoke' { return (Invoke-PermissionRevoke -Parsed $inner) }
    'permission.acl.init' { return (Invoke-PermissionAclInit -Parsed $inner) }
    'window.list' { return (Invoke-WindowList -Parsed $inner) }
    'window.find' { return (Invoke-WindowFind -Parsed $inner) }
    'window.active' { return (Invoke-WindowActive -Parsed $inner) }
    'window.close' { return (Invoke-WindowClose -Parsed $inner) }
    'window.top' { return (Invoke-WindowTop -Parsed $inner) }
    'window.bottom' { return (Invoke-WindowBottom -Parsed $inner) }
    'window.move' { return (Invoke-WindowMove -Parsed $inner) }
    'window.resize' { return (Invoke-WindowResize -Parsed $inner) }
    'window.minimize' { return (Invoke-WindowMinimize -Parsed $inner) }
    'window.maximize' { return (Invoke-WindowMaximize -Parsed $inner) }
    'window.restore' { return (Invoke-WindowRestore -Parsed $inner) }
    'screenshot' { return (Invoke-Screenshot -Parsed $inner) }
    'clipboard.read' { return (Invoke-ClipboardRead -Parsed $inner) }
    'clipboard.write' { return (Invoke-ClipboardWrite -Parsed $inner) }
    'wait.ms' { return (Invoke-WaitMs -Parsed $inner) }
    'wait.window' { return (Invoke-WaitWindow -Parsed $inner) }
    'mouse.click' { return (Invoke-MouseClick -Parsed $inner) }
    'mouse.context' { return (Invoke-MouseContext -Parsed $inner) }
    'mouse.over' { return (Invoke-MouseOver -Parsed $inner) }
    'mouse.wheel' { return (Invoke-MouseWheel -Parsed $inner) }
    'mouse.down' { return (Invoke-MouseDown -Parsed $inner) }
    'mouse.up' { return (Invoke-MouseUp -Parsed $inner) }
    'mouse.cursor' { return (Invoke-MouseCursor -Parsed $inner) }
    'keyboard.down' { return (Invoke-KeyboardDown -Parsed $inner) }
    'keyboard.up' { return (Invoke-KeyboardUp -Parsed $inner) }
    'keyboard.press' { return (Invoke-KeyboardPress -Parsed $inner) }
    'keyboard.combination' { return (Invoke-KeyboardCombination -Parsed $inner) }
    'keyboard.type' { return (Invoke-KeyboardType -Parsed $inner) }
    'keyboard.codes' { return (Invoke-KeyboardCodes -Parsed $inner) }
    'text' { return (Invoke-TextAtPoint -Parsed $inner) }
    'structure' { return (Invoke-StructureAtPoint -Parsed $inner) }

    default {
      throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message ("verb '{0}' is not implemented in this build" -f $target.key) `
          -Hint 'run: dsh-os selfcheck   (lists every verb, so the unsupported ones are visible rather than silent)')
    }
  }
}

