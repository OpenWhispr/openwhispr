const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

// Runs `cmd args` asynchronously and resolves with { status, stdout, stderr }.
// Times out after `timeout` ms; on timeout, kills the child and resolves with
// status: null. Never rejects — callers branch on status === 0.
function spawnAsync(cmd, args, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: String(err?.message || err) });
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignored
      }
      settle(null);
    }, timeout);

    child.stdout.on("data", (d) => chunks.stdout.push(d));
    child.stderr.on("data", (d) => chunks.stderr.push(d));
    child.on("error", (err) => {
      chunks.stderr.push(Buffer.from(String(err?.message || err)));
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

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
    this._adapterChecked = false;
    this._adapterPaths = null; // { perl, script, framework } once resolved
    this._pausedViaAdapter = false; // macOS: whether we paused via the adapter
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

  // Resolves the vendored mediaremote-adapter Perl entry point and framework.
  // MediaRemote.framework was closed to unprivileged Mach-O processes on
  // macOS 15.4+; the only working state-aware path is to load our adapter
  // framework via /usr/bin/perl, which is system-entitled to talk to it.
  _resolveMediaRemoteAdapter() {
    if (this._adapterChecked) return this._adapterPaths;
    this._adapterChecked = true;

    const perl = "/usr/bin/perl";
    if (!fs.existsSync(perl)) return null;

    const scriptCandidates = [];
    const frameworkCandidates = [];

    if (process.resourcesPath) {
      scriptCandidates.push(path.join(process.resourcesPath, "bin", "mediaremote-adapter.pl"));
      frameworkCandidates.push(
        path.join(process.resourcesPath, "bin", "MediaRemoteAdapter.framework")
      );
    }

    scriptCandidates.push(
      path.join(
        __dirname,
        "..",
        "..",
        "resources",
        "mediaremote-adapter",
        "bin",
        "mediaremote-adapter.pl"
      )
    );
    frameworkCandidates.push(
      path.join(__dirname, "..", "..", "resources", "bin", "MediaRemoteAdapter.framework")
    );

    const script = scriptCandidates.find((p) => fs.existsSync(p));
    const framework = frameworkCandidates.find((p) => fs.existsSync(p));
    if (!script || !framework) return null;

    this._adapterPaths = { perl, script, framework };
    return this._adapterPaths;
  }

  async pauseMedia() {
    try {
      if (process.platform === "linux") {
        return this._pauseLinux();
      } else if (process.platform === "darwin") {
        return await this._pauseMacOS();
      } else if (process.platform === "win32") {
        return this._pauseWindows();
      }
    } catch (err) {
      debugLogger.warn("Media pause failed", { error: err.message }, "media");
    }
    return false;
  }

  async resumeMedia() {
    try {
      if (process.platform === "linux") {
        return this._resumeLinux();
      } else if (process.platform === "darwin") {
        return await this._resumeMacOS();
      } else if (process.platform === "win32") {
        return this._resumeWindows();
      }
    } catch (err) {
      debugLogger.warn("Media resume failed", { error: err.message }, "media");
    }
    return false;
  }

  async toggleMedia() {
    try {
      if (process.platform === "linux") {
        return this._toggleLinux();
      } else if (process.platform === "darwin") {
        return await this._toggleMacOS();
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

  // --- macOS: MediaRemote-aware pause/resume (async) ---

  async _runAdapter(args, timeout = 3000) {
    const paths = this._resolveMediaRemoteAdapter();
    if (!paths) return null;
    return spawnAsync(paths.perl, [paths.script, paths.framework, ...args], {
      timeout,
    });
  }

  async _pauseMacOS() {
    this._didPause = false;
    this._pausedViaAdapter = false;

    // Primary path: vendored mediaremote-adapter via /usr/bin/perl. Works on
    // macOS 15.4+ where the framework is closed to user processes.
    const probe = await this._runAdapter(["get", "--no-artwork"]);
    if (probe && probe.status === 0) {
      const output = (probe.stdout || "").trim();
      let playing = null;
      if (output && output !== "null") {
        try {
          playing = !!JSON.parse(output).playing;
        } catch {
          playing = null;
        }
      } else if (output === "null") {
        playing = false;
      }

      if (playing === false) {
        debugLogger.debug("Adapter reports no media playing", {}, "media");
        return false;
      }

      if (playing === true) {
        // 1 = kMRAPause
        const pause = await this._runAdapter(["send", "1"]);
        if (pause && pause.status === 0) {
          debugLogger.debug("Media paused via adapter", {}, "media");
          this._pausedViaAdapter = true;
          this._didPause = true;
          return true;
        }
        debugLogger.debug(
          "Adapter send pause failed",
          {
            status: pause?.status,
            stderr: (pause?.stderr || "").trim().slice(0, 200),
          },
          "media"
        );
      }
    } else if (probe) {
      debugLogger.debug(
        "Adapter get failed, falling back to media key",
        {
          status: probe.status,
          stderr: (probe.stderr || "").trim().slice(0, 200),
        },
        "media"
      );
    }

    // Fallback: post a real media-key CGEvent. We don't know whether anything
    // is playing, so this can spuriously start playback — same toggle risk
    // the binary-based path had pre-adapter.
    if (await this._sendMacMediaKey()) {
      this._didPause = true;
      return true;
    }
    return false;
  }

  async _resumeMacOS() {
    if (!this._didPause) return false;
    const usedAdapter = this._pausedViaAdapter;
    this._didPause = false;
    this._pausedViaAdapter = false;

    if (usedAdapter) {
      // 0 = kMRAPlay
      const play = await this._runAdapter(["send", "0"]);
      if (play && play.status === 0) {
        debugLogger.debug("Media resumed via adapter", {}, "media");
        return true;
      }
      debugLogger.debug(
        "Adapter send play failed, falling back to media key",
        {
          status: play?.status,
          stderr: (play?.stderr || "").trim().slice(0, 200),
        },
        "media"
      );
    }

    return this._sendMacMediaKey();
  }

  // Posts a real NX_KEYTYPE_PLAY system-defined NSEvent via the bundled
  // helper. Media apps only respond to that event class — synthetic F-key
  // codes (osascript "key code") are not media keys and land in the focused
  // app as plain keystrokes instead.
  async _sendMacMediaKey() {
    const binary = this._resolveMacMediaRemote();
    if (!binary) return false;

    const result = await spawnAsync(binary, ["--media-key-toggle"], {
      timeout: 3000,
    });
    if (result.status === 0) {
      debugLogger.debug("Media key sent via CGEvent helper", {}, "media");
      return true;
    }
    debugLogger.debug(
      "CGEvent media-key helper failed",
      {
        status: result.status,
        stderr: (result.stderr || "").trim().slice(0, 200),
      },
      "media"
    );
    return false;
  }

  async _toggleMacOS() {
    return this._sendMacMediaKey();
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
        windowsHide: true,
      });
      if (result.status === 0) return true;
    }

    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class KB { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [KB]::keybd_event(0xB3, 0, 1, 0); [KB]::keybd_event(0xB3, 0, 3, 0)",
      ],
      {
        stdio: "pipe",
        timeout: 5000,
        windowsHide: true,
      }
    );
    return result.status === 0;
  }

  _pauseWindows() {
    this._pausedWinApps = [];
    this._didPause = false;

    // Use GSMTC (Windows 10 1809+) — state-aware, targets specific apps
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcPauseScript()],
      { stdio: "pipe", timeout: 5000, windowsHide: true }
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
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcResumeScript(apps)],
        { stdio: "pipe", timeout: 5000, windowsHide: true }
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
