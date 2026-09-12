' Run the NPU Whisper shim launcher silently at Windows login.
' Place a shortcut to this file in the Startup folder.
' All paths are derived dynamically — no hardcoded usernames.

Dim fso, scriptDir, launcher
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "launch-npu-shim.bat")

If fso.FileExists(launcher) Then
    CreateObject("Wscript.Shell").Run "cmd /c """ & launcher & """", 0, False
End If
