# Module: environment.ps1 - environment.* and environment attribute.*

function Resolve-EnvironmentScope {
  param($Parsed, [string]$Default = 'user')
  $scope = Get-FlagValue -Parsed $Parsed -Name 'scope' -Default $Default
  # if/elseif rather than switch: PowerShell's switch iterates its input when the input is enumerable,
  # and a string is enumerable as characters. That has already produced concatenated garbage once in
  # this codebase, so the explicit form is used wherever the subject is a string.
  if ($scope -eq 'process') { return [System.EnvironmentVariableTarget]::Process }
  if ($scope -eq 'user') { return [System.EnvironmentVariableTarget]::User }
  if ($scope -eq 'machine') { return [System.EnvironmentVariableTarget]::Machine }
  throw (New-OsError -Code 'E_USAGE' -Message ("--scope must be process, user or machine, got '{0}'" -f $scope))
}

function Get-ScopeName {
  param($Target)
  if ($Target -eq [System.EnvironmentVariableTarget]::Process) { return 'process' }
  if ($Target -eq [System.EnvironmentVariableTarget]::User) { return 'user' }
  if ($Target -eq [System.EnvironmentVariableTarget]::Machine) { return 'machine' }
  return 'unknown'
}

function Assert-ScopeWritable {
  param($Target, [string]$Verb)
  if ($Target -ne [System.EnvironmentVariableTarget]::Machine) { return }
  if (Test-IsElevated) { return }
  throw (New-OsError -Code 'E_ELEVATION_REQUIRED' `
      -Message ("{0} at machine scope needs an elevated context" -f $Verb) `
      -Hint 'writes that would silently not apply are refused instead; use --scope user, or run elevated')
}

# Ordinal comparison of two environment values.
#
# This is not stylistic. From .NET 5, culture-invariant string comparison IGNORES NON-PRINTABLE
# CONTROL CHARACTERS, so with -eq a value carrying an embedded control character compares equal to the
# same value without it. Entry values come from the environment and are attacker-influenced in the
# sense that anything on the machine can set them, so "does this list already contain X" and "which
# entry did the caller name" must be exact answers. -ceq would also be case-sensitive-and-ordinal, but
# an explicit call says why.
function Test-EnvironmentValueEqual {
  param([string]$A, [string]$B)
  return [string]::Equals($A, $B, [System.StringComparison]::Ordinal)
}

function Invoke-EnvironmentList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
  $vars = [System.Environment]::GetEnvironmentVariables($target)
  foreach ($key in ($vars.Keys | Sort-Object)) {
    if ($filter -ne '' -and $filter -ne '*' -and $key -notlike $filter) { continue }
    [void]$items.Add([ordered]@{ name = $key; value = [string]$vars[$key] })
  }
  return [ordered]@{ scope = (Get-ScopeName -Target $target); count = $items.Count; variables = $items.ToArray() }
}

function Invoke-EnvironmentGet {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $value = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $value) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
  }
  return [ordered]@{ name = $name; value = $value; scope = (Get-ScopeName -Target $target) }
}

