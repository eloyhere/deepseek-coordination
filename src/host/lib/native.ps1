# Module: native.ps1 - split from the verified bin/dsh-os.ps1 by tools/split-once.ps1.

# Whether the Add-Type P/Invoke block has been compiled. Add-Type costs a few hundred
# milliseconds, so read-only verbs must never trigger it.
$script:NativeReady = $false

function Initialize-Native {
  if ($script:NativeReady) { return }
  $code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshNative
{
    // -- file / process ---------------------------------------------------
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileExW(string existing, string next, int flags);
    public const int MOVEFILE_REPLACE_EXISTING = 0x1;
    public const int MOVEFILE_COPY_ALLOWED = 0x2;
    public const int MOVEFILE_WRITE_THROUGH = 0x8;

    // -- cursor -----------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    // -- synthetic input --------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern short GetKeyState(int vKey);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    // -- foreground / window ----------------------------------------------
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public const uint GW_HWNDNEXT = 2;
    public const uint GW_HWNDPREV = 3;
    public const uint GW_OWNER = 4;
    public const uint WM_CLOSE = 0x0010;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const int SW_MAXIMIZE = 3;

    // Window state, so a verb reports the state it observed rather than assuming the call worked.
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    public static readonly IntPtr HWND_TOP = IntPtr.Zero;
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;

    // -- clipboard --------------------------------------------------------
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint format, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalSize(IntPtr handle);
    public const uint GMEM_MOVEABLE = 0x0002;
    public const uint CF_UNICODETEXT = 13;

    // -- screen capture ---------------------------------------------------
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);
    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr dst, int x, int y, int width, int height, IntPtr src, int sx, int sy, uint rop);
    public const uint SRCCOPY = 0x00CC0020;

    // -- DPI --------------------------------------------------------------
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    // -- security descriptors (layer A enforcement) ------------------------
    //
    // Used to give permission.json an explicit DENY for the automation context's write access. Read
    // side is what matters most: the enforcement strength is measured from the file's real DACL, so a
    // report can never claim protection the kernel is not applying.
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

    [StructLayout(LayoutKind.Sequential)]
    public struct TRUSTEE
    {
        public IntPtr pMultipleTrustee;
        public int MultipleTrusteeOperation;
        public int TrusteeForm;
        public int TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct EXPLICIT_ACCESS
    {
        public int grfAccessPermissions;
        public int grfAccessMode;
        public int grfInheritance;
        public TRUSTEE Trustee;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetNamedSecurityInfoW(
        string objectName, int objectType, int securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint SetNamedSecurityInfoW(
        string objectName, int objectType, int securityInfo,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint SetEntriesInAclW(int count, EXPLICIT_ACCESS[] entries, IntPtr oldAcl, out IntPtr newAcl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetExplicitEntriesFromAclW(IntPtr acl, out uint count, out IntPtr entries);

    [DllImport("advapi32.dll")]
    public static extern bool IsValidAcl(IntPtr acl);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern IntPtr GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);

    // LocalFree is exported by kernel32, NOT by advapi32. Declaring it under advapi32 produced
    // "Unable to find an entry point named 'LocalFree'", which surfaced only at cleanup time - after
    // the deny had already been applied - so the operation looked like a failure while having partly
    // succeeded.
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr handle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

    public const int SE_FILE_OBJECT = 1;
    public const int DACL_SECURITY_INFORMATION = 4;
    public const int PROTECTED_DACL_SECURITY_INFORMATION = unchecked((int)0x80000000);
    public const int TRUSTEE_IS_SID = 0;
    public const int TRUSTEE_IS_WELL_KNOWN_GROUP = 5;
    public const int TRUSTEE_IS_USER = 1;
    public const int DENY_ACCESS = 3;
    public const int GRANT_ACCESS = 1;
    public const int NO_INHERITANCE = 0;
    public const int WRITE_ACCESS = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000100 | 0x00010000 | 0x00040000;
    public const int FILE_GENERIC_WRITE = 0x00120116;
    public const int DELETE = 0x00010000;
    public const int WRITE_DAC = 0x00040000;
    public const int WRITE_OWNER = 0x00080000;
    public const int ACCESS_DENIED_ACE_TYPE = 1;
    public const int ACCESS_ALLOWED_ACE_TYPE = 0;

    // One deny check plus one presence check, without exposing the descriptor layout to PowerShell:
    // parsing the ACL here keeps the ACE walk in the same place as the declarations it depends on.
    public static string DescribeDenyState(string path, string sid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (rc != 0) { return "ERROR:" + rc; }
        try
        {
            if (dacl == IntPtr.Zero) { return "NODACL"; }
            // Walk the ACL: ACE_HEADER is AceType(1) AceFlags(1) AceSize(2), then the mask, then the SID.
            int aceCount = Marshal.ReadInt16(dacl, 4);
            IntPtr p = (IntPtr)(dacl.ToInt64() + 8);
            try
            {
                IntPtr target = IntPtr.Zero;
                ConvertStringSidToSidW(sid, out target);
                if (target == IntPtr.Zero) { return "BADSID"; }
                try
                {
                    int targetLen = 8 + Marshal.ReadByte(target, 1) * 4;
                    for (int i = 0; i < aceCount; i++)
                    {
                        byte aceType = Marshal.ReadByte(p, 0);
                        int aceSize = Marshal.ReadInt16(p, 2);
                        int mask = Marshal.ReadInt32(p, 4);
                        IntPtr aceSid = (IntPtr)(p.ToInt64() + 8);
                        int sidLen = 8 + Marshal.ReadByte(aceSid, 1) * 4;
                        bool sameSid = sidLen == targetLen && CompareMemory(aceSid, target, sidLen);
                        // Only an explicit DENY matters for layer A; an allow for someone else does not
                        // protect anything.
                        if (sameSid && aceType == ACCESS_DENIED_ACE_TYPE && (mask & FILE_GENERIC_WRITE) != 0)
                        {
                            return "DENY";
                        }
                        p = (IntPtr)(p.ToInt64() + aceSize);
                    }
                }
                finally { if (target != IntPtr.Zero) LocalFree(target); }
            }
            finally { }
            return "NONE";
        }
        finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }

    public static bool CompareMemory(IntPtr a, IntPtr b, int length)
    {
        for (int i = 0; i < length; i++)
        {
            if (Marshal.ReadByte(a, i) != Marshal.ReadByte(b, i)) { return false; }
        }
        return true;
    }

    // Apply an explicit DENY for one SID, preserving the existing DACL.
    public static string ApplyDeny(string path, string sid)
    {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            out owner, out group, out dacl, out sacl, out descriptor);
        if (rc != 0) { return "GET:" + rc; }
        IntPtr sidPtr = IntPtr.Zero;
        IntPtr newAcl = IntPtr.Zero;
        try
        {
            if (!ConvertStringSidToSidW(sid, out sidPtr) || sidPtr == IntPtr.Zero) { return "BADSID"; }
            EXPLICIT_ACCESS[] ea = new EXPLICIT_ACCESS[1];
            ea[0].grfAccessPermissions = FILE_GENERIC_WRITE | DELETE | WRITE_DAC | WRITE_OWNER;
            ea[0].grfAccessMode = DENY_ACCESS;
            ea[0].grfInheritance = NO_INHERITANCE;
            ea[0].Trustee.pMultipleTrustee = IntPtr.Zero;
            ea[0].Trustee.MultipleTrusteeOperation = 0;
            ea[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
            ea[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
            ea[0].Trustee.ptstrName = sidPtr;
            uint arc = SetEntriesInAclW(1, ea, dacl, out newAcl);
            if (arc != 0) { return "SETENTRIES:" + arc; }
            uint src = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
            if (src != 0) { return "SETINFO:" + src; }
            return "OK";
        }
        finally
        {
            if (newAcl != IntPtr.Zero) LocalFree(newAcl);
            if (sidPtr != IntPtr.Zero) LocalFree(sidPtr);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }

    // -- helpers ----------------------------------------------------------
    public static string WindowText(IntPtr hWnd)
    {
        int len = GetWindowTextLengthW(hWnd);
        if (len <= 0) { return ""; }
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowTextW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowClass(IntPtr hWnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static void SendKey(ushort vk, ushort scan, uint flags)
    {
        INPUT[] one = new INPUT[1];
        one[0].type = INPUT_KEYBOARD;
        one[0].u.ki.wVk = vk;
        one[0].u.ki.wScan = scan;
        one[0].u.ki.dwFlags = flags;
        one[0].u.ki.time = 0;
        one[0].u.ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void SendUnicodeChar(char ch)
    {
        SendKey(0, (ushort)ch, KEYEVENTF_UNICODE);
        SendKey(0, (ushort)ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    public static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        INPUT[] one = new INPUT[1];
        one[0].type = INPUT_MOUSE;
        one[0].u.mi.dx = dx;
        one[0].u.mi.dy = dy;
        one[0].u.mi.mouseData = data;
        one[0].u.mi.dwFlags = flags;
        one[0].u.mi.time = 0;
        one[0].u.mi.dwExtraInfo = IntPtr.Zero;
        SendInput(1, one, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
  Add-Type -TypeDefinition $code -Language CSharp | Out-Null
  # Declare DPI awareness before any window exists, so reported coordinates and injected clicks
  # agree with what the user sees on a scaled display.
  try { [DshNative]::SetProcessDPIAware() | Out-Null } catch { }
  $script:NativeReady = $true
}

function Invoke-MoveFileReplace {
  param([string]$Source, [string]$Destination)
  Initialize-Native
  $flags = [DshNative]::MOVEFILE_REPLACE_EXISTING -bor [DshNative]::MOVEFILE_WRITE_THROUGH
  return [DshNative]::MoveFileExW($Source, $Destination, $flags)
}

function Write-Atomic {
  param([string]$Path, [byte[]]$Bytes)
  $dir = Split-Path -Parent $Path
  if ([string]::IsNullOrEmpty($dir)) { $dir = (Get-Location).Path }
  if (-not (Test-Path -LiteralPath $dir)) {
    throw (New-OsError -Code 'E_NO_PARENT' -Message ("cannot write '{0}': directory '{1}' does not exist" -f $Path, $dir))
  }
  $tmp = Join-Path $dir ('.dsh-os-' + [Guid]::NewGuid().ToString('n') + '.tmp')
  try {
    [System.IO.File]::WriteAllBytes($tmp, $Bytes)
    # The temporary is fully written before it is published, so a reader never observes a partially
    # written target. .NET Framework has no File.Move(overwrite), so the replace goes through
    # MoveFileExW with MOVEFILE_REPLACE_EXISTING.
    if (Test-Path -LiteralPath $Path) {
      if (-not (Invoke-MoveFileReplace -Source $tmp -Destination $Path)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot replace '{0}': MoveFileExW failed with win32 error {1}" -f $Path, $err))
      }
    } else {
      [System.IO.File]::Move($tmp, $Path)
    }
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if ($_.Exception.Message -match 'already exists') {
      throw (New-OsError -Code 'E_EXISTS' -Message ("cannot write '{0}': it already exists" -f $Path))
    }
    if ($_.Exception.PSObject.Properties['OsCode']) { throw }
    throw (New-OsError -Code 'E_PARTIAL_WRITE' -Message ("cannot write '{0}': {1}" -f $Path, $_.Exception.Message))
  }
}

