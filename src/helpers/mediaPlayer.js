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

  pauseMedia() {
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
    this._pausedMacApps = [];

    // Try direct AppleScript control of known players first (no accessibility permission needed)
    const apps = [
      { name: "Spotify", pauseCmd: 'tell application "Spotify" to pause', checkCmd: 'tell application "Spotify" to player state as string', playing: "playing" },
      { name: "Music", pauseCmd: 'tell application "Music" to pause', checkCmd: 'tell application "Music" to player state as string', playing: "playing" },
    ];

    for (const app of apps) {
      try {
        // Check if app is running first (don't launch it)
        const running = spawnSync("osascript", ["-e",
          `tell application "System Events" to (name of processes) contains "${app.name}"`
        ], { stdio: "pipe", timeout: 2000 });
        if (running.status !== 0 || !(running.stdout?.toString() || "").includes("true")) continue;

        const check = spawnSync("osascript", ["-e", app.checkCmd], { stdio: "pipe", timeout: 2000 });
        if (check.status !== 0) continue;
        const state = (check.stdout?.toString() || "").trim();
        if (state !== app.playing) continue;

        const pause = spawnSync("osascript", ["-e", app.pauseCmd], { stdio: "pipe", timeout: 2000 });
        if (pause.status === 0) {
          debugLogger.debug("Media paused via AppleScript", { app: app.name }, "media");
          this._pausedMacApps.push(app.name);
        }
      } catch (err) {
        debugLogger.warn("AppleScript pause failed", { app: app.name, error: err.message }, "media");
      }
    }

    // Also try to pause browser audio via MediaRemote (catches Brain.fm etc)
    const binary = this._resolveMacMediaRemote();
    if (binary) {
      const result = spawnSync(binary, ["--pause"], {
        stdio: "pipe",
        timeout: 3000,
      });
      if (result.status === 0) {
        debugLogger.debug("Media paused via MediaRemote", {}, "media");
        this._pausedMacApps.push("__mediaremote__");
      }
    }

    if (this._pausedMacApps.length > 0) {
      this._didPause = true;
      return true;
    }

    // Final fallback to media key toggle
    debugLogger.debug("No players found, falling back to media key", {}, "media");
    if (this._sendMacMediaKey()) {
      this._didPause = true;
      return true;
    }
    return false;
  }

  _resumeMacOS() {
    if (!this._didPause) return false;
    this._didPause = false;

    const apps = this._pausedMacApps || [];
    this._pausedMacApps = [];
    let resumed = false;

    for (const appName of apps) {
      if (appName === "__mediaremote__") {
        const binary = this._resolveMacMediaRemote();
        if (binary) {
          const result = spawnSync(binary, ["--play"], { stdio: "pipe", timeout: 3000 });
          if (result.status === 0) {
            debugLogger.debug("Media resumed via MediaRemote", {}, "media");
            resumed = true;
          }
        }
        continue;
      }

      const playCmd = `tell application "${appName}" to play`;
      const result = spawnSync("osascript", ["-e", playCmd], { stdio: "pipe", timeout: 2000 });
      if (result.status === 0) {
        debugLogger.debug("Media resumed via AppleScript", { app: appName }, "media");
        resumed = true;
      }
    }

    if (!resumed) {
      return this._sendMacMediaKey();
    }
    return resumed;
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

  _gsmtcPauseScript() {
    return `
try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
  $paused = @()
  foreach ($s in $m.GetSessions()) {
    $pi = $s.GetPlaybackInfo()
    if ($pi.PlaybackStatus -eq 4) {
      $null = $s.TryPauseAsync().GetAwaiter().GetResult()
      $paused += $s.SourceAppUserModelId
    }
  }
  $paused -join '|'
} catch {
  Write-Output 'GSMTC_FAIL'
}`.trim();
  }

  _gsmtcResumeScript(appIds) {
    const idList = appIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    return `
try {
  $ids = @(${idList})
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $m = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult()
  foreach ($s in $m.GetSessions()) {
    if ($ids -contains $s.SourceAppUserModelId) {
      $null = $s.TryPlayAsync().GetAwaiter().GetResult()
    }
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

    // Use GSMTC (Windows 10 1809+) — state-aware, targets specific apps
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcPauseScript()],
      { stdio: "pipe", timeout: 5000 }
    );

    if (result.status === 0) {
      const output = (result.stdout?.toString() || "").trim();
      if (output === "GSMTC_FAIL") {
        debugLogger.debug("GSMTC unavailable on this system", {}, "media");
        return false;
      }
      this._pausedWinApps = output.split("|").filter(Boolean);
      if (this._pausedWinApps.length > 0) {
        debugLogger.debug("Media paused via GSMTC", { apps: this._pausedWinApps }, "media");
        return true;
      }
      debugLogger.debug("GSMTC found no playing sessions", {}, "media");
      return false;
    }

    debugLogger.debug("GSMTC PowerShell failed to execute", { status: result.status }, "media");
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
      return false;
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