function Invoke-EnvironmentAdd {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment add'
  Assert-Allowed -Parsed $Parsed -Verb 'environment add' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment add'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -ne $existing) {
    throw (New-OsError -Code 'E_EXISTS' -Message ("'{0}' is already set at {1} scope" -f $name, (Get-ScopeName -Target $target)) `
        -Hint 'use environment set to overwrite it')
  }
  [System.Environment]::SetEnvironmentVariable($name, $value, $target)
  return [ordered]@{
    name = $name; value = $value; scope = (Get-ScopeName -Target $target); operation = 'add'
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentSet {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment set'
  Assert-Allowed -Parsed $Parsed -Verb 'environment set' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment set'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $existing) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)) `
        -Hint 'use environment add to create it')
  }
  [System.Environment]::SetEnvironmentVariable($name, $value, $target)
  return [ordered]@{
    name = $name; value = $value; scope = (Get-ScopeName -Target $target); operation = 'set'
    previous = $existing
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'environment delete'
  Assert-Allowed -Parsed $Parsed -Verb 'environment delete' -Perm 'W' -Positionals 1
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment delete'
  $existing = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -eq $existing) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
  }
  # A null value is how SetEnvironmentVariable deletes; the write is then READ BACK and verified,
  # because a silent no-op here would be indistinguishable from success.
  [System.Environment]::SetEnvironmentVariable($name, $null, $target)
  $stillThere = [System.Environment]::GetEnvironmentVariable($name, $target)
  if ($null -ne $stillThere) {
    throw (New-OsError -Code 'E_IO' -Message ("'{0}' is still set at {1} scope after deletion" -f $name, (Get-ScopeName -Target $target)))
  }
  return [ordered]@{
    name = $name; previous = $existing; scope = (Get-ScopeName -Target $target); operation = 'delete'
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

# ---------------------------------------------------------------------------
# environment attr.* - an attribute of a variable is an ordered list joined by the platform
# separator. PATH is the default attribute; PATHEXT, LIB and INCLUDE behave the same way, which is
# why this is modelled generically rather than as a special case for PATH.
# ---------------------------------------------------------------------------
function Get-AttributeSeparator {
  # Windows joins list variables with ';'. POSIX uses ':' for PATH and friends.
  if ($env:OS -eq 'Windows_NT') { return ';' }
  return ':'
}

function Resolve-AttributeName {
  param($Parsed)
  return (Get-FlagValue -Parsed $Parsed -Name 'attr' -Default 'PATH')
}

function Get-AttributeEntries {
  param([string]$Name, $Target)
  $raw = [System.Environment]::GetEnvironmentVariable($Name, $Target)
  if ($null -eq $raw) { return , @() }
  $sep = Get-AttributeSeparator
  # The unary comma keeps an empty result an empty array instead of $null, so every caller can use
  # .Count and indexing without a null guard -- but callers must NOT wrap this in @(), which would
  # nest it into a one-element array and silently break their range checks.
  return , @($raw -split [regex]::Escape($sep) | Where-Object { $_ -ne '' })
}

function Join-AttributeEntries {
  param([string[]]$Entries)
  return ($Entries -join (Get-AttributeSeparator))
}

function Get-AttributeList {
  param($Parsed)
  # Which variables look like attributes at this scope, so a caller can discover them instead of
  # guessing names.
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $sep = Get-AttributeSeparator
  $items = New-Object System.Collections.ArrayList
  $known = @('PATH', 'PATHEXT', 'LIB', 'INCLUDE', 'MANPATH', 'CDPATH', 'PSModulePath')
  $vars = [System.Environment]::GetEnvironmentVariables($target)
  foreach ($key in ($vars.Keys | Sort-Object)) {
    $value = [string]$vars[$key]
    $isKnown = ($known -contains $key)
    $looksLikeList = ($value.Contains($sep))
    if (-not $isKnown -and -not $looksLikeList) { continue }
    $entries = @($value -split [regex]::Escape($sep) | Where-Object { $_ -ne '' })
    [void]$items.Add([ordered]@{
      name = $key
      known = $isKnown
      separator = $sep
      entryCount = $entries.Count
    })
  }
  return [ordered]@{ scope = (Get-ScopeName -Target $target); count = $items.Count; attributes = $items.ToArray() }
}

function Invoke-EnvironmentAttributeList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  return (Get-AttributeList -Parsed $Parsed)
}

function Invoke-EnvironmentAttributeGet {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  $attr = Resolve-AttributeName -Parsed $Parsed
  $raw = [System.Environment]::GetEnvironmentVariable($attr, $target)
  if ($null -eq $raw) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("attribute '{0}' is not set at {1} scope" -f $attr, (Get-ScopeName -Target $target)))
  }
  # The name argument selects which variable's attribute is inspected; PATH-style attributes are
  # usually read from PATH itself, so a mismatched pair is reported rather than silently ignored.
  if (-not (Test-EnvironmentValueEqual -A $name -B $attr)) {
    $other = [System.Environment]::GetEnvironmentVariable($name, $target)
    if ($null -eq $other) {
      throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' is not set at {1} scope" -f $name, (Get-ScopeName -Target $target)))
    }
  }
  $entries = Get-AttributeEntries -Name $attr -Target $target
  $items = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $entries.Count; $i++) {
    [void]$items.Add([ordered]@{ index = $i; value = $entries[$i] })
  }
  return [ordered]@{
    name = $attr
    requestedName = $name
    scope = (Get-ScopeName -Target $target)
    separator = (Get-AttributeSeparator)
    count = $items.Count
    entries = $items.ToArray()
  }
}

