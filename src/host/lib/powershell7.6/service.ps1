# service.ps1 - system service inventory (SCM).
#
# Read-only. The lifecycle verbs (service.start / stop / restart) are declared in the verb table but
# deliberately unimplemented on both platforms: starting a service changes machine state and needs
# privilege, so it is a distinct piece of work rather than a variation on these two.

function Invoke-ServiceList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
  # No -ComputerName: PowerShell 7 removed it from the *-Service cmdlets in favour of Invoke-Command, so
  # this verb is local-only by construction on 7.x. The 5.1 module did not pass it either, so the
  # observable behaviour is unchanged.
  foreach ($svc in (Get-Service -ErrorAction SilentlyContinue | Sort-Object -Property Name)) {
    if ($filter -ne '' -and $filter -ne '*' -and $svc.Name -notlike $filter -and $svc.DisplayName -notlike $filter) { continue }
    [void]$items.Add([ordered]@{
      name = $svc.Name
      displayName = $svc.DisplayName
      status = $svc.Status.ToString()
      startType = $(try { $svc.StartType.ToString() } catch { $null })
    })
  }
  return [ordered]@{ count = $items.Count; services = $items.ToArray() }
}

function Invoke-ServiceQuery {
  param($Parsed)
  $name = Get-Positional -Parsed $Parsed -Index 0 -Name 'name'
  # A service name is compared against CIM rows below with -eq, which on .NET 5+ ignores non-printable
  # control characters. A service name cannot contain one, so this is left as -eq rather than made
  # ordinal; the distinction is recorded here so it is a decision rather than an oversight.
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no service named '{0}'" -f $name))
  }
  $cim = Get-CimSafe -ClassName 'Win32_Service'
  $detail = $null
  foreach ($c in $cim) { if ($c.Name -eq $svc.Name) { $detail = $c; break } }
  return [ordered]@{
    name = $svc.Name
    displayName = $svc.DisplayName
    status = $svc.Status.ToString()
    startType = $(try { $svc.StartType.ToString() } catch { $null })
    canStop = $(if ($null -ne $detail) { $detail.AcceptStop } else { $null })
    startName = $(if ($null -ne $detail) { $detail.StartName } else { $null })
    pathName = $(if ($null -ne $detail) { $detail.PathName } else { $null })
  }
}
