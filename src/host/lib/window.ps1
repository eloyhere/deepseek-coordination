# Module: window.ps1 - window.* and screenshot.
#
# Everything here reads or moves windows on the interactive desktop, so every verb needs the
# input desktop to exist. A session with no window station (a service, a headless run) gets
# E_NO_DISPLAY rather than an empty list, because "no windows" and "no desktop to ask" are different
# answers and only one of them means the caller should give up.
#
# Window identity is deliberately NOT the numeric handle alone. A handle is reused after a window is
# destroyed, so a caller that stores one can later act on an unrelated window. Each result therefore
# carries title, class and pid next to the handle, and `name` matching re-reads those fields live.

# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------

# Whether this process can see a desktop at all.
function Test-DesktopAvailable {
  try {
    $dc = [DshNative]::GetDC([IntPtr]::Zero)
    if ($dc -eq [IntPtr]::Zero) { return $false }
    [void][DshNative]::ReleaseDC([IntPtr]::Zero, $dc)
    return $true
  } catch {
    return $false
  }
}

function Assert-Desktop {
  Initialize-Native
  if (-not (Test-DesktopAvailable)) {
    throw (New-OsError -Code 'E_NO_DISPLAY' -Message 'no interactive desktop is available to this process' `
        -Hint 'window verbs need a window station; a service or headless session has none')
  }
}

function Get-WindowTitle {
  param([IntPtr]$Handle)
  $len = [DshNative]::GetWindowTextLengthW($Handle)
  if ($len -le 0) { return '' }
  # Allocate len+1 so the terminator has room; a shorter buffer silently truncates the title.
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][DshNative]::GetWindowTextW($Handle, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-WindowClassName {
  param([IntPtr]$Handle)
  $sb = New-Object System.Text.StringBuilder 256
  [void][DshNative]::GetClassNameW($Handle, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-WindowPid {
  param([IntPtr]$Handle)
  # $pid is a read-only automatic variable in PowerShell, so the out parameter needs another name.
  $procId = [uint32]0
  [void][DshNative]::GetWindowThreadProcessId($Handle, [ref]$procId)
  return [int]$procId
}

function Get-WindowRectValue {
  param([IntPtr]$Handle)
  $r = New-Object DshNative+RECT
  if (-not [DshNative]::GetWindowRect($Handle, [ref]$r)) { return $null }
  return [ordered]@{
    x = $r.Left
    y = $r.Top
    width = ($r.Right - $r.Left)
    height = ($r.Bottom - $r.Top)
  }
}

# All top-level windows in z-order, front to back.
#
# The callback delegate is held in a script-scope variable for the duration of the call. If it were
# only a local, the garbage collector could collect it while the native enumerator still held its
# function pointer, and the process would crash rather than return an error.
$script:EnumWindowsResult = $null
function Get-TopLevelWindows {
  param([switch]$IncludeUnnamed)

  Assert-Desktop
  $collected = New-Object System.Collections.ArrayList
  $script:EnumWindowsResult = $collected
  $callback = [DshNative+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$param)
    try {
      $title = Get-WindowTitle -Handle $hWnd
      $isVisible = [DshNative]::IsWindowVisible($hWnd)
      # An owned window is a dialog or tool window whose owner already appears in the list; including
      # both would report the same UI twice. Unnamed visible windows are shell plumbing.
      $owner = [DshNative]::GetWindow($hWnd, [uint32][DshNative]::GW_OWNER)
      if ($owner -eq [IntPtr]::Zero -and ($IncludeUnnamed -or ($isVisible -and $title -ne ''))) {
        [void]$collected.Add([ordered]@{
          handle = ('0x{0:x}' -f $hWnd.ToInt64())
          title = $title
          class = (Get-WindowClassName -Handle $hWnd)
          pid = (Get-WindowPid -Handle $hWnd)
          visible = [bool]$isVisible
          rect = (Get-WindowRectValue -Handle $hWnd)
        })
      }
    } catch {
      # A window can be destroyed between enumeration and inspection. Skipping it is correct; failing
      # the whole enumeration because one window vanished is not.
    }
    return $true
  }
  try {
    [void][DshNative]::EnumWindows($callback, [IntPtr]::Zero)
  } finally {
    $script:EnumWindowsResult = $null
  }
  return , @($collected)
}

# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

# Resolve a name to exactly one window, or fail with a typed error.
#
# Ambiguity is an error rather than a silent first match: acting on the wrong window is a real-world
# mistake (closing the wrong document), while reporting E_WINDOW_AMBIGUOUS with the candidates lets
# the caller disambiguate by pid or by a longer name.
function Resolve-Window {
  param([string]$Name, [switch]$Exact, [int]$PidFilter = 0, [switch]$Regex)
  if ([string]::IsNullOrEmpty($Name)) {
    throw (New-OsError -Code 'E_USAGE' -Message 'a window name is required')
  }
  $all = Get-TopLevelWindows
  if ($PidFilter -gt 0) { $all = @($all | Where-Object { $_.pid -eq $PidFilter }) }

  $matches = New-Object System.Collections.ArrayList
  foreach ($w in $all) {
    $hit = $false
    if ($Regex) {
      try { $hit = [bool]($w.title -match $Name) } catch { $hit = $false }
    } elseif ($Exact) {
      $hit = ($w.title -ceq $Name)
    } else {
      # Case-insensitive substring is the documented default: a caller usually has a fragment.
      $hit = ($w.title.IndexOf($Name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    if ($hit) { [void]$matches.Add($w) }
  }

  if ($matches.Count -eq 0) {
    throw (New-OsError -Code 'E_WINDOW_NOT_FOUND' -Message ("no window matches '{0}'" -f $Name) `
        -Hint 'run: dsh-os window list   (to see the titles that exist)')
  }
  if ($matches.Count -gt 1) {
    $titles = ($matches | ForEach-Object { $_.title }) -join ' | '
    throw (New-OsError -Code 'E_WINDOW_AMBIGUOUS' `
        -Message ("'{0}' matches {1} windows" -f $Name, $matches.Count) `
        -Hint ("candidates: " + $titles))
  }
  return $matches[0]
}