function Invoke-EnvironmentAttributeAdd {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'environment attribute add'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute add' -Perm 'W' -Positionals 2
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $value = Get-Positional -Parsed $Parsed -Index 1 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute add'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $entries = Get-AttributeEntries -Name $attr -Target $target
  foreach ($e in $entries) {
    if (Test-EnvironmentValueEqual -A $e -B $value) {
      throw (New-OsError -Code 'E_EXISTS' -Message ("'{0}' already contains '{1}'" -f $attr, $value))
    }
  }
  $joined = Join-AttributeEntries -Entries (@($entries) + @($value))
  [System.Environment]::SetEnvironmentVariable($attr, $joined, $target)
  return [ordered]@{
    name = $attr; added = $value; scope = (Get-ScopeName -Target $target)
    count = $entries.Count + 1; operation = 'attr-add'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentAttributeSet {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'environment attribute set'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute set' -Perm 'W' -Positionals 3
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $index = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1 -Name 'index') -Name 'index'
  $value = Get-Positional -Parsed $Parsed -Index 2 -Name 'value'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute set'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $entries = Get-AttributeEntries -Name $attr -Target $target
  if ($index -ge $entries.Count) {
    throw (New-OsError -Code 'E_RANGE' -Message ("index {0} is out of range for '{1}' (0..{2})" -f $index, $attr, [Math]::Max(0, $entries.Count - 1)))
  }
  $previous = $entries[$index]
  $entries[$index] = $value
  [System.Environment]::SetEnvironmentVariable($attr, (Join-AttributeEntries -Entries $entries), $target)
  return [ordered]@{
    name = $attr; index = $index; previous = $previous; value = $value
    scope = (Get-ScopeName -Target $target); count = $entries.Count; operation = 'attr-set'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}

function Invoke-EnvironmentAttributeDelete {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'environment attribute delete'
  Assert-Allowed -Parsed $Parsed -Verb 'environment attribute delete' -Perm 'W' -Positionals 1
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  $target = Resolve-EnvironmentScope -Parsed $Parsed
  Assert-ScopeWritable -Target $target -Verb 'environment attribute delete'
  $attr = Resolve-AttributeName -Parsed $Parsed
  $indexText = Get-FlagValue -Parsed $Parsed -Name 'index' -Default $null
  $valueText = Get-FlagValue -Parsed $Parsed -Name 'value' -Default $null
  if (-not $indexText -and -not $valueText) {
    throw (New-OsError -Code 'E_USAGE' -Message 'environment attr delete needs --index or --value to say which entry to remove')
  }
  $entries = Get-AttributeEntries -Name $attr -Target $target
  $removed = $null
  if ($indexText) {
    $index = Get-IntArg -Text $indexText -Name 'index'
    if ($index -ge $entries.Count) {
      throw (New-OsError -Code 'E_RANGE' -Message ("index {0} is out of range for '{1}' (0..{2})" -f $index, $attr, [Math]::Max(0, $entries.Count - 1)))
    }
    $removed = $entries[$index]
    $kept = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $entries.Count; $i++) { if ($i -ne $index) { [void]$kept.Add($entries[$i]) } }
    $entries = $kept.ToArray()
  } else {
    # Only the FIRST match is removed, and the comparison is ordinal so that an entry differing from
    # the named value only by a control character is not silently the one that gets deleted.
    $kept = New-Object System.Collections.ArrayList
    foreach ($e in $entries) {
      if ((Test-EnvironmentValueEqual -A $e -B $valueText) -and $null -eq $removed) { $removed = $e; continue }
      [void]$kept.Add($e)
    }
    if ($null -eq $removed) {
      throw (New-OsError -Code 'E_NOT_FOUND' -Message ("'{0}' does not contain '{1}'" -f $attr, $valueText))
    }
    $entries = $kept.ToArray()
  }
  if ($entries.Count -eq 0) {
    [System.Environment]::SetEnvironmentVariable($attr, $null, $target)
  } else {
    [System.Environment]::SetEnvironmentVariable($attr, (Join-AttributeEntries -Entries $entries), $target)
  }
  return [ordered]@{
    name = $attr; removed = $removed; scope = (Get-ScopeName -Target $target)
    count = $entries.Count; operation = 'attr-delete'
    requestedName = $name
    visibleToRunningProcesses = ($target -eq [System.EnvironmentVariableTarget]::Process)
  }
}
