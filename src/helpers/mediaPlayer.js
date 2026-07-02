const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

class MediaPlayer {
  constructor() {
    this._linuxBinaryChecked = false;
    this._linuxBinaryPath = null;
    this._nircmdChecked = false;
    this._nircmdPath = null;
    this._macBinaryChecked = false;
    this._macBinaryPath = null;
    this._pausedPlayers = []; // MPRIS players we paused (Linux)
    this._didPause = false; // Whether we sent a pause via toggle fallback
    this._pausedWinApps = []; // GSMTC app IDs we paused (Windows)
    this._audioDuckActive = false;
    this._audioDuckOriginalVolume = null;
  }

  _resolveLinuxFastPaste() {
    if (this._linuxBinaryChecked) return this._linuxBinaryPath;
    this._linuxBinaryChecked = true;

    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", "linux-fast-paste"),
      path.join(__dirname, "..", "..", "resources", "linux-fast-paste"),
    ];

    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", "linux-fast-paste"));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this._linuxBinaryPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  _resolveNircmd() {
    if (this._nircmdChecked) return this._nircmdPath;
    this._nircmdChecked = true;

    const candidates = [
      path.join(process.resourcesPath || "", "bin", "nircmd.exe"),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          this._nircmdPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  _resolveMacMediaRemote() {
    if (this._macBinaryChecked) return this._macBinaryPath;
    this._macBinaryChecked = true;

    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", "macos-media-remote"),
      path.join(__dirname, "..", "..", "resources", "macos-media-remote"),
    ];

    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "bin", "macos-media-remote"));
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this._macBinaryPath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  _shouldDuckAudio() {
    const mode = (process.env.OPENWHISPR_MEDIA_ON_DICTATION || "").trim().toLowerCase();
    return mode === "duck" || process.env.OPENWHISPR_AUDIO_DUCKING_ENABLED === "true";
  }

  _getAudioDuckingTargetVolume() {
    const raw =
      process.env.OPENWHISPR_AUDIO_DUCKING_VOLUME ||
      process.env.OPENWHISPR_DUCKING_VOLUME ||
      process.env.OPENWHISPR_DUCK_VOLUME ||
      "25";
    return this._clampVolume(raw, 25);
  }

  _clampVolume(value, fallback = 25) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  }

  _compactProcessOutput(output) {
    return (output || "").toString().trim().replace(/\s+/g, " ").slice(0, 600) || undefined;
  }

  pauseMedia() {
    if (this._shouldDuckAudio()) {
      return this.duckAudio();
    }

    try {
      if (process.platform === "linux") {
        return this._pauseLinux();
      } else if (process.platform === "darwin") {
        return this._pauseMacOS();
      } else if (process.platform === "win32") {
        return this._pauseWindows();
      }
    } catch (err) {
      debugLogger.warn("Media pause failed", { error: err.message }, "media");
    }
    return false;
  }

  resumeMedia() {
    if (this._audioDuckActive) {
      return this.restoreAudio();
    }

    try {
      if (process.platform === "linux") {
        return this._resumeLinux();
      } else if (process.platform === "darwin") {
        return this._resumeMacOS();
      } else if (process.platform === "win32") {
        return this._resumeWindows();
      }
    } catch (err) {
      debugLogger.warn("Media resume failed", { error: err.message }, "media");
    }
    return false;
  }

  toggleMedia() {
    try {
      if (process.platform === "linux") {
        return this._toggleLinux();
      } else if (process.platform === "darwin") {
        return this._toggleMacOS();
      } else if (process.platform === "win32") {
        return this._toggleWindows();
      }
    } catch (err) {
      debugLogger.warn("Media toggle failed", { error: err.message }, "media");
    }
    return false;
  }

  duckAudio(targetVolumePercent = this._getAudioDuckingTargetVolume()) {
    try {
      const target = this._clampVolume(targetVolumePercent, this._getAudioDuckingTargetVolume());
      const current = this._getSystemVolumePercent();

      if (current === null) {
        debugLogger.warn("Audio ducking unavailable: could not read system volume", {}, "media");
        return false;
      }

      if (!this._audioDuckActive) {
        this._audioDuckOriginalVolume = current;
        this._audioDuckActive = true;
      }

      if (current > target) {
        const changed = this._setSystemVolumePercent(target);
        if (!changed) {
          debugLogger.warn("Audio ducking failed: could not set system volume", { target }, "media");
          return false;
        }
      }

      debugLogger.debug(
        "Audio ducked for dictation",
        { originalVolume: this._audioDuckOriginalVolume, targetVolume: target },
        "media"
      );
      return true;
    } catch (err) {
      debugLogger.warn("Audio ducking failed", { error: err.message }, "media");
      return false;
    }
  }

  restoreAudio() {
    if (!this._audioDuckActive) return false;

    const originalVolume = this._audioDuckOriginalVolume;
    this._audioDuckActive = false;
    this._audioDuckOriginalVolume = null;

    if (originalVolume === null || originalVolume === undefined) return false;

    try {
      const restored = this._setSystemVolumePercent(originalVolume);
      if (restored) {
        debugLogger.debug("Audio ducking restored system volume", { originalVolume }, "media");
      } else {
        debugLogger.warn("Audio ducking restore failed", { originalVolume }, "media");
      }
      return restored;
    } catch (err) {
      debugLogger.warn("Audio ducking restore failed", { error: err.message }, "media");
      return false;
    }
  }

  _getSystemVolumePercent() {
    if (process.platform === "win32") return this._getWindowsVolumePercent();
    if (process.platform === "darwin") return this._getMacVolumePercent();
    if (process.platform === "linux") return this._getLinuxVolumePercent();
    return null;
  }

  _setSystemVolumePercent(percent) {
    const safePercent = this._clampVolume(percent);
    if (process.platform === "win32") return this._setWindowsVolumePercent(safePercent);
    if (process.platform === "darwin") return this._setMacVolumePercent(safePercent);
    if (process.platform === "linux") return this._setLinuxVolumePercent(safePercent);
    return false;
  }

  _windowsVolumeScript() {
    return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public enum EDataFlow {
  eRender = 0,
  eCapture = 1,
  eAll = 2
}

public enum ERole {
  eConsole = 0,
  eMultimedia = 1,
  eCommunications = 2
}

[Flags]
public enum CLSCTX : uint {
  INPROC_SERVER = 0x1,
  INPROC_HANDLER = 0x2,
  LOCAL_SERVER = 0x4,
  REMOTE_SERVER = 0x10,
  ALL = INPROC_SERVER | INPROC_HANDLER | LOCAL_SERVER | REMOTE_SERVER
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, IntPtr ppDevices);
  [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
  [PreserveSig] int GetDevice(string pwstrId, out IMMDevice ppDevice);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, CLSCTX dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr pNotify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr pNotify);
  [PreserveSig] int GetChannelCount(out uint pnChannelCount);
  [PreserveSig] int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
  [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  [PreserveSig] int GetMasterVolumeLevel(out float pfLevelDB);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
  [PreserveSig] int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
  [PreserveSig] int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  [PreserveSig] int GetMute(out bool pbMute);
  [PreserveSig] int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
  [PreserveSig] int VolumeStepUp(Guid pguidEventContext);
  [PreserveSig] int VolumeStepDown(Guid pguidEventContext);
  [PreserveSig] int QueryHardwareSupport(out uint pdwHardwareSupportMask);
  [PreserveSig] int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {}

public class AudioEndpoint {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device;
    int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
    Marshal.ThrowExceptionForHR(hr);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume endpoint;
    hr = device.Activate(ref iid, CLSCTX.ALL, IntPtr.Zero, out endpoint);
    Marshal.ThrowExceptionForHR(hr);
    return endpoint;
  }

  public static float GetVolume() {
    float value;
    int hr = Endpoint().GetMasterVolumeLevelScalar(out value);
    Marshal.ThrowExceptionForHR(hr);
    return value * 100.0f;
  }

  public static void SetVolume(float percent) {
    percent = Math.Max(0.0f, Math.Min(100.0f, percent));
    Guid g = Guid.Empty;
    int hr = Endpoint().SetMasterVolumeLevelScalar(percent / 100.0f, g);
    Marshal.ThrowExceptionForHR(hr);
  }
}
"@
`;
  }

  _runWindowsVolumePowerShell(command) {
    return spawnSync(
      "powershell",
      ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { stdio: "pipe", timeout: 7000, windowsHide: true }
    );
  }

  _getWindowsVolumePercent() {
    const result = this._runWindowsVolumePowerShell(
      `${this._windowsVolumeScript()}\n[AudioEndpoint]::GetVolume()`
    );
    const stdout = (result.stdout?.toString() || "").trim();
    const stderr = (result.stderr?.toString() || "").trim();

    if (result.status !== 0) {
      debugLogger.warn(
        "Windows volume read failed",
        {
          status: result.status,
          signal: result.signal,
          stdout: this._compactProcessOutput(stdout),
          stderr: this._compactProcessOutput(stderr),
        },
        "media"
      );
      return null;
    }

    const match = stdout.match(/-?\d+(?:\.\d+)?/);
    const parsed = match ? Number(match[0]) : NaN;
    if (!Number.isFinite(parsed)) {
      debugLogger.warn(
        "Windows volume read returned non-numeric output",
        {
          stdout: this._compactProcessOutput(stdout),
          stderr: this._compactProcessOutput(stderr),
        },
        "media"
      );
      return null;
    }

    return this._clampVolume(parsed);
  }

  _setWindowsVolumePercent(percent) {
    const target = this._clampVolume(percent);
    const result = this._runWindowsVolumePowerShell(
      `${this._windowsVolumeScript()}\n[AudioEndpoint]::SetVolume(${target})`
    );
    if (result.status !== 0) {
      debugLogger.warn(
        "Windows volume set failed",
        {
          target,
          status: result.status,
          signal: result.signal,
          stdout: this._compactProcessOutput(result.stdout),
          stderr: this._compactProcessOutput(result.stderr),
        },
        "media"
      );
      return false;
    }
    return true;
  }

  _getMacVolumePercent() {
    const result = spawnSync("osascript", ["-e", "output volume of (get volume settings)"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (result.status !== 0) return null;
    const parsed = Number((result.stdout?.toString() || "").trim());
    return Number.isFinite(parsed) ? this._clampVolume(parsed) : null;
  }

  _setMacVolumePercent(percent) {
    const result = spawnSync("osascript", ["-e", `set volume output volume ${this._clampVolume(percent)}`], {
      stdio: "pipe",
      timeout: 3000,
    });
    return result.status === 0;
  }

  _getLinuxVolumePercent() {
    const pactl = spawnSync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (pactl.status === 0) {
      const output = pactl.stdout?.toString() || "";
      const match = output.match(/(\d+)%/);
      if (match) return this._clampVolume(match[1]);
    }

    const wpctl = spawnSync("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (wpctl.status === 0) {
      const output = wpctl.stdout?.toString() || "";
      const match = output.match(/Volume:\s*([0-9.]+)/);
      if (match) return this._clampVolume(Number(match[1]) * 100);
    }

    return null;
  }

  _setLinuxVolumePercent(percent) {
    const safePercent = this._clampVolume(percent);
    const pactl = spawnSync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${safePercent}%`], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (pactl.status === 0) return true;

    const wpctl = spawnSync("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", `${safePercent / 100}`], {
      stdio: "pipe",
      timeout: 3000,
    });
    return wpctl.status === 0;
  }

  // --- Linux: MPRIS-aware pause/resume ---

  _pauseLinux() {
    this._pausedPlayers = [];
    if (this._pauseMpris()) return true;

    // Fallback: playerctl pause (not play-pause)
    const result = spawnSync("playerctl", ["pause"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (result.status === 0) {
      debugLogger.debug("Media paused via playerctl", {}, "media");
      this._pausedPlayers = ["playerctl"];
      return true;
    }

    return false;
  }

  _resumeLinux() {
    if (this._pausedPlayers.length === 0) return false;

    // If we used playerctl fallback
    if (this._pausedPlayers.length === 1 && this._pausedPlayers[0] === "playerctl") {
      this._pausedPlayers = [];
      const result = spawnSync("playerctl", ["play"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media resumed via playerctl", {}, "media");
        return true;
      }
      return false;
    }

    const resumed = this._resumeMpris();
    this._pausedPlayers = [];
    return resumed;
  }

  _pauseMpris() {
    const players = this._listMprisPlayers();
    if (!players || players.length === 0) return false;

    for (const dest of players) {
      const status = this._getMprisPlaybackStatus(dest);
      if (status !== "Playing") continue;

      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.Pause",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media paused via MPRIS", { player: dest }, "media");
        this._pausedPlayers.push(dest);
      }
    }
    return this._pausedPlayers.length > 0;
  }

  _resumeMpris() {
    let resumed = false;
    for (const dest of this._pausedPlayers) {
      if (dest === "playerctl") continue;
      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.Play",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media resumed via MPRIS", { player: dest }, "media");
        resumed = true;
      }
    }
    return resumed;
  }

  _getMprisPlaybackStatus(dest) {
    const result = spawnSync(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        `--dest=${dest}`,
        "/org/mpris/MediaPlayer2",
        "org.freedesktop.DBus.Properties.Get",
        "string:org.mpris.MediaPlayer2.Player",
        "string:PlaybackStatus",
      ],
      { stdio: "pipe", timeout: 2000 }
    );

    if (result.status !== 0) return null;

    const output = result.stdout?.toString() || "";
    const match = output.match(/string "([A-Za-z]+)"/);
    return match ? match[1] : null;
  }

  _listMprisPlayers() {
    const listResult = spawnSync(
      "dbus-send",
      [
        "--session",
        "--dest=org.freedesktop.DBus",
        "--type=method_call",
        "--print-reply",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.ListNames",
      ],
      { stdio: "pipe", timeout: 2000 }
    );

    if (listResult.status !== 0) return [];

    const output = listResult.stdout?.toString() || "";
    const matches = output.match(/string "org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.\-]+"/g);
    if (!matches || matches.length === 0) return [];

    return matches.map((m) => m.replace(/^string "/, "").replace(/"$/, ""));
  }

  // --- Linux toggle (legacy, used by toggleMedia) ---

  _toggleLinux() {
    if (this._toggleMpris()) return true;

    const binary = this._resolveLinuxFastPaste();
    if (binary) {
      const result = spawnSync(binary, ["--media-play-pause"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media toggled via linux-fast-paste", {}, "media");
        return true;
      }
    }

    const result = spawnSync("playerctl", ["play-pause"], {
      stdio: "pipe",
      timeout: 3000,
    });
    if (result.status === 0) {
      debugLogger.debug("Media toggled via playerctl", {}, "media");
      return true;
    }

    debugLogger.warn("No media control method available on Linux", {}, "media");
    return false;
  }

  _toggleMpris() {
    const players = this._listMprisPlayers();
    if (!players || players.length === 0) return false;

    let toggled = false;
    for (const dest of players) {
      const result = spawnSync(
        "dbus-send",
        [
          "--session",
          "--type=method_call",
          `--dest=${dest}`,
          "/org/mpris/MediaPlayer2",
          "org.mpris.MediaPlayer2.Player.PlayPause",
        ],
        { stdio: "pipe", timeout: 2000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media toggled via MPRIS", { player: dest }, "media");
        toggled = true;
      }
    }
    return toggled;
  }

  // --- macOS: MediaRemote-aware pause/resume ---

  _pauseMacOS() {
    this._didPause = false;

    // Try MediaRemote binary first (state-aware, no toggle)
    const binary = this._resolveMacMediaRemote();
    if (binary) {
      const result = spawnSync(binary, ["--pause"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media paused via MediaRemote", {}, "media");
        this._didPause = true;
        return true;
      }
      // exit 1 = nothing was playing, don't fallback to toggle
      const output = (result.stdout?.toString() || "").trim();
      if (output === "NOT_PLAYING") return false;
    }

    // Fallback to media key toggle
    debugLogger.debug("MediaRemote unavailable, falling back to osascript", {}, "media");
    if (this._sendMacMediaKey()) {
      this._didPause = true;
      return true;
    }
    return false;
  }

  _resumeMacOS() {
    if (!this._didPause) return false;
    this._didPause = false;

    const binary = this._resolveMacMediaRemote();
    if (binary) {
      const result = spawnSync(binary, ["--play"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media resumed via MediaRemote", {}, "media");
        return true;
      }
    }

    // Fallback to media key toggle
    return this._sendMacMediaKey();
  }

  _sendMacMediaKey() {
    const result = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 100'],
      {
        stdio: "pipe",
        timeout: 3000,
      }
    );
    if (result.status === 0) {
      debugLogger.debug("Media key sent via osascript", {}, "media");
      return true;
    }
    return false;
  }

  _toggleMacOS() {
    const result = spawnSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 100'],
      {
        stdio: "pipe",
        timeout: 3000,
      }
    );
    if (result.status === 0) {
      debugLogger.debug("Media toggled via osascript", {}, "media");
      return true;
    }
    return false;
  }

  // --- Windows: GSMTC-aware pause/resume ---

  // WinRT IAsyncOperation objects appear as opaque System.__ComObject in
  // PowerShell, so .GetAwaiter() isn't available directly. This preamble
  // loads the System.Runtime.WindowsRuntime bridge and defines an Await
  // helper that converts IAsyncOperation<T> to a .NET Task via AsTask().
  _gsmtcPreamble() {
    return `Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])`;
  }

  _gsmtcPauseScript() {
    const preamble = this._gsmtcPreamble();
    return `
try {
  ${preamble}
  $paused = @()
  foreach ($s in $m.GetSessions()) {
    try {
      $pi = $s.GetPlaybackInfo()
      if ($pi.PlaybackStatus -eq 4) {
        $ok = Await ($s.TryPauseAsync()) ([bool])
        if ($ok) { $paused += $s.SourceAppUserModelId }
      }
    } catch { continue }
  }
  $paused -join '|'
} catch {
  Write-Output 'GSMTC_FAIL'
}`.trim();
  }

  _gsmtcResumeScript(appIds) {
    const idList = appIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const preamble = this._gsmtcPreamble();
    return `
try {
  ${preamble}
  $ids = @(${idList})
  foreach ($s in $m.GetSessions()) {
    try {
      if ($ids -contains $s.SourceAppUserModelId) {
        $null = Await ($s.TryPlayAsync()) ([bool])
      }
    } catch { continue }
  }
  Write-Output 'OK'
} catch {
  Write-Output 'GSMTC_FAIL'
}`.trim();
  }

  _sendWindowsMediaKey() {
    const nircmd = this._resolveNircmd();
    if (nircmd) {
      const result = spawnSync(nircmd, ["sendkeypress", "0xB3"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) return true;
    }

    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class KB { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [KB]::keybd_event(0xB3, 0, 1, 0); [KB]::keybd_event(0xB3, 0, 3, 0)",
      ],
      {
        stdio: "pipe",
        timeout: 5000,
      }
    );
    return result.status === 0;
  }

  _pauseWindows() {
    this._pausedWinApps = [];
    this._didPause = false;

    // Use GSMTC (Windows 10 1809+) — state-aware, targets specific apps
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcPauseScript()],
      { stdio: "pipe", timeout: 5000 }
    );

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      if (output === "GSMTC_FAIL") {
        debugLogger.debug("GSMTC unavailable, falling back to media key", {}, "media");
        return this._pauseWindowsFallback();
      }
      this._pausedWinApps = output.split("|").filter(Boolean);
      if (this._pausedWinApps.length > 0) {
        debugLogger.debug("Media paused via GSMTC", { apps: this._pausedWinApps }, "media");
        return true;
      }
      debugLogger.debug("GSMTC found no playing sessions", {}, "media");
      return false;
    }

    const stderr = (result.stderr?.toString() || "").trim();
    debugLogger.debug(
      "GSMTC PowerShell failed, falling back to media key",
      {
        status: result.status,
        signal: result.signal,
        stderr: stderr ? stderr.slice(0, 200) : undefined,
      },
      "media"
    );
    return this._pauseWindowsFallback();
  }

  _pauseWindowsFallback() {
    if (this._sendWindowsMediaKey()) {
      this._didPause = true;
      debugLogger.debug("Media paused via media key fallback", {}, "media");
      return true;
    }
    return false;
  }

  _resumeWindows() {
    // Resume via GSMTC if we paused that way
    if (this._pausedWinApps && this._pausedWinApps.length > 0) {
      const apps = this._pausedWinApps;
      this._pausedWinApps = [];

      const result = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcResumeScript(apps)],
        { stdio: "pipe", timeout: 5000 }
      );

      if (result.status === 0) {
        debugLogger.debug("Media resumed via GSMTC", { apps }, "media");
        return true;
      }

      // GSMTC resume failed, fall back to media key
      debugLogger.debug("GSMTC resume failed, falling back to media key", {}, "media");
      return this._sendWindowsMediaKey();
    }

    // Resume via media key toggle if we paused with the fallback
    if (this._didPause) {
      this._didPause = false;
      if (this._sendWindowsMediaKey()) {
        debugLogger.debug("Media resumed via media key fallback", {}, "media");
        return true;
      }
    }

    return false;
  }

  _toggleWindows() {
    if (this._sendWindowsMediaKey()) {
      debugLogger.debug("Media toggled via Windows media key", {}, "media");
      return true;
    }
    return false;
  }
}

module.exports = new MediaPlayer();