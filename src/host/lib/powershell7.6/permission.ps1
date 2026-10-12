# Module: permission.ps1 - permission.* verbs, the ACL layer, selfcheck and the capability matrix.
#
# Ported from powershell5.1/permission.ps1 for bin/dsh-os7.ps1. Verb names, flags, result field names
# and error codes are identical to the 5.1 module. What changed, and why:
#
#   * selfcheck reported $PSVersionTable.CLRVersion. That key does not exist in 7.x at all, so the
#     expression throws rather than degrading. The field keeps the name `clrVersion` (an agent already
#     parses it) and now carries
#     [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription, the official
#     replacement, which is more informative: ".NET 10.0.12" instead of a bare CLR version.
#   * selfcheck's `script` names the artefact that actually ran: bin/dsh-os7.ps1. The field keeps its
#     name; only the value is corrected, since reporting the 5.1 file name from the 7.6 script would be
#     a false statement about which implementation answered.
#   * String comparisons that can see argument text or file text name their comparison explicitly.
#     PowerShell's -eq is a linguistic comparison, and .NET's linguistic comparisons do not treat every
#     non-printable control character as ordinary text - measured, with BEL = [char]7:
#     ('lf' + BEL) -eq 'lf' is False on Windows PowerShell 5.1 but True on 7.6, so an unchanged -eq
#     would make this port answer a rule question differently from the script it replaces. file.ps1
#     documents the same trap at its Test-SameText helper; this module inlines [string]::Equals with an
#     explicit StringComparison rather than depending on a helper defined in an earlier module.
#
# The ACL layer needs no 7.x-specific work. It reads and writes the security descriptor through the
# advapi32 P/Invoke in native.ps1 and never calls Get-Acl/Set-Acl, so the 7.3 relocation of the
# ObjectSecurity type data into Microsoft.PowerShell.Security (which obliges callers of those cmdlets
# to import that module explicitly) does not apply here.

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
    # 'consent-delegate' is an identity token, so it is compared as one: ordinal and case-insensitive,
    # never linguistically. A value carrying a control character must not pass as the delegate.
    if (-not [string]::Equals([string]$doc.updatedBy, 'consent-delegate', [System.StringComparison]::OrdinalIgnoreCase)) { $trusted = $false }
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
  $items = [System.Collections.ArrayList]::new()
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
    empty = ($state.empty ?? $false)
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
      # The rule text comes from permission.json and the verb comes from argv, so both comparisons are
      # named rather than linguistic. A rule written "file.*" matches every verb under "file." because
      # the trailing asterisk is dropped and what remains is used as a prefix.
      $verbMatch = [string]::Equals([string]$r.verb, $verb, [System.StringComparison]::OrdinalIgnoreCase)
      if (-not $verbMatch -and $r.verb.EndsWith('.*', [System.StringComparison]::Ordinal)) {
        $prefix = $r.verb.Substring(0, $r.verb.Length - 1)
        # The prefix test keeps the case-sensitivity the 5.1 code had; only its tolerance of control
        # characters is dropped.
        $verbMatch = $verb.StartsWith($prefix, [System.StringComparison]::Ordinal)
      }
      if (-not $verbMatch) { continue }
      $value = '*'
      if ($null -ne $r.target -and $null -ne $r.target.PSObject.Properties['value']) { $value = [string]$r.target.value }
      if ([string]::Equals($value, '*', [System.StringComparison]::OrdinalIgnoreCase) -or
          [string]::Equals($value, $target, [System.StringComparison]::OrdinalIgnoreCase)) { $matched = $r; break }
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

# The well-known SID for "Everyone". Layer A denies write access to it, because denying Everyone
# covers every context that could open the file, including the automation one, without this process
# having to know which account the harness runs as.
$script:EveryoneSid = 'S-1-1-0'

function Test-AclEnforced {
  # Measured from the file's OWN access control list, never from a state file.
  #
  # This previously read a flag written under .temporary/acl-state.json, which meant the reported
  # strength was whatever that file happened to say: a stale or edited flag would report kernel
  # enforcement that was not in effect. The model requires this to be measured, so the descriptor is
  # read back and searched for an explicit deny.
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  try {
    Initialize-Native
    $state = [DshNative]::DescribeDenyState($path, $script:EveryoneSid)
    return ($state -eq 'DENY')
  } catch {
    return $false
  }
}

# The reason, not just the boolean, so selfcheck can explain what is missing.
function Get-AclEnforcementDetail {
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ enforced = $false; reason = 'permission.json does not exist'; aclState = 'NOFILE' }
  }
  try {
    Initialize-Native
    $state = [DshNative]::DescribeDenyState($path, $script:EveryoneSid)
    # if/elseif rather than switch: PowerShell's switch iterates an enumerable input, and a string is
    # enumerable as characters, which silently runs the body once per character.
    if ($state -eq 'DENY') { $reason = 'an explicit deny of write access for Everyone is present' }
    elseif ($state -eq 'NONE') { $reason = 'the file has a DACL but no deny entry for Everyone; run: dsh-os permission acl init' }
    elseif ($state -eq 'NODACL') { $reason = 'the file has no DACL, so nothing is being denied' }
    else { $reason = "the access control list could not be read ($state)" }
    return [ordered]@{ enforced = ($state -eq 'DENY'); reason = $reason; aclState = "$state"; sid = $script:EveryoneSid }
  } catch {
    return [ordered]@{ enforced = $false; reason = ("the ACL could not be read: {0}" -f $_.Exception.Message); aclState = 'ERROR' }
  }
}

