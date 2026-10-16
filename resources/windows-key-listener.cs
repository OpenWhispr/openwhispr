using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class Program {
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;
    private const int WM_NCXBUTTONDOWN = 0x00AB;
    private const int WM_NCXBUTTONUP = 0x00AC;

    private const uint VK_MBUTTON = 0x04;
    private const uint VK_XBUTTON1 = 0x05;
    private const uint VK_XBUTTON2 = 0x06;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    private static IntPtr _kHook = IntPtr.Zero;
    private static IntPtr _mHook = IntPtr.Zero;
    private static HookProc _kProc;
    private static HookProc _mProc;

    private static uint _targetVk = 0;
    private static bool _isKeyDown = false;

    private static bool _requireCtrl = false;
    private static bool _requireAlt = false;
    private static bool _requireShift = false;
    private static bool _requireWin = false;

    public static void Main(string[] args) {
        if (args.Length < 1) {
            Console.WriteLine("Usage: windows-key-listener <key>");
            return;
        }

        string hotkey = args[0];
        ParseHotkey(hotkey);

        _kProc = HookCallbackKeyboard;
        _mProc = HookCallbackMouse;

        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            IntPtr hModule = GetModuleHandle(curModule.ModuleName);
            _kHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kProc, hModule, 0);
            _mHook = SetWindowsHookEx(WH_MOUSE_LL, _mProc, hModule, 0);
        }

        Console.WriteLine("READY");
        Console.Out.Flush();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        if (_kHook != IntPtr.Zero) UnhookWindowsHookEx(_kHook);
        if (_mHook != IntPtr.Zero) UnhookWindowsHookEx(_mHook);
    }

    private static void ParseHotkey(string hotkey) {
        string[] parts = hotkey.Split('+');
        for (int i = 0; i < parts.Length; i++) {
            string p = parts[i].Trim();
            if (string.Equals(p, "Ctrl", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(p, "Control", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(p, "CommandOrControl", StringComparison.OrdinalIgnoreCase)) {
                _requireCtrl = true;
            } else if (string.Equals(p, "Alt", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(p, "Option", StringComparison.OrdinalIgnoreCase)) {
                _requireAlt = true;
            } else if (string.Equals(p, "Shift", StringComparison.OrdinalIgnoreCase)) {
                _requireShift = true;
            } else if (string.Equals(p, "Win", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(p, "Super", StringComparison.OrdinalIgnoreCase)) {
                _requireWin = true;
            } else {
                _targetVk = ParseVk(p);
            }
        }
    }

    private static uint ParseVk(string key) {
        if (string.Equals(key, "MouseButton4", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "Mouse4", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "XButton1", StringComparison.OrdinalIgnoreCase)) return VK_XBUTTON1;

        if (string.Equals(key, "MouseButton5", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "Mouse5", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "XButton2", StringComparison.OrdinalIgnoreCase)) return VK_XBUTTON2;

        if (string.Equals(key, "MouseButton3", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "Mouse3", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(key, "MiddleButton", StringComparison.OrdinalIgnoreCase)) return VK_MBUTTON;

        int fNum;
        if (key.StartsWith("F", StringComparison.OrdinalIgnoreCase) && int.TryParse(key.Substring(1), out fNum)) {
            if (fNum >= 1 && fNum <= 24) return (uint)(0x70 + (fNum - 1));
        }

        if (key.Length == 1) {
            char c = char.ToUpper(key[0]);
            if (c >= 'A' && c <= 'Z') return (uint)c;
            if (c >= '0' && c <= '9') return (uint)c;
        }

        return 0;
    }

    private static bool AreModifiersSatisfied() {
        if (_requireCtrl && (GetAsyncKeyState(0x11) & 0x8000) == 0) return false;
        if (_requireAlt && (GetAsyncKeyState(0x12) & 0x8000) == 0) return false;
        if (_requireShift && (GetAsyncKeyState(0x10) & 0x8000) == 0) return false;
        if (_requireWin && ((GetAsyncKeyState(0x5B) & 0x8000) == 0 && (GetAsyncKeyState(0x5C) & 0x8000) == 0)) return false;
        return true;
    }

    private static IntPtr HookCallbackKeyboard(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            KBDLLHOOKSTRUCT kbd = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));

            if (kbd.vkCode == _targetVk) {
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                    if (!_isKeyDown && AreModifiersSatisfied()) {
                        _isKeyDown = true;
                        Console.WriteLine("KEY_DOWN");
                        Console.Out.Flush();
                    }
                } else if (msg == WM_KEYUP || msg == WM_SYSKEYUP) {
                    if (_isKeyDown) {
                        _isKeyDown = false;
                        Console.WriteLine("KEY_UP");
                        Console.Out.Flush();
                    }
                }
            }
        }
        return CallNextHookEx(_kHook, nCode, wParam, lParam);
    }

    private static IntPtr HookCallbackMouse(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            MSLLHOOKSTRUCT mouse = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            uint vkCode = 0;
            bool isDown = false;
            bool isUp = false;

            if (msg == WM_XBUTTONDOWN || msg == WM_NCXBUTTONDOWN) {
                uint xButton = (mouse.mouseData >> 16) & 0xFFFF;
                if (xButton == 1) vkCode = VK_XBUTTON1;
                else if (xButton == 2) vkCode = VK_XBUTTON2;
                isDown = true;
            } else if (msg == WM_XBUTTONUP || msg == WM_NCXBUTTONUP) {
                uint xButton = (mouse.mouseData >> 16) & 0xFFFF;
                if (xButton == 1) vkCode = VK_XBUTTON1;
                else if (xButton == 2) vkCode = VK_XBUTTON2;
                isUp = true;
            } else if (msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP) {
                vkCode = VK_MBUTTON;
                isDown = (msg == WM_MBUTTONDOWN);
                isUp = (msg == WM_MBUTTONUP);
            }

            if (vkCode != 0 && vkCode == _targetVk) {
                if (isDown) {
                    if (!_isKeyDown && AreModifiersSatisfied()) {
                        _isKeyDown = true;
                        Console.WriteLine("KEY_DOWN");
                        Console.Out.Flush();
                    }
                } else if (isUp) {
                    if (_isKeyDown) {
                        _isKeyDown = false;
                        Console.WriteLine("KEY_UP");
                        Console.Out.Flush();
                    }
                }
            }
        }
        return CallNextHookEx(_mHook, nCode, wParam, lParam);
    }
}
