# Module: service.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

function Invoke-ServiceList {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $filter = Get-FlagValue -Parsed $Parsed -Name 'filter' -Default '*'
  $items = New-Object System.Collections.ArrayList
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

