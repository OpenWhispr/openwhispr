const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

// PowerShell fallback for when nircmd.exe isn't bundled/found. Talks to the
// Windows Core Audio API (IMMDeviceEnumerator / IAudioEndpointVolume) directly
// via COM interop so muting doesn't depend on any external binary.
//
// All COM activation/casting happens inside the compiled C# helper — the
// C# compiler special-cases `new` on a [ComImport] class (CoCreateInstance)
// and interface casts on RCWs (QueryInterface). Doing the same casts from
// PowerShell's reflection-driven New-Object/cast operators doesn't trigger
// that special-casing and fails with an InvalidCastException.
const MIC_MUTE_HELPER_SOURCE = `
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl_EnumAudioEndpoints();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl_RegisterControlChangeNotify();
  int NotImpl_UnregisterControlChangeNotify();
  int NotImpl_GetChannelCount();
  int NotImpl_SetMasterVolumeLevel();
  int NotImpl_SetMasterVolumeLevelScalar();
  int NotImpl_GetMasterVolumeLevel();
  int NotImpl_GetMasterVolumeLevelScalar();
  int NotImpl_SetChannelVolumeLevel();
  int NotImpl_SetChannelVolumeLevelScalar();
  int NotImpl_GetChannelVolumeLevel();
  int NotImpl_GetChannelVolumeLevelScalar();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
}

public static class EktosWhisprMicMuteHelper {
  public static void SetMute(bool mute) {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device;
    // dataFlow: eCapture = 1, role: eMultimedia = 1 (matches the Recording tab's Default Device)
    enumerator.GetDefaultAudioEndpoint(1, 1, out device);
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    object epvObj;
    // dwClsCtx: CLSCTX_ALL = 23
    device.Activate(ref iid, 23, IntPtr.Zero, out epvObj);
    var epv = (IAudioEndpointVolume)epvObj;
    Guid ctx = Guid.Empty;
    epv.SetMute(mute, ref ctx);
  }
}
`;

const buildSetMuteScript = (muted) => `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
${MIC_MUTE_HELPER_SOURCE}
"@
[EktosWhisprMicMuteHelper]::SetMute($${muted ? "true" : "false"})
Write-Output "MIC_MUTE_OK ${muted}"
`;

class MicMuteManager {
  constructor() {
    this.nircmdPath = null;
    this.nircmdChecked = false;
  }

  getNircmdPath() {
    if (this.nircmdChecked) {
      return this.nircmdPath;
    }
    this.nircmdChecked = true;

    const possiblePaths = [
      ...(process.resourcesPath ? [path.join(process.resourcesPath, "bin", "nircmd.exe")] : []),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
      path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
    ];

    for (const candidate of possiblePaths) {
      try {
        if (fs.existsSync(candidate)) {
          this.nircmdPath = candidate;
          return candidate;
        }
      } catch {
        // Keep checking other candidates.
      }
    }
    return null;
  }

  async setMuted(muted) {
    if (process.platform !== "win32") {
      debugLogger.debug(
        "[MicMute] Unsupported platform, skipping",
        { platform: process.platform },
        "audio"
      );
      return { success: false, error: "Unsupported platform" };
    }

    const nircmdPath = this.getNircmdPath();
    if (nircmdPath) {
      return this._setMutedNircmd(nircmdPath, muted);
    }
    return this._setMutedPowerShell(muted);
  }

  _setMutedNircmd(nircmdPath, muted) {
    return new Promise((resolve) => {
      const proc = spawn(nircmdPath, ["mutesysvolume", muted ? "1" : "0", "microphone"], {
        windowsHide: true,
      });

      proc.on("close", (code) => {
        if (code === 0) {
          debugLogger.debug("[MicMute] nircmd set mute", { muted }, "audio");
          resolve({ success: true });
        } else {
          debugLogger.warn(
            "[MicMute] nircmd failed, falling back to PowerShell",
            { code },
            "audio"
          );
          this._setMutedPowerShell(muted).then(resolve);
        }
      });

      proc.on("error", (error) => {
        debugLogger.warn(
          "[MicMute] nircmd error, falling back to PowerShell",
          { error: error.message },
          "audio"
        );
        this._setMutedPowerShell(muted).then(resolve);
      });
    });
  }

  _setMutedPowerShell(muted) {
    const script = buildSetMuteScript(muted);
    return new Promise((resolve) => {
      const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
      });

      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          debugLogger.debug("[MicMute] PowerShell set mute", { muted }, "audio");
          resolve({ success: true });
        } else {
          debugLogger.warn(
            "[MicMute] PowerShell mute failed",
            { code, stderr: stderr.trim() },
            "audio"
          );
          resolve({ success: false, error: stderr.trim() || `exit code ${code}` });
        }
      });

      proc.on("error", (error) => {
        debugLogger.warn("[MicMute] PowerShell mute error", { error: error.message }, "audio");
        resolve({ success: false, error: error.message });
      });
    });
  }
}

module.exports = new MicMuteManager();