# ---------------------------------------------------------------------------
# permission.grant / revoke / acl init
# ---------------------------------------------------------------------------

# Both write verbs are delegate-only, and that is enforced by there being no implementation here at
# all rather than by a permission check that could be argued with. The authorization file is written
# by the consent delegate plugin, which can reach the user's approval UI; a script cannot, so a script
# must not be able to create a durable grant. E_PERMISSION_DELEGATE_ONLY names the component that can.
function Invoke-PermissionGrant {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'permission grant'
  Assert-Allowed -Parsed $Parsed -Verb 'permission grant' -Perm 'W'
  throw (New-OsError -Code 'E_PERMISSION_DELEGATE_ONLY' `
      -Message 'permission grant can only be performed by the consent delegate' `
      -Hint 'this verb needs the user approval dialog, which the delegate plugin owns; a script cannot reach it')
}

function Invoke-PermissionRevoke {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'permission revoke'
  Assert-Allowed -Parsed $Parsed -Verb 'permission revoke' -Perm 'W'
  throw (New-OsError -Code 'E_PERMISSION_DELEGATE_ONLY' `
      -Message 'permission revoke can only be performed by the consent delegate' `
      -Hint 'revoking a durable decision also needs the user approval dialog')
}

# permission acl init - idempotently apply layer A.
#
# Idempotent in the sense that matters here: running it twice leaves the same access control list, and
# running it on a file that already carries the deny reports that nothing changed rather than adding a
# second identical entry.
#
# It requires elevation because rewriting the security descriptor of a protected object is a
# privileged operation. A refusal is reported as E_ELEVATION_REQUIRED rather than being swallowed.
function Invoke-PermissionAclInit {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Allowed -Parsed $Parsed -Verb 'permission acl init' -Perm 'W'
  $path = Get-PermissionFilePath
  if (-not (Test-Path -LiteralPath $path)) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("permission.json does not exist at {0}" -f $path) `
        -Hint 'create the file first; the repository ships an empty one as the documented initial state')
  }
  Initialize-Native

  $before = Get-AclEnforcementDetail
  if ($before.enforced) {
    # Already protected. Reported as a no-op rather than re-applying, which is what makes a second run
    # safe to call from anywhere.
    return [ordered]@{
      path = $path
      changed = $false
      enforced = $true
      sid = $script:EveryoneSid
      reason = $before.reason
    }
  }

  if (-not (Test-IsElevated)) {
    throw (New-OsError -Code 'E_ELEVATION_REQUIRED' `
        -Message 'setting the security descriptor of a protected file requires elevation' `
        -Hint 'this operation needs an elevated context; nothing was changed')
  }

  $result = [DshNative]::ApplyDeny($path, $script:EveryoneSid)
  if ($result -ne 'OK') {
    throw (New-OsError -Code 'E_IO' -Message ("the access control list could not be updated: {0}" -f $result))
  }

  # Read back rather than trusting the call: the point of layer A is what the kernel will enforce, so
  # the result reports the DACL as it now stands.
  $after = Get-AclEnforcementDetail
  return [ordered]@{
    path = $path
    changed = $true
    enforced = $after.enforced
    sid = $script:EveryoneSid
    reason = $after.reason
    aclState = $after.aclState
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
    # All four assemblies load on 7.6.6 (verified by probe), so the 5.1 form is kept: Add-Type
    # -AssemblyName still resolves them from the Windows Desktop runtime that pwsh ships with.
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
  $verbs = [System.Collections.ArrayList]::new()
  $verbsPath = Join-Path $script:HostDir 'spec\verbs.tsv'
  if (Test-Path -LiteralPath $verbsPath) {
    foreach ($line in [System.IO.File]::ReadAllLines($verbsPath, $script:NoBom)) {
      # Length and ordinal prefixes rather than -eq/-StartsWith: a line holding one control character
      # is not an empty line, and "verb`0" is not the header.
      if ($line.Length -eq 0 -or $line.StartsWith('#', [System.StringComparison]::Ordinal) -or
          $line.StartsWith('verb', [System.StringComparison]::Ordinal)) { continue }
      $f = $line -split "`t"
      if ($f.Count -lt 4) { continue }
      [void]$verbs.Add([ordered]@{ verb = $f[0]; positionals = $f[1]; flags = $f[2]; perm = $f[3] })
    }
  }
  $enforcement = Get-AclEnforcementDetail
  return [ordered]@{
    # The artefact that actually answered. bin/dsh-os.ps1 is the Windows PowerShell 5.1 implementation;
    # this module set is assembled into bin/dsh-os7.ps1, so the field keeps its name and reports the
    # file that really ran rather than naming the other implementation.
    script = 'bin/dsh-os7.ps1'
    powershell = $PSVersionTable.PSVersion.ToString()
    # Kept under the 5.1 field name because an agent already parses `clrVersion`. $PSVersionTable has
    # no ClrVersion key in 7.x (6.0 removed it along with BuildVersion), so the 5.1 expression throws
    # instead of reporting anything; FrameworkDescription is the official replacement and reads
    # ".NET 10.0.12".
    clrVersion = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    encodesPlainStdout = $true
    capabilities = Get-PlatformCapabilities
    # The permission model requires selfcheck to report which enforcement strength is actually in
    # effect. It is MEASURED from the authorization file's security descriptor, and the reason is
    # reported next to the boolean so a false can be acted on instead of just wondered about.
    aclEnforced = $enforcement.enforced
    aclReason = $enforcement.reason
    verbCount = $verbs.Count
    verbs = $verbs.ToArray()
  }
}

