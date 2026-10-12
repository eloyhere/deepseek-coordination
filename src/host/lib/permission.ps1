# Module: permission.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

function Get-PermissionFilePath {
  return (Join-Path $script:RootDir 'permission.json')
}

function Read-PermissionFile {
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ exists = $false; trusted = $true; document = $null; path = $path }
  }
  $raw = [System.IO.File]::ReadAllText($path, $script:NoBom)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    # An empty file is the documented initial state: no rules, defaults apply.
    return [ordered]@{ exists = $true; empty = $true; trusted = $true; document = $null; path = $path }
  }
  $doc = $null
  try { $doc = $raw | ConvertFrom-Json } catch {
    throw (New-OsError -Code 'E_PERMISSION_FILE_UNTRUSTED' -Message ("permission.json is not valid JSON: {0}" -f $_.Exception.Message) `
        -Hint 'a malformed authorization file must be fixed by the consent delegate, not by a verb')
  }
  $trusted = $true
  if ($null -ne $doc.PSObject.Properties['updatedBy']) {
    if ([string]$doc.updatedBy -ne 'consent-delegate') { $trusted = $false }
  }
  return [ordered]@{ exists = $true; empty = $false; trusted = $trusted; document = $doc; path = $path }
}

function Invoke-PermissionList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $state = Read-PermissionFile
  $rules = @()
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['rules']) {
    $rules = @($state.document.rules)
  }
  $items = New-Object System.Collections.ArrayList
  foreach ($r in $rules) {
    [void]$items.Add([ordered]@{
      id = $r.id
      verb = $r.verb
      decision = $r.decision
      grantedBy = $r.grantedBy
      grantedAt = $r.grantedAt
      expiresAt = $r.expiresAt
    })
  }
  return [ordered]@{
    path = $state.path
    exists = $state.exists
    empty = $(if ($null -ne $state.empty) { $state.empty } else { $false })
    trusted = $state.trusted
    count = $items.Count
    rules = $items.ToArray()
    aclEnforced = (Test-AclEnforced)
  }
}

function Invoke-PermissionAudit {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $limitText = Get-FlagValue -Parsed $Parsed -Name 'limit' -Default '50'
  $limit = Get-IntArg -Text $limitText -Name 'limit'
  $state = Read-PermissionFile
  $all = @()
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['audit']) {
    $all = @($state.document.audit)
  }
  $take = [Math]::Min($limit, $all.Count)
  $tail = @()
  if ($take -gt 0) { $tail = $all[($all.Count - $take)..($all.Count - 1)] }
  return [ordered]@{ path = $state.path; count = $tail.Count; entries = $tail }
}

function Invoke-PermissionQuery {
  param($Parsed)
  $verb = Get-Positional -Parsed $Parsed -Index 0 -Name 'verb'
  $target = Get-Positional -Parsed $Parsed -Index 1 -Name 'target' -Optional -Default '*'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $state = Read-PermissionFile
  $matched = $null
  if ($null -ne $state.document -and $null -ne $state.document.PSObject.Properties['rules']) {
    foreach ($r in @($state.document.rules)) {
      $verbMatch = ($r.verb -eq $verb) -or ($r.verb.EndsWith('.*') -and $verb.StartsWith($r.verb.Substring(0, $r.verb.Length - 1)))
      if (-not $verbMatch) { continue }
      $value = '*'
      if ($null -ne $r.target -and $null -ne $r.target.PSObject.Properties['value']) { $value = [string]$r.target.value }
      if ($value -eq '*' -or $value -eq $target) { $matched = $r; break }
    }
  }
  $decision = 'ask'
  if ($null -ne $matched) { $decision = [string]$matched.decision }
  elseif (-not $state.trusted) { $decision = 'ask' }
  return [ordered]@{
    verb = $verb
    target = $target
    decision = $decision
    ruleId = $(if ($null -ne $matched) { $matched.id } else { $null })
    source = $(if ($null -ne $matched) { 'rule' } else { 'defaults' })
    trusted = $state.trusted
    aclEnforced = (Test-AclEnforced)
    fileExists = $state.exists
  }
}

function Test-AclEnforced {
  # Layer A is only real when the authorization file has an explicit deny for the automation
  # context. Until acl init has run, this must report false rather than implying protection.
  $flag = Join-Path $script:RootDir '.temporary\acl-state.json'
  if (-not (Test-Path -LiteralPath $flag)) { return $false }
  try {
    $doc = ([System.IO.File]::ReadAllText($flag, $script:NoBom) | ConvertFrom-Json)
    if ($null -eq $doc.PSObject.Properties['aclEnforced']) { return $false }
    return [bool]$doc.aclEnforced
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# selfcheck
# ---------------------------------------------------------------------------
function Get-PlatformCapabilities {
  $caps = [ordered]@{
    platform = 'win32'
    sessionType = 'windows'
    dpiAware = $false
    inputInjection = 'add-type-user32'
    clipboard = 'user32'
    screenshot = 'gdi32-bitblt'
    # Probed rather than asserted. This said 'unavailable' as a hardcoded string until the text and
    # structure verbs were implemented, so a caller reading selfcheck would have concluded that
    # accessibility could never work here. A capability report that is not measured is a guess.
    accessibility = 'uia'
    accessibilityDetail = $null
    fonts = $null
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $caps['dpiAware'] = $true
    $caps['screens'] = [System.Windows.Forms.Screen]::AllScreens.Count
  } catch {
    $caps['screens'] = $null
  }
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    # Reaching the root element proves the layer answers, not merely that the assemblies loaded.
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $caps['accessibility'] = 'uia'
    $caps['accessibilityDetail'] = ('root=' + $root.Current.ClassName)
  } catch {
    $caps['accessibility'] = 'unavailable'
    $caps['accessibilityDetail'] = $_.Exception.Message
  }
  return $caps
}

function Invoke-Selfcheck {
  param($Parsed)
  $verbs = New-Object System.Collections.ArrayList
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith('verb')) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 4) { continue }
      [void]$verbs.Add([ordered]@{ verb = $f[0]; positionals = $f[1]; flags = $f[2]; perm = $f[3] })
    }
  }
  return [ordered]@{
    script = 'bin/dsh-os.ps1'
    powershell = $PSVersionTable.PSVersion.ToString()
    clrVersion = $PSVersionTable.CLRVersion.ToString()
    encodesPlainStdout = $true
    capabilities = Get-PlatformCapabilities
    verbCount = $verbs.Count
    verbs = $verbs.ToArray()
  }
}