function Get-WindowHandleFromResult {
  param($Window)
  return [IntPtr][Convert]::ToInt64($Window.handle.Substring(2), 16)
}

# ---------------------------------------------------------------------------
# Read-only verbs
# ---------------------------------------------------------------------------

function Invoke-WindowList {
  param($Parsed)
  $windows = Get-TopLevelWindows
  return [ordered]@{
    count = $windows.Count
    windows = $windows
  }
}

function Invoke-WindowFind {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $name = Get-Positional -Parsed $Parsed -Index 0
  $exact = Test-HasFlag -Parsed $Parsed -Name 'exact'
  $regex = Test-HasFlag -Parsed $Parsed -Name 'regex'
  $pidText = Get-FlagValue -Parsed $Parsed -Name 'pid' -Default '0'
  $PidFilter = Get-IntArg -Text $pidText -Name 'pid'

  # find reports every match rather than demanding uniqueness: it is the discovery verb, and the
  # caller needs the candidate list to write a precise call afterwards.
  $all = Get-TopLevelWindows
  $hits = New-Object System.Collections.ArrayList
  foreach ($w in $all) {
    if ($PidFilter -gt 0 -and $w.pid -ne $PidFilter) { continue }
    $hit = $false
    if ($regex) {
      try { $hit = [bool]($w.title -match $name) } catch { $hit = $false }
    } elseif ($exact) {
      $hit = ($w.title -ceq $name)
    } else {
      $hit = ($w.title.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
    if ($hit) { [void]$hits.Add($w) }
  }
  return [ordered]@{
    name = $name
    matchMode = $(if ($regex) { 'regex' } elseif ($exact) { 'exact' } else { 'contains' })
    count = $hits.Count
    matches = $hits.ToArray()
  }
}

function Invoke-WindowActive {
  param($Parsed)
  Assert-Desktop
  $h = [DshNative]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) {
    throw (New-OsError -Code 'E_WINDOW_NOT_FOUND' -Message 'there is no foreground window')
  }
  return [ordered]@{
    handle = ('0x{0:x}' -f $h.ToInt64())
    title = (Get-WindowTitle -Handle $h)
    class = (Get-WindowClassName -Handle $h)
    pid = (Get-WindowPid -Handle $h)
    rect = (Get-WindowRectValue -Handle $h)
  }
}

# ---------------------------------------------------------------------------
# Mutating verbs
# ---------------------------------------------------------------------------

# Shared result for a window that was acted on: the caller gets the identity back, so it can confirm
# afterwards that it moved the window it meant to.
function New-WindowActionResult {
  param([string]$Action, $Window)
  return [ordered]@{
    action = $Action
    handle = $Window.handle
    title = $Window.title
    pid = $Window.pid
    rect = (Get-WindowRectValue -Handle (Get-WindowHandleFromResult -Window $Window))
  }
}

function Invoke-WindowClose {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window close'
  Assert-Allowed -Parsed $Parsed -Verb 'window close' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  # WM_CLOSE asks the application to close, which lets it prompt to save. TerminateProcess would not,
  # and destroying a window a process still owns is not what "close" means to a user.
  [void][DshNative]::PostMessageW($h, [uint32][DshNative]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  return [ordered]@{
    action = 'close'
    handle = $w.handle
    title = $w.title
    pid = $w.pid
    requested = 'WM_CLOSE'
    # Reported as a request, not an outcome: the application decides when it actually closes.
    closed = ([DshNative]::IsWindow($h) -eq $false)
  }
}

function Invoke-WindowTop {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window top'
  Assert-Allowed -Parsed $Parsed -Verb 'window top' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  # SetWindowPos with HWND_TOP raises in z-order; SetForegroundWindow additionally gives focus, which
  # Windows refuses for a process that does not own the foreground. Both are attempted and the
  # foreground result is reported separately so a refusal is visible rather than implied.
  [void][DshNative]::SetWindowPos($h, [DshNative]::HWND_TOP, 0, 0, 0, 0,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_SHOWWINDOW)))
  $focused = [DshNative]::SetForegroundWindow($h)
  $r = New-WindowActionResult -Action 'top' -Window $w
  $r['focused'] = [bool]$focused
  return $r
}

