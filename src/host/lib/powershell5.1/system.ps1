# Module: system.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

function Get-CimSafe {
  param([string]$ClassName, [string]$Namespace = 'root\cimv2')
  # The unary comma is essential: PowerShell unwraps a returned one-element array into the element
  # itself, so callers doing $result[0].Property would work by luck while $result.Count throws.
  # Returning a wrapper keeps the type stable for zero, one and many rows.
  try {
    return , @(Get-CimInstance -ClassName $ClassName -Namespace $Namespace -ErrorAction Stop)
  } catch {
    return , @()
  }
}

function Get-FirstOrNull {
  param($Items)
  if ($null -eq $Items) { return $null }
  if ($Items -is [System.Array]) {
    if ($Items.Length -eq 0) { return $null }
    return $Items[0]
  }
  return $Items
}

function Get-RegistryValueSafe {
  param([string]$KeyPath, [string]$Name)
  try {
    $item = Get-ItemProperty -Path $KeyPath -Name $Name -ErrorAction Stop
    return $item.$Name
  } catch {
    return $null
  }
}

function Invoke-SystemBrand {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $board = Get-CimSafe -ClassName 'Win32_BaseBoard'
  $cs = Get-CimSafe -ClassName 'Win32_ComputerSystem'
  $bios = Get-CimSafe -ClassName 'Win32_BIOS'
  $product = $null; $vendor = $null; $serial = $null
  if ((@($cs).Length -gt 0)) { $vendor = $cs[0].Manufacturer; $product = $cs[0].Model }
  if ((@($board).Length -gt 0)) { if (-not $product) { $product = $board[0].Product }; if (-not $vendor) { $vendor = $board[0].Manufacturer } }
  if ((@($bios).Length -gt 0)) { $serial = $bios[0].SerialNumber }
  return [ordered]@{
    platform = 'windows'
    vendor = $vendor
    product = $product
    serial = $serial
    family = 'windows'
  }
}

function Invoke-SystemCpu {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $cpus = Get-CimSafe -ClassName 'Win32_Processor'
  $items = New-Object System.Collections.ArrayList
  foreach ($c in $cpus) {
    [void]$items.Add([ordered]@{
      name = $c.Name
      manufacturer = $c.Manufacturer
      cores = $c.NumberOfCores
      threads = $c.NumberOfLogicalProcessors
      maxClockMhz = $c.MaxClockSpeed
      architecture = $(if ($null -ne $c.AddressWidth) { [string]$c.AddressWidth + '-bit' } else { $null })
    })
  }
  return [ordered]@{ count = $items.Count; processors = $items.ToArray() }
}

function Invoke-SystemGpu {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  # A machine with no usable driver legitimately reports an empty list here.
  $gpus = Get-CimSafe -ClassName 'Win32_VideoController'
  $items = New-Object System.Collections.ArrayList
  foreach ($g in $gpus) {
    [void]$items.Add([ordered]@{
      name = $g.Name
      vendor = $g.AdapterCompatibility
      memoryBytes = $(if ($null -ne $g.AdapterRAM -and [int64]$g.AdapterRAM -gt 0) { [int64]$g.AdapterRAM } else { $null })
      driverVersion = $g.DriverVersion
      resolution = $(if ($g.CurrentHorizontalResolution) { ([string]$g.CurrentHorizontalResolution + 'x' + [string]$g.CurrentVerticalResolution) } else { $null })
    })
  }
  return [ordered]@{ count = $items.Count; adapters = $items.ToArray() }
}

function Invoke-SystemVersion {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $os = Get-CimSafe -ClassName 'Win32_OperatingSystem'
  $caption = $null; $version = $null; $build = $null; $arch = $null
  if ((@($os).Length -gt 0)) {
    $caption = $os[0].Caption; $version = $os[0].Version; $build = $os[0].BuildNumber; $arch = $os[0].OSArchitecture
  }
  return [ordered]@{
    platform = 'windows'
    caption = $caption
    version = $version
    build = $build
    architecture = $arch
    productName = (Get-RegistryValueSafe -KeyPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'ProductName')
    displayVersion = (Get-RegistryValueSafe -KeyPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name 'DisplayVersion')
    powershell = $PSVersionTable.PSVersion.ToString()
    clr = $PSVersionTable.CLRVersion.ToString()
    isElevated = (Test-IsElevated)
    user = [System.Environment]::UserName
  }
}

function Invoke-SystemInfo {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  return [ordered]@{
    brand = (Invoke-SystemBrand -Parsed $Parsed)
    cpu = (Invoke-SystemCpu -Parsed $Parsed)
    gpu = (Invoke-SystemGpu -Parsed $Parsed)
    version = (Invoke-SystemVersion -Parsed $Parsed)
  }
}

function Test-IsElevated {
  try {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $null
  }
}

