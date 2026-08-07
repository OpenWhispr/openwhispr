const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

// Runs `cmd args` asynchronously and resolves with { status, stdout, stderr }.
// Times out after `timeout` ms; on timeout, kills the child and resolves with
// status: null. Never rejects — callers branch on status === 0.
// `onStdout` sees each chunk as it arrives, for callers that must react to output
// before the child exits.
function spawnAsync(cmd, args, { timeout = 3000, onStdout } = {}) {
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

    child.stdout.on("data", (d) => {
      chunks.stdout.push(d);
      if (onStdout) {
        try {
          onStdout(d.toString("utf8"));
        } catch {
          // A misbehaving listener must not take down the spawn.
        }
      }
    });
    child.stderr.on("data", (d) => chunks.stderr.push(d));
    child.on("error", (err) => {
      chunks.stderr.push(Buffer.from(String(err?.message || err)));
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

// Duck level is an absolute target, not a relative cut: 25 means end up at 25%.
const DUCK_DEFAULT_LEVEL = 25;
// Add-Type compiles C# on first use, which can exceed the 3s default.
const DUCK_READ_TIMEOUT_MS = 6000;
const VOLUME_SET_TIMEOUT_MS = 2500;
// Add-Type can emit warnings on stdout, so reads echo behind a sentinel.
const DUCK_STDOUT_SENTINEL = "__OWDUCK__:";
// PulseAudio lets a sink sit above 100%, and that level has to survive the round
// trip or restoring silently strips the user's amplification.
const SNAPSHOT_MAX_LEVEL = 200;

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
    this._duckActive = false; // Whether we lowered system output volume for this dictation
    this._duckOriginalVolume = null; // System volume % captured before ducking
    this._volumeOpQueue = Promise.resolve(); // Serializes duck/restore against quick start/stop
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

  // --- System output volume ducking ---

  // Serializes volume ops: a Windows duck takes a few hundred ms, so a quick tap
  // could otherwise let the restore run before the duck lands and latches.
  _enqueueVolumeOp(operation) {
    const run = this._volumeOpQueue.then(operation, operation);
    this._volumeOpQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async duckSystem(targetPercent) {
    const target = this._clampVolume(targetPercent, DUCK_DEFAULT_LEVEL);
    return this._enqueueVolumeOp(async () => {
      try {
        if (this._duckActive) return true;

        // Latch on the snapshot rather than on completion: quitting during the
        // platform call would otherwise find no restore point and exit quiet.
        let earlySnapshot = null;
        const original = await this._applyDuck(target, (snapshot) => {
          earlySnapshot = snapshot;
          this._duckOriginalVolume = snapshot;
          this._duckActive = true;
        });

        if (original === null) {
          if (earlySnapshot === null) {
            debugLogger.warn("Audio ducking skipped: could not read system volume", {}, "media");
            return false;
          }
          // We read the level but the change never confirmed. Keep the restore
          // point — writing back an unchanged level is a harmless no-op, whereas
          // dropping it would strand the user if the change did land.
          debugLogger.warn(
            "Audio ducking did not confirm; keeping restore point",
            { originalVolume: earlySnapshot },
            "media"
          );
          return false;
        }

        // Nothing was changed, so drop the restore point rather than spend a
        // subprocess on stop putting back a level that never moved.
        if (original <= target) {
          this._duckActive = false;
          this._duckOriginalVolume = null;
          debugLogger.debug(
            "Audio ducking skipped: volume already at or below target",
            { originalVolume: original, targetVolume: target },
            "media"
          );
          return true;
        }

        this._duckOriginalVolume = original;
        this._duckActive = true;
        debugLogger.debug(
          "Audio ducked for dictation",
          { originalVolume: original, targetVolume: target },
          "media"
        );
        return true;
      } catch (err) {
        debugLogger.warn("Audio ducking failed", { error: err.message }, "media");
        return false;
      }
    });
  }

  async restoreSystemVolume() {
    return this._enqueueVolumeOp(async () => {
      if (!this._duckActive) return false;

      const originalVolume = this._duckOriginalVolume;
      this._duckActive = false;
      this._duckOriginalVolume = null;

      try {
        const restored = await this._applySystemVolume(originalVolume);
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
    });
  }

  // Best-effort restore for the quit path only: an async spawn started during
  // teardown gets orphaned before it runs, so this one place stays sync.
  restoreSystemVolumeSync() {
    if (!this._duckActive) return false;

    const originalVolume = this._duckOriginalVolume;
    this._duckActive = false;
    this._duckOriginalVolume = null;
    if (originalVolume === null) return false;

    try {
      for (const { cmd, args } of this._volumeSetCommands(originalVolume)) {
        // The PowerShell fallback compiles C#, so it needs more than the 1s a
        // nircmd or pactl call does. Only reached when the fast path is missing.
        const timeout = cmd === "powershell" ? 6000 : 1000;
        const result = spawnSync(cmd, args, { stdio: "pipe", timeout, windowsHide: true });
        if (result.status === 0) return true;
      }
      return false;
    } catch (err) {
      debugLogger.warn("Audio ducking restore on quit failed", { error: err.message }, "media");
      return false;
    }
  }

  // For duck targets, which are always a percentage of normal output.
  _clampVolume(value, fallback = DUCK_DEFAULT_LEVEL) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  }

  // For captured levels, which may legitimately exceed 100% on Linux.
  _clampSnapshot(value, fallback = DUCK_DEFAULT_LEVEL) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(SNAPSHOT_MAX_LEVEL, Math.round(parsed)));
  }

  _compactProcessOutput(output) {
    return (output || "").toString().trim().replace(/\s+/g, " ").slice(0, 600) || undefined;
  }

  // Captured level from a platform command's stdout, or null if none is usable.
  _parseVolumePercent(stdout, kind) {
    const text = (stdout || "").toString();

    if (kind === "win32" || kind === "darwin") {
      const match = text.match(new RegExp(`${DUCK_STDOUT_SENTINEL}(-?\\d+(?:\\.\\d+)?)`));
      return match ? this._clampSnapshot(match[1]) : null;
    }

    if (kind === "pactl") {
      const match = text.match(/(\d+)%/);
      return match ? this._clampSnapshot(match[1]) : null;
    }

    if (kind === "wpctl") {
      const match = text.match(/Volume:\s*([0-9.]+)/);
      return match ? this._clampSnapshot(Number(match[1]) * 100) : null;
    }

    return null;
  }

  // Reads and lowers to `target`. Resolves the pre-duck volume, or null if it
  // couldn't be read. `onSnapshot` fires the moment the level is known, before
  // anything is changed, so a quit landing mid-duck still has a value to restore.
  async _applyDuck(target, onSnapshot) {
    const report = (value) => {
      if (typeof onSnapshot === "function" && value !== null) onSnapshot(value);
    };
    if (process.platform === "win32") return this._duckWindows(target, report);
    if (process.platform === "darwin") return this._duckMacOS(target, report);
    if (process.platform === "linux") return this._duckLinux(target, report);
    return null;
  }

  async _applySystemVolume(percent) {
    if (percent === null || percent === undefined) return false;
    const safePercent = this._clampSnapshot(percent);
    if (process.platform === "win32") return this._setWindowsVolume(safePercent);
    if (process.platform === "darwin") return this._setMacVolume(safePercent);
    if (process.platform === "linux") return this._setLinuxVolume(safePercent);
    return false;
  }

  // --- Windows volume (Core Audio endpoint master scalar) ---

  // nircmd can set the master volume but cannot read it, which is why the duck
  // path needs PowerShell. Restores hold a snapshot already, so they skip it.
  _windowsVolumeScript() {
    return `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

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
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject {}

public class OwAudioEndpoint {
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
"@`;
  }

  _runWindowsVolumePowerShell(command, timeout, onStdout) {
    return spawnAsync(
      "powershell",
      ["-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout, onStdout }
    );
  }

  // One process: Add-Type compiles the C# per launch, so a separate read and
  // write would double that cost.
  async _duckWindows(target, report) {
    // The level is written and flushed before SetVolume runs, so the caller
    // learns it while the process is still alive rather than only at exit.
    const command = [
      this._windowsVolumeScript(),
      `$current = [OwAudioEndpoint]::GetVolume()`,
      `[Console]::Out.Write('${DUCK_STDOUT_SENTINEL}' + [int][math]::Round($current))`,
      `[Console]::Out.Flush()`,
      `if ($current -gt ${target}) { [OwAudioEndpoint]::SetVolume(${target}) }`,
    ].join("\n");

    let streamed = "";
    let reported = false;
    const result = await this._runWindowsVolumePowerShell(
      command,
      DUCK_READ_TIMEOUT_MS,
      (chunk) => {
        if (reported) return;
        streamed += chunk;
        const early = this._parseVolumePercent(streamed, "win32");
        if (early !== null) {
          reported = true;
          report(early);
        }
      }
    );
    if (result.status !== 0) {
      debugLogger.warn(
        "Windows volume duck failed",
        {
          status: result.status,
          stdout: this._compactProcessOutput(result.stdout),
          stderr: this._compactProcessOutput(result.stderr),
        },
        "media"
      );
      return null;
    }

    return this._parseVolumePercent(result.stdout, "win32");
  }

  async _setWindowsVolume(percent) {
    const nircmd = this._resolveNircmd();
    if (nircmd) {
      const result = await spawnAsync(
        nircmd,
        ["setsysvolume", String(Math.round((percent / 100) * 65535))],
        { timeout: VOLUME_SET_TIMEOUT_MS }
      );
      if (result.status === 0) return true;
      debugLogger.debug("nircmd volume set failed, falling back to PowerShell", {}, "media");
    }

    const command = `${this._windowsVolumeScript()}\n[OwAudioEndpoint]::SetVolume(${percent})`;
    const result = await this._runWindowsVolumePowerShell(command, DUCK_READ_TIMEOUT_MS);
    if (result.status !== 0) {
      debugLogger.warn(
        "Windows volume set failed",
        {
          percent,
          status: result.status,
          stderr: this._compactProcessOutput(result.stderr),
        },
        "media"
      );
      return false;
    }
    return true;
  }

  // --- macOS volume ---

  async _duckMacOS(target, report) {
    // Read and set are separate calls here: osascript starts fast enough that
    // splitting them costs little, and it means the level is recorded before
    // anything changes.
    const result = await spawnAsync(
      "osascript",
      ["-e", `return "${DUCK_STDOUT_SENTINEL}" & (output volume of (get volume settings))`],
      { timeout: 3000 }
    );

    if (result.status !== 0) {
      debugLogger.warn(
        "macOS volume duck failed",
        { status: result.status, stderr: this._compactProcessOutput(result.stderr) },
        "media"
      );
      return null;
    }

    // `output volume` yields "missing value" on some external and aggregate
    // devices; the sentinel parse returns null there and we decline to duck.
    const current = this._parseVolumePercent(result.stdout, "darwin");
    if (current === null) return null;
    report(current);
    if (current <= target) return current;

    const applied = await this._setMacVolume(target);
    return applied ? current : null;
  }

  async _setMacVolume(percent) {
    const result = await spawnAsync("osascript", ["-e", `set volume output volume ${percent}`], {
      timeout: 3000,
    });
    return result.status === 0;
  }

  // --- Linux volume ---

  async _duckLinux(target, report) {
    const current = await this._getLinuxVolume();
    if (current === null) return null;
    report(current);
    if (current <= target) return current;
    const applied = await this._setLinuxVolume(target);
    return applied ? current : null;
  }

  async _getLinuxVolume() {
    const pactl = await spawnAsync("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], {
      timeout: 3000,
    });
    if (pactl.status === 0) {
      const parsed = this._parseVolumePercent(pactl.stdout, "pactl");
      if (parsed !== null) return parsed;
    }

    const wpctl = await spawnAsync("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], {
      timeout: 3000,
    });
    if (wpctl.status === 0) {
      const parsed = this._parseVolumePercent(wpctl.stdout, "wpctl");
      if (parsed !== null) return parsed;
    }

    return null;
  }

  async _setLinuxVolume(percent) {
    const pactl = await spawnAsync("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${percent}%`], {
      timeout: VOLUME_SET_TIMEOUT_MS,
    });
    if (pactl.status === 0) return true;

    const wpctl = await spawnAsync(
      "wpctl",
      ["set-volume", "@DEFAULT_AUDIO_SINK@", `${percent / 100}`],
      { timeout: VOLUME_SET_TIMEOUT_MS }
    );
    return wpctl.status === 0;
  }

  // Ordered candidates for the quit-path restore. Mirrors the fallbacks the async
  // setters use — without them a machine with no nircmd, or PipeWire with no pulse
  // compatibility, would exit leaving the volume down.
  _volumeSetCommands(percent) {
    const safePercent = this._clampSnapshot(percent);
    if (process.platform === "win32") {
      const commands = [];
      const nircmd = this._resolveNircmd();
      if (nircmd) {
        commands.push({
          cmd: nircmd,
          args: ["setsysvolume", String(Math.round((safePercent / 100) * 65535))],
        });
      }
      commands.push({
        cmd: "powershell",
        args: [
          "-Sta",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `${this._windowsVolumeScript()}\n[OwAudioEndpoint]::SetVolume(${safePercent})`,
        ],
      });
      return commands;
    }
    if (process.platform === "darwin") {
      return [{ cmd: "osascript", args: ["-e", `set volume output volume ${safePercent}`] }];
    }
    if (process.platform === "linux") {
      return [
        { cmd: "pactl", args: ["set-sink-volume", "@DEFAULT_SINK@", `${safePercent}%`] },
        { cmd: "wpctl", args: ["set-volume", "@DEFAULT_AUDIO_SINK@", `${safePercent / 100}`] },
      ];
    }
    return [];
  }
}

module.exports = new MediaPlayer();