function Invoke-WindowBottom {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'window bottom'
  Assert-Allowed -Parsed $Parsed -Verb 'window bottom' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  [void][DshNative]::SetWindowPos($h, [DshNative]::HWND_BOTTOM, 0, 0, 0, 0,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_NOACTIVATE)))
  return (New-WindowActionResult -Action 'bottom' -Window $w)
}

function Invoke-WindowMove {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'window move'
  Assert-Allowed -Parsed $Parsed -Verb 'window move' -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 2) -Name 'y'
  $h = Get-WindowHandleFromResult -Window $w
  # Restore first: a minimized window reports a rect of about -32000 and would otherwise stay hidden.
  if ([DshNative]::IsIconic($h)) { [void][DshNative]::ShowWindow($h, [DshNative]::SW_RESTORE) }
  [void][DshNative]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, 0, 0,
    ([uint32]([DshNative]::SWP_NOSIZE -bor [DshNative]::SWP_NOACTIVATE)))
  $r = New-WindowActionResult -Action 'move' -Window $w
  $r['requested'] = [ordered]@{ x = $x; y = $y }
  return $r
}

function Invoke-WindowResize {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 3 -Verb 'window resize'
  Assert-Allowed -Parsed $Parsed -Verb 'window resize' -Perm 'W'
  # Values are validated BEFORE the window is resolved. Resolving first let a missing or ambiguous name
  # mask a malformed extent, so the caller was told about the wrong problem entirely.
  $width = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'width'
  $height = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 2) -Name 'height'
  if ($width -le 0 -or $height -le 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("width and height must be positive, got {0}x{1}" -f $width, $height))
  }
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  if ([DshNative]::IsIconic($h)) { [void][DshNative]::ShowWindow($h, [DshNative]::SW_RESTORE) }
  [void][DshNative]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $width, $height,
    ([uint32]([DshNative]::SWP_NOMOVE -bor [DshNative]::SWP_NOACTIVATE)))
  $r = New-WindowActionResult -Action 'resize' -Window $w
  $r['requested'] = [ordered]@{ width = $width; height = $height }
  return $r
}

# minimize / maximize / restore differ only in the ShowWindow command.
function Invoke-WindowShowState {
  param($Parsed, [string]$Action, [int]$Command)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb ("window " + $Action)
  Assert-Allowed -Parsed $Parsed -Verb ("window " + $Action) -Perm 'W'
  $w = Resolve-Window -Name (Get-Positional -Parsed $Parsed -Index 0) -Exact:(Test-HasFlag -Parsed $Parsed -Name 'exact')
  $h = Get-WindowHandleFromResult -Window $w
  [void][DshNative]::ShowWindow($h, $Command)
  $r = New-WindowActionResult -Action $Action -Window $w
  # Report the state actually observed afterwards, so a window that refused to change is visible.
  $r['minimized'] = [bool][DshNative]::IsIconic($h)
  $r['zoomed'] = [bool][DshNative]::IsZoomed($h)
  return $r
}

function Invoke-WindowMinimize {
  param($Parsed)
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'minimize' -Command ([DshNative]::SW_MINIMIZE))
}

function Invoke-WindowMaximize {
  param($Parsed)
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'maximize' -Command ([DshNative]::SW_MAXIMIZE))
}

function Invoke-WindowRestore {
  param($Parsed)
  return (Invoke-WindowShowState -Parsed $Parsed -Action 'restore' -Command ([DshNative]::SW_RESTORE))
}

