Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FGW {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@
# Return the window handle (HWND) instead of the PID so that switching
# between different windows of the same application is detected.
$h = [FGW]::GetForegroundWindow()
Write-Output ([Int64]$h)
