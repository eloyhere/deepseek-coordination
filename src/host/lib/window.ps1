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

# ---------------------------------------------------------------------------
# mouse
# ---------------------------------------------------------------------------
#
# Coordinates are screen pixels, matching what mouse.cursor and window rects report, so a caller can
# take a rectangle from window.list and click inside it without converting anything. The absolute
# SendInput form normalises to 0..65535 over the VIRTUAL screen, which is why the metrics lookups
# below are the virtual-screen ones: using the primary-monitor size would misplace every click on a
# multi-monitor desktop.

function Get-MouseButtonFlags {
  param([string]$Button)
  switch ($Button.ToLowerInvariant()) {
    'left' { return @{ down = [DshNative]::MOUSEEVENTF_LEFTDOWN; up = [DshNative]::MOUSEEVENTF_LEFTUP } }
    'right' { return @{ down = [DshNative]::MOUSEEVENTF_RIGHTDOWN; up = [DshNative]::MOUSEEVENTF_RIGHTUP } }
    'middle' { return @{ down = [DshNative]::MOUSEEVENTF_MIDDLEDOWN; up = [DshNative]::MOUSEEVENTF_MIDDLEUP } }
    default {
      throw (New-OsError -Code 'E_USAGE' -Message ("unknown mouse button '{0}'" -f $Button) `
          -Hint 'accepted: left, right, middle')
    }
  }
}

function Move-CursorTo {
  param([int]$X, [int]$Y)
  # The cursor is moved with SetCursorPos rather than a synthetic MOUSEEVENTF_MOVE, so the hit test
  # performed by the target application sees the real pointer position. Many controls ignore injected
  # moves and later discard clicks that arrive at a position they do not believe the pointer is at.
  if (-not [DshNative]::SetCursorPos($X, $Y)) {
    throw (New-OsError -Code 'E_IO' -Message ("the cursor could not be moved to {0},{1}" -f $X, $Y))
  }
}

function Assert-Coordinates {
  param([int]$X, [int]$Y)
  # A point outside the virtual screen cannot be clicked, and reporting that is better than injecting
  # an event that lands nowhere.
  $vsX = [DshNative]::GetSystemMetrics([DshNative]::SM_XVIRTUALSCREEN)
  $vsY = [DshNative]::GetSystemMetrics([DshNative]::SM_YVIRTUALSCREEN)
  $vsW = [DshNative]::GetSystemMetrics([DshNative]::SM_CXVIRTUALSCREEN)
  $vsH = [DshNative]::GetSystemMetrics([DshNative]::SM_CYVIRTUALSCREEN)
  if ($X -lt $vsX -or $Y -lt $vsY -or $X -ge ($vsX + $vsW) -or $Y -ge ($vsY + $vsH)) {
    throw (New-OsError -Code 'E_RANGE' `
        -Message ("point {0},{1} is outside the virtual screen ({2},{3} {4}x{5})" -f $X, $Y, $vsX, $vsY, $vsW, $vsH))
  }
}

function Invoke-MouseClick {
  param($Parsed, [string]$DefaultButton = 'left')
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse click'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse click' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y

  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default $DefaultButton
  $countText = Get-FlagValue -Parsed $Parsed -Name 'count' -Default '1'
  $count = Get-IntArg -Text $countText -Name 'count'
  if ($count -lt 1) {
    throw (New-OsError -Code 'E_RANGE' -Message ("count must be at least 1, got {0}" -f $count))
  }
  $flags = Get-MouseButtonFlags -Button $button

  Move-CursorTo -X $x -Y $y
  for ($i = 0; $i -lt $count; $i++) {
    [DshNative]::SendMouse($flags.down, 0, 0, 0)
    [DshNative]::SendMouse($flags.up, 0, 0, 0)
  }
  $cursor = New-Object DshNative+POINT
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    action = $(if ($button -eq 'right') { 'context' } else { 'click' })
    button = $button
    count = $count
    requested = [ordered]@{ x = $x; y = $y }
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseContext {
  param($Parsed)
  $inner = @{ positionals = $Parsed.positionals; flags = $Parsed.flags; named = $Parsed.named }
  return (Invoke-MouseClick -Parsed $inner -DefaultButton 'right')
}

function Invoke-MouseOver {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse over'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse over' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  Move-CursorTo -X $x -Y $y
  $cursor = New-Object DshNative+POINT
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    action = 'over'
    requested = [ordered]@{ x = $x; y = $y }
    # Read back rather than echoed: the real position proves the move happened.
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseWheel {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse wheel'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse wheel' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  Move-CursorTo -X $x -Y $y
  # The wheel has to turn where the pointer is, so the pointer is placed first. The x/y pair carries
  # the scroll distance, under the same convention as the other mouse verbs.
  $delta = $x
  [DshNative]::SendMouse([DshNative]::MOUSEEVENTF_WHEEL, 0, 0, [uint32]$delta)
  return [ordered]@{
    action = 'wheel'
    delta = $delta
    at = [ordered]@{ x = $x; y = $y }
  }
}

function Invoke-MouseDown {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'mouse down'
  Assert-Allowed -Parsed $Parsed -Verb 'mouse down' -Perm 'W'
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  Assert-Desktop
  Assert-Coordinates -X $x -Y $y
  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default 'left'
  $flags = Get-MouseButtonFlags -Button $button
  Move-CursorTo -X $x -Y $y
  [DshNative]::SendMouse($flags.down, 0, 0, 0)
  # The button is deliberately left down. A caller that never issues mouse up leaves the desktop with
  # a held button, which is why mouse up takes no coordinates and always releases.
  return [ordered]@{
    action = 'down'
    button = $button
    at = [ordered]@{ x = $x; y = $y }
  }
}

function Invoke-MouseUp {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Allowed -Parsed $Parsed -Verb 'mouse up' -Perm 'W'
  Assert-Desktop
  $button = Get-FlagValue -Parsed $Parsed -Name 'button' -Default 'left'
  $flags = Get-MouseButtonFlags -Button $button
  [DshNative]::SendMouse($flags.up, 0, 0, 0)
  $cursor = New-Object DshNative+POINT
  [void][DshNative]::GetCursorPos([ref]$cursor)
  return [ordered]@{
    action = 'up'
    button = $button
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

function Invoke-MouseCursor {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Assert-Desktop
  $cursor = New-Object DshNative+POINT
  if (-not [DshNative]::GetCursorPos([ref]$cursor)) {
    throw (New-OsError -Code 'E_IO' -Message 'the cursor position could not be read')
  }
  return [ordered]@{
    cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
  }
}

# ---------------------------------------------------------------------------
# keyboard
# ---------------------------------------------------------------------------

# Accepted key names, mapped to virtual-key codes. A name not in this table is refused rather than
# guessed at: an unrecognised key that silently became some other key would type the wrong thing, and
# there is no way for the caller to notice.
$script:KeyCodes = $null
function Get-KeyCodeTable {
  if ($null -ne $script:KeyCodes) { return $script:KeyCodes }
  $t = @{}
  # Letters and digits: the code is the character itself, upper-cased.
  foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz') { $t[[string]$c] = [int][char]([string]$c).ToUpperInvariant()[0] }
  foreach ($d in 0..9) { $t["$d"] = 0x30 + $d }
  # Function keys.
  for ($i = 1; $i -le 24; $i++) { $t["f$i"] = 0x6F + $i }
  $t['backspace'] = 0x08; $t['tab'] = 0x09; $t['enter'] = 0x0D; $t['return'] = 0x0D
  $t['shift'] = 0x10; $t['ctrl'] = 0x11; $t['control'] = 0x11; $t['alt'] = 0x12
  $t['pause'] = 0x13; $t['capslock'] = 0x14; $t['escape'] = 0x1B; $t['esc'] = 0x1B
  $t['space'] = 0x20; $t['pageup'] = 0x21; $t['pagedown'] = 0x22
  $t['end'] = 0x23; $t['home'] = 0x24; $t['left'] = 0x25; $t['up'] = 0x26
  $t['right'] = 0x27; $t['down'] = 0x28
  $t['printscreen'] = 0x2C; $t['insert'] = 0x2D; $t['delete'] = 0x2E; $t['del'] = 0x2E
  $t['win'] = 0x5B; $t['lwin'] = 0x5B; $t['rwin'] = 0x5C; $t['apps'] = 0x5D
  $t['numlock'] = 0x90; $t['scrolllock'] = 0x91
  $t['shiftleft'] = 0xA0; $t['shiftright'] = 0xA1
  $t['ctrlleft'] = 0xA2; $t['ctrlright'] = 0xA3
  $t['altleft'] = 0xA4; $t['altright'] = 0xA5
  # Punctuation by name, so a chord does not depend on the caller's keyboard layout for those keys.
  $t['semicolon'] = 0xBA; $t['equals'] = 0xBB; $t['comma'] = 0xBC; $t['minus'] = 0xBD
  $t['period'] = 0xBE; $t['slash'] = 0xBF; $t['backtick'] = 0xC0
  $t['bracketleft'] = 0xDB; $t['backslash'] = 0xDC; $t['bracketright'] = 0xDD; $t['quote'] = 0xDE
  # Numpad.
  $t['num0'] = 0x60; $t['num1'] = 0x61; $t['num2'] = 0x62; $t['num3'] = 0x63; $t['num4'] = 0x64
  $t['num5'] = 0x65; $t['num6'] = 0x66; $t['num7'] = 0x67; $t['num8'] = 0x68; $t['num9'] = 0x69
  $t['multiply'] = 0x6A; $t['add'] = 0x6B; $t['subtract'] = 0x6D; $t['decimal'] = 0x6E; $t['divide'] = 0x6F
  $script:KeyCodes = $t
  return $t
}

function Resolve-KeyCode {
  param([string]$Name)
  if ([string]::IsNullOrEmpty($Name)) {
    throw (New-OsError -Code 'E_TYPE' -Message 'a key name is required')
  }
  $key = $Name.Trim().ToLowerInvariant()
  $table = Get-KeyCodeTable
  if ($table.ContainsKey($key)) { return [int]$table[$key] }
  throw (New-OsError -Code 'E_TYPE' -Message ("unknown key name '{0}'" -f $Name) `
      -Hint 'run: dsh-os keyboard codes   (lists every accepted name on this platform)')
}

function Get-ModifierCodes {
  param([string[]]$Names)
  $codes = New-Object System.Collections.ArrayList
  foreach ($n in $Names) { [void]$codes.Add((Resolve-KeyCode -Name $n)) }
  return , @($codes)
}

# Release any modifier this process may have left held. Called before a chord when --clearmodifiers is
# given, because a modifier the user is physically holding would otherwise combine with the injected
# chord and produce a different shortcut than the caller asked for.
function Clear-HeldModifiers {
  foreach ($vk in @(0x10, 0x11, 0x12, 0x5B, 0x5C)) {
    [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  }
}

function Invoke-KeyboardDown {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard down'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard down' -Perm 'W'
  Assert-Desktop
  $vk = Resolve-KeyCode -Name (Get-Positional -Parsed $Parsed -Index 0)
  if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
  [DshNative]::SendKey([uint16]$vk, 0, 0)
  return [ordered]@{ action = 'down'; key = (Get-Positional -Parsed $Parsed -Index 0); vk = $vk }
}

function Invoke-KeyboardUp {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard up'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard up' -Perm 'W'
  Assert-Desktop
  $vk = Resolve-KeyCode -Name (Get-Positional -Parsed $Parsed -Index 0)
  [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  return [ordered]@{ action = 'up'; key = (Get-Positional -Parsed $Parsed -Index 0); vk = $vk }
}

function Invoke-KeyboardPress {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard press'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard press' -Perm 'W'
  Assert-Desktop
  $name = Get-Positional -Parsed $Parsed -Index 0
  $vk = Resolve-KeyCode -Name $name
  if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
  [DshNative]::SendKey([uint16]$vk, 0, 0)
  [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
  return [ordered]@{ action = 'press'; key = $name; vk = $vk }
}

# keyboard combination <down|up> key [key ...]
#
# The phase is an explicit positional rather than two verbs, so a chord is written the same way
# whichever direction it goes, and a caller cannot accidentally press a chord without releasing it.
function Invoke-KeyboardCombination {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'keyboard combination'
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard combination' -Perm 'W'
  Assert-Desktop
  $phase = (Get-Positional -Parsed $Parsed -Index 0).ToLowerInvariant()
  if ($phase -ne 'down' -and $phase -ne 'up') {
    throw (New-OsError -Code 'E_USAGE' -Message ("phase must be 'down' or 'up', got '{0}'" -f $phase))
  }
  $names = @()
  $i = 1
  while ($i -lt @($Parsed.positionals).Count) {
    $t = [string]$Parsed.positionals[$i]
    # Accept both "a b c" and "a+b+c" so a chord can be written either way.
    foreach ($part in ($t -split '\+')) { if ($part -ne '') { $names += $part } }
    $i++
  }
  if ($names.Count -eq 0) {
    throw (New-OsError -Code 'E_USAGE' -Message 'a chord needs at least one key name')
  }
  $codes = Get-ModifierCodes -Names $names
  if ($phase -eq 'down') {
    if (Test-HasFlag -Parsed $Parsed -Name 'clearmodifiers') { Clear-HeldModifiers }
    # Press in order, so modifiers go down before the key they modify.
    foreach ($vk in $codes) { [DshNative]::SendKey([uint16]$vk, 0, 0) }
  } else {
    # Release in reverse, so the modified key comes up before its modifiers.
    $reversed = @($codes)
    [array]::Reverse($reversed)
    foreach ($vk in $reversed) {
      [DshNative]::SendKey([uint16]$vk, 0, ([uint32]([DshNative]::KEYEVENTF_KEYUP)))
    }
  }
  return [ordered]@{
    action = 'combination'
    phase = $phase
    keys = $names
    vk = $codes
  }
}

function Invoke-KeyboardType {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'keyboard type'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'keyboard type' -Perm 'W'
  Assert-Desktop
  $text = Get-Positional -Parsed $Parsed -Index 0
  $intervalText = Get-FlagValue -Parsed $Parsed -Name 'interval' -Default '0'
  $interval = Get-IntArg -Text $intervalText -Name 'interval'
  if ($interval -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("interval must not be negative, got {0}" -f $interval))
  }
  if ($text.Length -eq 0) {
    throw (New-OsError -Code 'E_NOT_TEXT' -Message 'there is no text to type')
  }

  # Each character is sent as a Unicode key event, which is why this method is used rather than
  # synthesising virtual keys: a virtual key depends on the active keyboard layout, so "%" on a German
  # layout is a different chord than on a US one. Unicode events carry the character itself, so the
  # same call types the same text on every layout, including non-ASCII.
  $sent = 0
  foreach ($ch in $text.ToCharArray()) {
    [DshNative]::SendUnicodeChar($ch)
    $sent++
    if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
  }
  return [ordered]@{
    action = 'type'
    method = 'unicode-sendinput'
    characters = $sent
    text = $text
  }
}

function Invoke-KeyboardCodes {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  $table = Get-KeyCodeTable
  $names = @($table.Keys | Sort-Object)
  return [ordered]@{
    platform = 'win32'
    count = $names.Length
    names = $names
  }
}

# ---------------------------------------------------------------------------
# clipboard
# ---------------------------------------------------------------------------

# The clipboard is a single global resource: only one process can hold it open, so every use is
# wrapped in try/finally and closed on every path. A leaked open clipboard makes every other
# application's copy and paste fail until this process exits.
function Invoke-ClipboardRead {
  param($Parsed)
  Assert-NoExtra -Parsed $Parsed -Expected 0
  Initialize-Native
  Assert-Desktop

  $opened = $false
  try {
    $opened = [DshNative]::OpenClipboard([IntPtr]::Zero)
    if (-not $opened) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard is held by another process' `
          -Hint 'retry; another application is mid-copy')
    }
    $handle = [DshNative]::GetClipboardData([DshNative]::CF_UNICODETEXT)
    if ($handle -eq [IntPtr]::Zero) {
      # The clipboard is not empty in general, it just holds no text. E_NOT_TEXT says that precisely,
      # where a null value would be indistinguishable from a failed read.
      throw (New-OsError -Code 'E_NOT_TEXT' -Message 'the clipboard holds no text' `
          -Hint 'the clipboard may contain an image or files rather than text')
    }
    $ptr = [DshNative]::GlobalLock($handle)
    if ($ptr -eq [IntPtr]::Zero) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard text could not be locked for reading')
    }
    try {
      $text = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr)
    } finally {
      [void][DshNative]::GlobalUnlock($handle)
    }
    return [ordered]@{
      text = $text
      length = $text.Length
      format = 'CF_UNICODETEXT'
    }
  } finally {
    if ($opened) { [void][DshNative]::CloseClipboard() }
  }
}

function Invoke-ClipboardWrite {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'clipboard write'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  Assert-Allowed -Parsed $Parsed -Verb 'clipboard write' -Perm 'W'
  $text = Get-Positional -Parsed $Parsed -Index 0
  Initialize-Native
  Assert-Desktop

  $opened = $false
  try {
    $opened = [DshNative]::OpenClipboard([IntPtr]::Zero)
    if (-not $opened) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard is held by another process' `
          -Hint 'retry; another application is mid-copy')
    }
    if (-not [DshNative]::EmptyClipboard()) {
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard could not be emptied')
    }
    # GMEM_MOVEABLE is required by SetClipboardData. The buffer is deliberately never freed here: on
    # success the system takes ownership of the memory, and freeing it would leave the clipboard
    # pointing at released memory. On failure it leaks one small allocation, which is the safe side of
    # a choice with no third option.
    $bytes = ($text.Length + 1) * 2
    # [UIntPtr]$int is a cast PowerShell cannot perform; ::new is the conversion that works.
    $handle = [DshNative]::GlobalAlloc([DshNative]::GMEM_MOVEABLE, [UIntPtr]::new($bytes))
    if ($handle -eq [IntPtr]::Zero) {
      throw (New-OsError -Code 'E_IO' -Message 'memory for the clipboard text could not be allocated')
    }
    $ptr = [DshNative]::GlobalLock($handle)
    if ($ptr -eq [IntPtr]::Zero) {
      [void][DshNative]::GlobalFree($handle)
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard buffer could not be locked for writing')
    }
    try {
      # Copy the characters and a terminating null; the trailing zero is written explicitly because
      # the buffer is raw memory and nothing else will terminate the string.
      $chars = $text.ToCharArray()
      [System.Runtime.InteropServices.Marshal]::Copy($chars, 0, $ptr, $chars.Length)
      [System.Runtime.InteropServices.Marshal]::WriteInt16($ptr, $chars.Length * 2, [int16]0)
    } finally {
      [void][DshNative]::GlobalUnlock($handle)
    }
    if ([DshNative]::SetClipboardData([DshNative]::CF_UNICODETEXT, $handle) -eq [IntPtr]::Zero) {
      [void][DshNative]::GlobalFree($handle)
      throw (New-OsError -Code 'E_IO' -Message 'the clipboard refused the text')
    }
    return [ordered]@{
      written = $text.Length
      format = 'CF_UNICODETEXT'
      text = $text
    }
  } finally {
    if ($opened) { [void][DshNative]::CloseClipboard() }
  }
}

# ---------------------------------------------------------------------------
# wait
# ---------------------------------------------------------------------------

# wait ms: an explicit sleep.
function Invoke-WaitMs {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'wait ms'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $ms = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'ms'
  if ($ms -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("ms must not be negative, got {0}" -f $ms))
  }
  if ($ms -gt 3600000) {
    # An hour is a generous ceiling. Beyond it the caller almost certainly passed seconds by mistake,
    # and silently sleeping for hours is worse than saying so.
    throw (New-OsError -Code 'E_RANGE' -Message ("ms must be at most 3600000 (one hour), got {0}" -f $ms) `
        -Hint 'the value is milliseconds; 1000 ms is one second')
  }
  $started = [DateTime]::UtcNow
  Start-Sleep -Milliseconds $ms
  return [ordered]@{
    requestedMs = $ms
    elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
  }
}

# wait window: block until a window appears, or until it goes away with --absent.
function Invoke-WaitWindow {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 1 -Verb 'wait window'
  Assert-NoExtra -Parsed $Parsed -Expected 1
  $name = Get-Positional -Parsed $Parsed -Index 0
  $timeoutText = Get-FlagValue -Parsed $Parsed -Name 'timeout' -Default '10000'
  $timeout = Get-IntArg -Text $timeoutText -Name 'timeout'
  if ($timeout -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("timeout must not be negative, got {0}" -f $timeout))
  }
  $intervalText = Get-FlagValue -Parsed $Parsed -Name 'interval' -Default '100'
  $interval = Get-IntArg -Text $intervalText -Name 'interval'
  if ($interval -lt 1) { $interval = 1 }
  $exact = Test-HasFlag -Parsed $Parsed -Name 'exact'
  $absent = Test-HasFlag -Parsed $Parsed -Name 'absent'

  Assert-Desktop
  $started = [DateTime]::UtcNow
  $attempts = 0
  while ($true) {
    $attempts++
    $found = $null
    foreach ($w in (Get-TopLevelWindows)) {
      $hit = $false
      if ($exact) { $hit = ($w.title -ceq $name) }
      else { $hit = ($w.title.IndexOf($name, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) }
      if ($hit) { $found = $w; break }
    }
    $satisfied = $(if ($absent) { $null -eq $found } else { $null -ne $found })
    if ($satisfied) {
      return [ordered]@{
        name = $name
        condition = $(if ($absent) { 'absent' } else { 'present' })
        satisfied = $true
        attempts = $attempts
        elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
        window = $found
      }
    }
    if ([int]([DateTime]::UtcNow - $started).TotalMilliseconds -ge $timeout) {
      # Reporting the condition that was NOT met, plus how long we waited, is more useful to a caller
      # than a bare timeout: it says which way the wait failed.
      throw (New-OsError -Code 'E_TIMEOUT' `
          -Message ("window '{0}' did not become {1} within {2}ms" -f $name, $(if ($absent) { 'absent' } else { 'present' }), $timeout) `
          -Hint 'run: dsh-os window list   (to see the titles that exist now)')
    }
    Start-Sleep -Milliseconds $interval
  }
}

# ---------------------------------------------------------------------------
# text / structure - accessibility
# ---------------------------------------------------------------------------
#
# Both verbs ask the accessibility layer what is at a point, which is why the verb table lists
# E_ACCESSIBILITY_DENIED and E_ACCESSIBILITY_UNAVAILABLE: the API can be absent from the framework, or
# present but refusing to answer. Those are reported as distinct typed errors rather than as an empty
# result, because "there is no text here" and "I am not allowed to look" lead a caller to opposite
# next actions.
#
# The assemblies are loaded on first use, not at startup: Add-Type is expensive and most verbs never
# touch accessibility.

$script:UiaReady = $null
function Initialize-Uia {
  if ($null -ne $script:UiaReady) {
    if (-not $script:UiaReady) {
      throw (New-OsError -Code 'E_ACCESSIBILITY_UNAVAILABLE' `
          -Message 'UI Automation is not available in this PowerShell installation' `
          -Hint 'the text and structure verbs need UIAutomationClient and UIAutomationTypes')
    }
    return
  }
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    # AutomationElement.FromPoint takes a System.Windows.Point, which lives in WindowsBase and is NOT
    # pulled in by the two UIA assemblies. Without this the call fails with "Cannot find type
    # [System.Windows.Point]", which looks like an accessibility refusal but is really a missing
    # assembly - and it was being reported as E_ACCESSIBILITY_DENIED until this was found.
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    $script:UiaReady = $true
  } catch {
    $script:UiaReady = $false
    throw (New-OsError -Code 'E_ACCESSIBILITY_UNAVAILABLE' `
        -Message ("UI Automation could not be loaded: {0}" -f $_.Exception.Message) `
        -Hint 'the text and structure verbs need UIAutomationClient, UIAutomationTypes and WindowsBase')
  }
  Assert-Desktop
}

function Resolve-SourceFlag {
  param($Parsed)
  $source = Get-FlagValue -Parsed $Parsed -Name 'source' -Default 'auto'
  $source = $source.ToLowerInvariant()
  if (@('auto', 'uia', 'msaa') -notcontains $source) {
    throw (New-OsError -Code 'E_USAGE' -Message ("unknown source '{0}'" -f $source) `
        -Hint 'accepted: auto, uia, msaa')
  }
  # Only the UIA backend is implemented. Saying so is better than silently answering from UIA when
  # the caller explicitly asked for MSAA, which reports a different element tree.
  if ($source -eq 'msaa') {
    throw (New-OsError -Code 'E_NOT_SUPPORTED' -Message 'the msaa source is not implemented in this build' `
        -Hint 'use source=uia or source=auto')
  }
  return $(if ($source -eq 'auto') { 'uia' } else { $source })
}

function Get-ElementAtPoint {
  param([int]$X, [int]$Y)
  try {
    $point = New-Object System.Windows.Point($X, $Y)
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($point)
  } catch {
    throw (New-OsError -Code 'E_ACCESSIBILITY_DENIED' `
        -Message ("UI Automation refused to inspect the point {0},{1}: {2}" -f $X, $Y, $_.Exception.Message) `
        -Hint 'elevated windows can refuse inspection from a lower-privilege process')
  }
  if ($null -eq $el) {
    throw (New-OsError -Code 'E_NOT_FOUND' -Message ("no accessible element at {0},{1}" -f $X, $Y))
  }
  return $el
}

function Get-ElementField {
  param($Element, [string]$Field)
  # Every property read can throw when an element disappears mid-walk, which happens constantly on a
  # live desktop. A missing field is reported as null rather than aborting the whole query.
  #
  # This is an if/elseif chain and NOT a switch. PowerShell's switch iterates its input when the input
  # is enumerable, and a STRING is enumerable as characters, so `switch ($Field)` ran the body once per
  # character: every case that matched some letter contributed a value and the result came back as an
  # array that the [string] cast then concatenated. That is why type/class/framework/automationId
  # arrived as long repeated strings while name (a property of only one case) looked correct.
  try {
    if ($Field -eq 'name') { return [string]$Element.Current.Name }
    if ($Field -eq 'class') { return [string]$Element.Current.ClassName }
    # ControlType needs its ProgrammaticName: casting the object gives the type name, not the control.
    if ($Field -eq 'type') { return [string]$Element.Current.ControlType.ProgrammaticName }
    if ($Field -eq 'automationId') { return [string]$Element.Current.AutomationId }
    if ($Field -eq 'framework') { return [string]$Element.Current.FrameworkId }
    if ($Field -eq 'enabled') { return [bool]$Element.Current.IsEnabled }
    if ($Field -eq 'offscreen') { return [bool]$Element.Current.IsOffscreen }
    return $null
  } catch {
    return $null
  }
}

function Get-ElementRectValue {
  param($Element)
  try {
    $r = $Element.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch {
    return $null
  }
}

function ConvertTo-ElementObject {
  param($Element, [int]$Depth = 0)
  return [ordered]@{
    type = (Get-ElementField -Element $Element -Field 'type')
    name = (Get-ElementField -Element $Element -Field 'name')
    class = (Get-ElementField -Element $Element -Field 'class')
    automationId = (Get-ElementField -Element $Element -Field 'automationId')
    framework = (Get-ElementField -Element $Element -Field 'framework')
    enabled = (Get-ElementField -Element $Element -Field 'enabled')
    offscreen = (Get-ElementField -Element $Element -Field 'offscreen')
    rect = (Get-ElementRectValue -Element $Element)
    depth = $Depth
  }
}

# The text an element exposes, trying the patterns in order of how specific they are.
function Get-ElementText {
  param($Element)
  # ValuePattern is the right answer for an input control: it gives the content, not the label.
  try {
    $vp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $v = ([System.Windows.Automation.ValuePattern]$vp).Current.Value
      if (-not [string]::IsNullOrEmpty($v)) { return @{ text = [string]$v; via = 'ValuePattern' } }
    }
  } catch { }
  # TextPattern for documents and read-only text.
  try {
    $tp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $t = ([System.Windows.Automation.TextPattern]$tp).DocumentRange.GetText(-1)
      if (-not [string]::IsNullOrEmpty($t)) { return @{ text = [string]$t; via = 'TextPattern' } }
    }
  } catch { }
  # LegacyIAccessible carries a value for older controls that expose nothing else.
  try {
    $lp = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern, [ref]$lp)) {
      $v = ([System.Windows.Automation.LegacyIAccessiblePattern]$lp).Current.Value
      if (-not [string]::IsNullOrEmpty($v)) { return @{ text = [string]$v; via = 'LegacyIAccessiblePattern' } }
    }
  } catch { }
  # The Name property is the last resort and is really a label, so it is reported with its source so
  # a caller can tell a control's content from its label.
  $name = Get-ElementField -Element $Element -Field 'name'
  if (-not [string]::IsNullOrEmpty($name)) { return @{ text = [string]$name; via = 'Name' } }
  return @{ text = ''; via = 'none' }
}

# Ancestors up to a limit, nearest first. Bounded because a walk can otherwise leave the window and
# climb to the desktop root, reporting text from an unrelated window.
function Get-AncestorChain {
  param($Element, [int]$Max = 8)
  $chain = New-Object System.Collections.ArrayList
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $Element
  for ($i = 0; $i -lt $Max; $i++) {
    try { $current = $walker.GetParent($current) } catch { break }
    if ($null -eq $current) { break }
    [void]$chain.Add($current)
  }
  return , @($chain)
}

function Invoke-TextAtPoint {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'text'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  $source = Resolve-SourceFlag -Parsed $Parsed
  $maxText = Get-FlagValue -Parsed $Parsed -Name 'max-chars' -Default '4096'
  $maxChars = Get-IntArg -Text $maxText -Name 'max-chars'
  if ($maxChars -lt 1) {
    throw (New-OsError -Code 'E_RANGE' -Message ("max-chars must be at least 1, got {0}" -f $maxChars))
  }

  Initialize-Uia
  $element = Get-ElementAtPoint -X $x -Y $y
  $hit = ConvertTo-ElementObject -Element $element

  # Search the element, then its ancestors. A click lands on the innermost element, which for a text
  # editor is often a child that exposes nothing; the text lives on an ancestor.
  $probe = $element
  $via = 'none'
  $text = ''
  $sourceElement = $null
  $depthFound = 0
  $candidates = @($element) + @(Get-AncestorChain -Element $element)
  foreach ($candidate in $candidates) {
    $got = Get-ElementText -Element $candidate
    if ($got.text -ne '') {
      $text = $got.text
      $via = $got.via
      $sourceElement = ConvertTo-ElementObject -Element $candidate
      break
    }
    $depthFound++
  }

  $truncated = $false
  if ($text.Length -gt $maxChars) {
    $text = $text.Substring(0, $maxChars)
    $truncated = $true
  }

  if ($via -eq 'none') {
    # Nothing exposed text. That is a real answer, but an empty string would be indistinguishable
    # from a broken query, so the fields that were found are returned alongside it.
    return [ordered]@{
      point = [ordered]@{ x = $x; y = $y }
      source = $source
      found = $false
      reason = 'no element at this point exposes text'
      element = $hit
      ancestorsSearched = $depthFound
      text = ''
      via = 'none'
    }
  }

  return [ordered]@{
    point = [ordered]@{ x = $x; y = $y }
    source = $source
    found = $true
    text = $text
    length = $text.Length
    truncated = $truncated
    via = $via
    element = $hit
    # The element that actually supplied the text, which differs from the hit element when the search
    # walked up. Without it a caller cannot tell which control the text came from.
    textElement = $sourceElement
  }
}

function Invoke-StructureAtPoint {
  param($Parsed)
  Assert-MinPositionals -Parsed $Parsed -Min 2 -Verb 'structure'
  Assert-NoExtra -Parsed $Parsed -Expected 2
  $x = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 0) -Name 'x'
  $y = Get-IntArg -Text (Get-Positional -Parsed $Parsed -Index 1) -Name 'y'
  $source = Resolve-SourceFlag -Parsed $Parsed
  $depthText = Get-FlagValue -Parsed $Parsed -Name 'depth' -Default '3'
  $depth = Get-IntArg -Text $depthText -Name 'depth'
  if ($depth -lt 0) {
    throw (New-OsError -Code 'E_RANGE' -Message ("depth must not be negative, got {0}" -f $depth))
  }
  if ($depth -gt 12) {
    # A deep walk of a busy window is thousands of elements and a large envelope; the limit keeps a
    # single call from producing something unusable.
    throw (New-OsError -Code 'E_RANGE' -Message ("depth must be at most 12, got {0}" -f $depth) `
        -Hint 'a deep accessibility tree of a real window can be thousands of elements')
  }

  Initialize-Uia
  $element = Get-ElementAtPoint -X $x -Y $y

  $count = 0
  function ConvertTo-StructureNode {
    param($Node, [int]$Level)
    $script:StructureCount++
    $obj = ConvertTo-ElementObject -Element $Node -Depth $Level
    $children = New-Object System.Collections.ArrayList
    if ($Level -lt $depth) {
      try {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($Node)
        while ($null -ne $child) {
          [void]$children.Add((ConvertTo-StructureNode -Node $child -Level ($Level + 1)))
          try { $child = $walker.GetNextSibling($child) } catch { break }
        }
      } catch { }
    }
    $obj['childCount'] = $children.Count
    if ($children.Count -gt 0) { $obj['children'] = $children.ToArray() }
    return $obj
  }

  $script:StructureCount = 0
  $tree = ConvertTo-StructureNode -Node $element -Level 0
  # Collected with an explicit loop, not a pipeline. ConvertTo-ElementObject returns an ordered
  # dictionary, and a pipeline unrolls a dictionary into its KEYS, so the ForEach-Object form produced
  # raw strings joined together instead of one object per ancestor.
  $ancestors = New-Object System.Collections.ArrayList
  foreach ($a in (Get-AncestorChain -Element $element)) {
    [void]$ancestors.Add((ConvertTo-ElementObject -Element $a))
  }
  $tree['ancestors'] = $ancestors.ToArray()

  return [ordered]@{
    point = [ordered]@{ x = $x; y = $y }
    source = $source
    depth = $depth
    nodeCount = $script:StructureCount
    root = $tree
  }
}