# ---------------------------------------------------------------------------
# screenshot
# ---------------------------------------------------------------------------

function Invoke-Screenshot {
  param($Parsed)
  $out = Get-FlagValue -Parsed $Parsed -Name 'out' -Default $null
  if ([string]::IsNullOrEmpty($out)) {
    throw (New-OsError -Code 'E_USAGE' -Message 'screenshot requires --out <path>' `
        -Hint 'the image bytes are written to a file; the result reports the path, size and geometry')
  }
  Assert-Desktop

  # Geometry: the four positionals are x y width height. Omitted means the whole virtual screen, which
  # spans every monitor, because capturing only the primary one silently loses the others.
  $pos = @($Parsed.positionals)
  $full = ($pos.Count -eq 0)
  if (-not $full -and $pos.Count -lt 4) {
    throw (New-OsError -Code 'E_USAGE' -Message 'screenshot takes either no geometry (full screen) or all four of x y width height')
  }
  if ($full) {
    $x = [DshNative]::GetSystemMetrics([DshNative]::SM_XVIRTUALSCREEN)
    $y = [DshNative]::GetSystemMetrics([DshNative]::SM_YVIRTUALSCREEN)
    $width = [DshNative]::GetSystemMetrics([DshNative]::SM_CXVIRTUALSCREEN)
    $height = [DshNative]::GetSystemMetrics([DshNative]::SM_CYVIRTUALSCREEN)
  } else {
    $x = Get-IntArg -Text $pos[0] -Name 'x'
    $y = Get-IntArg -Text $pos[1] -Name 'y'
    $width = Get-IntArg -Text $pos[2] -Name 'width'
    $height = Get-IntArg -Text $pos[3] -Name 'height'
  }
  if ($width -le 0 -or $height -le 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("capture area must be positive, got {0}x{1}" -f $width, $height))
  }

  $format = Get-FlagValue -Parsed $Parsed -Name 'format' -Default 'png'
  $format = $format.ToLowerInvariant()
  if ($format -ne 'png' -and $format -ne 'jpeg' -and $format -ne 'jpg' -and $format -ne 'bmp') {
    throw (New-OsError -Code 'E_USAGE' -Message ("unsupported format '{0}'" -f $format) `
        -Hint 'supported: png, jpeg, bmp')
  }

  $dest = Resolve-FullPath -Path $out
  Assert-NotProtectedPath -Path $dest
  $parent = Split-Path -Parent $dest
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("parent directory does not exist: {0}" -f $parent))
  }

  try { Add-Type -AssemblyName System.Drawing -ErrorAction Stop } catch {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'System.Drawing is unavailable, so no image can be encoded')
  }

  $screenDc = [DshNative]::GetDC([IntPtr]::Zero)
  $memDc = [DshNative]::CreateCompatibleDC($screenDc)
  $bitmap = [DshNative]::CreateCompatibleBitmap($screenDc, $width, $height)
  $previous = [DshNative]::SelectObject($memDc, $bitmap)
  try {
    # SRCCOPY = 0x00CC0020. A false result means the blit failed, which is a real failure rather than
    # a black image, so it is reported instead of writing an all-black PNG.
    $ok = [DshNative]::BitBlt($memDc, 0, 0, $width, $height, $screenDc, $x, $y, 0x00CC0020)
    if (-not $ok) {
      throw (New-OsError -Code 'E_IO' -Message 'BitBlt failed; the screen could not be captured')
    }
    $image = [System.Drawing.Image]::FromHbitmap($bitmap)
    try {
      $imageFormat = [System.Drawing.Imaging.ImageFormat]::Png
      if ($format -eq 'jpeg' -or $format -eq 'jpg') { $imageFormat = [System.Drawing.Imaging.ImageFormat]::Jpeg }
      elseif ($format -eq 'bmp') { $imageFormat = [System.Drawing.Imaging.ImageFormat]::Bmp }
      $image.Save($dest, $imageFormat)
    } finally {
      $image.Dispose()
    }
  } finally {
    [void][DshNative]::SelectObject($memDc, $previous)
    [void][DshNative]::DeleteObject($bitmap)
    [void][DshNative]::DeleteDC($memDc)
    [void][DshNative]::ReleaseDC([IntPtr]::Zero, $screenDc)
  }

  $size = (Get-Item -LiteralPath $dest).Length
  return [ordered]@{
    path = $dest
    format = $format
    size = $size
    region = [ordered]@{ x = $x; y = $y; width = $width; height = $height }
    fullScreen = $full
  }
}
