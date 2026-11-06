const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");

// spawnSync capped a child's output at 1 MB and killed anything past it. Keep
// that bound: these helpers emit a few KB, and an unbounded buffer would let a
// runaway one grow main-process memory until its deadline.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MPRIS_REQUEST_TIMEOUT_MS = 2000;
const MPRIS_BUS_DESTINATION = "org.freedesktop.DBus";
const MPRIS_BUS_PATH = "/org/freedesktop/DBus";
const MPRIS_BUS_INTERFACE = "org.freedesktop.DBus";
const MPRIS_PLAYER_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const MPRIS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const MPRIS_NAME_PREFIX = "org.mpris.MediaPlayer2.";

// Runs `cmd args` asynchronously and resolves with
// { status, stdout, stderr, timedOut }. Times out after `timeout` ms; on
// timeout it kills the child and resolves with the exit code the child already
// reported, or status: null and timedOut: true when it never exited. A spawn
// failure also resolves with status: null but timedOut: false. Output is
// capped at MAX_OUTPUT_BYTES. Never rejects — callers branch on status === 0.
//
// Every media helper goes through here rather than spawnSync: a synchronous
// spawn parks the Electron main thread in a nested libuv loop until the
// child's stdio pipes close, which froze hotkeys, IPC and the dictation
// window mid-recording (#2073).
function spawnAsync(cmd, args, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: String(err?.message || err), timedOut: false });
      return;
    }

    const chunks = { stdout: [], stderr: [] };
    let bufferedBytes = 0;
    const collect = (stream, chunk) => {
      if (bufferedBytes >= MAX_OUTPUT_BYTES) return;
      bufferedBytes += chunk.length;
      chunks[stream].push(chunk);
    };
    let settled = false;
    const settle = (status, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      // A helper can finish its work and exit while a descendant it spawned
      // keeps the inherited pipes open, so the deadline can arrive with the
      // outcome already known. Honour that exit code: discarding it sends the
      // Windows pause into the media-key fallback, which toggles playback back
      // on mid-dictation and then leaves it paused afterwards (#2073).
      const exitCode = child.exitCode;
      try {
        // A no-op once the child has exited; dropping our own pipe ends is
        // what lets the deadline resolve while a descendant lingers.
        killProcess(child, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        debugLogger.warn(
          "Media helper timed out",
          { cmd: path.basename(cmd), timeout, exitCode },
          "media"
        );
      } catch {
        // Teardown and logging are best effort; the deadline must still settle
        // below, or the serialized queue stalls for the rest of the session.
      }
      settle(exitCode, exitCode === null);
    }, timeout);

    child.stdout.on("data", (d) => collect("stdout", d));
    child.stderr.on("data", (d) => collect("stderr", d));
    child.on("error", (err) => {
      // Pushed past the cap on purpose: this is the only diagnostic a failed
      // spawn produces, and it must not be the thing the cap drops.
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
    this._mediaSessions = new Map(); // recording ID -> active/restore state and acknowledged owners
    this._mprisBus = null;
    this._mprisGeneration = 0;
    this._mprisPending = new Map();
    this._mprisRecycleGeneration = null;
    this._mprisOperationGeneration = null;
    this._closed = false;
    this._didPause = false; // Whether we sent a pause via toggle fallback
    this._pausedWinApps = []; // GSMTC app IDs we paused (Windows)
    this._adapterChecked = false;
    this._adapterPaths = null; // { perl, script, framework } once resolved
    this._pausedViaAdapter = false; // macOS: whether we paused via the adapter
    // Pause/resume/toggle run one at a time. macOS was already async and had
    // the race this prevents: a quick tap could run the resume before the
    // pause had recorded what it paused, stranding media until the next
    // dictation ended. Windows and Linux inherited the risk by becoming async
    // too (#2073).
    this._queue = Promise.resolve();
  }

  // The queue holds a caught copy so a failed operation can't stall the ones
  // behind it, while the caller still gets the raw run.
  _serialize(operation) {
    const run = this._queue.then(() => (this._closed ? false : operation()));
    this._queue = run.catch(() => {});
    return run;
  }

  _beginMediaSession(id) {
    if (
      this._closed ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      this._mediaSessions.has(id)
    ) {
      return null;
    }
    const session = { active: true, restore: true, pausedPlayers: [] };
    this._mediaSessions.set(id, session);
    return session;
  }

  _endMediaSession(id, restore) {
    const session = this._mediaSessions.get(id);
    if (!session?.active) return null;
    session.active = false;
    session.restore = restore === true;
    return session;
  }

  async _runLinuxOperation(operation) {
    if (this._closed) return false;
    // Serialization lets one operation own this pin; never reconnect midway after invalidation.
    this._mprisOperationGeneration = null;
    try {
      return await operation();
    } finally {
      this._recycleMprisConnection();
      this._mprisOperationGeneration = null;
    }
  }

  _isMprisOperationCurrent() {
    // No generation means native transport was never acquired, so explicit fallback stays valid.
    return (
      !this._closed &&
      (this._mprisOperationGeneration === null ||
        this._mprisBus?.generation === this._mprisOperationGeneration)
    );
  }

  _getMprisConnection() {
    if (this._closed) return null;
    if (this._mprisOperationGeneration !== null) {
      return this._mprisBus?.generation === this._mprisOperationGeneration ? this._mprisBus : null;
    }
    if (this._mprisBus) return this._mprisBus;

    let bus;
    try {
      bus = require("@homebridge/dbus-native").sessionBus();

      const generation = ++this._mprisGeneration;
      const state = { bus, generation };
      this._mprisBus = state;
      const disconnect = (event, err) => this._handleMprisDisconnect(generation, event, err);
      bus.connection.on("error", (err) => disconnect("error", err));
      bus.connection.on("end", () => disconnect("end"));
      bus.connection.stream?.on?.("close", () => disconnect("stream close"));
      try {
        debugLogger.debug("MPRIS D-Bus connection opened", { generation }, "media");
      } catch {}
      return state;
    } catch (err) {
      try {
        bus?.connection?.end?.();
      } catch {}
      debugLogger.debug(
        "MPRIS D-Bus connection unavailable",
        { error: String(err?.message || err).slice(0, 200) },
        "media"
      );
      return null;
    }
  }

  _invokeMpris(message) {
    if (this._closed) return Promise.reject(new Error("Media player is closed"));
    const state = this._getMprisConnection();
    if (!state) return Promise.reject(new Error("MPRIS D-Bus connection unavailable"));
    if (this._mprisOperationGeneration === null) {
      this._mprisOperationGeneration = state.generation;
    }

    const { bus, generation } = state;
    return new Promise((resolve, reject) => {
      const key = Symbol(message.member);
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._mprisPending.delete(key);
        callback(value);
      };
      const rejectRequest = (err) => settle(reject, this._normalizeMprisError(err, generation));
      const timer = setTimeout(() => {
        // dbus-native cannot cancel calls; recycle only after every sibling chain settles.
        const err = new Error(
          `MPRIS ${message.member} timed out for ${message.destination || MPRIS_BUS_DESTINATION}`
        );
        err.timedOut = true;
        this._mprisRecycleGeneration = generation;
        rejectRequest(err);
      }, MPRIS_REQUEST_TIMEOUT_MS);

      this._mprisPending.set(key, { generation, reject: rejectRequest });
      try {
        bus.invoke(message, (err, value) => {
          if (settled) return;
          if (this._mprisBus !== state) {
            rejectRequest(new Error("Stale MPRIS D-Bus callback"));
            return;
          }
          if (err) {
            rejectRequest(err);
            return;
          }
          settle(resolve, value);
        });
      } catch (err) {
        rejectRequest(err);
      }
    });
  }

  _normalizeMprisError(err, generation) {
    const normalized = err instanceof Error ? err : new Error(err?.message || String(err));
    if (!(err instanceof Error) && err?.name) normalized.dbusName = err.name;
    normalized.generation = generation;
    return normalized;
  }

  _mprisErrorMeta(err, extra = {}) {
    const errorName = err?.dbusName || (err?.name !== "Error" ? err?.name : undefined);
    return {
      ...extra,
      errorName: errorName ? String(errorName).slice(0, 200) : undefined,
      error: String(err?.message || err).slice(0, 200),
      timedOut: err?.timedOut === true,
      generation: err?.generation ?? extra.generation,
    };
  }

  _handleMprisDisconnect(generation, event, err) {
    if (!this._invalidateMprisConnection(generation, err || new Error(event))) return;
    try {
      debugLogger.warn(
        "MPRIS D-Bus connection lost",
        this._mprisErrorMeta(err || new Error(event), { event, generation }),
        "media"
      );
    } catch {}
  }

  _invalidateMprisConnection(generation, reason) {
    const state = this._mprisBus;
    if (!state || state.generation !== generation) return false;

    this._mprisBus = null;
    // Unique names can be reused after a bus restart, so acknowledged targets expire here too.
    for (const session of this._mediaSessions.values()) session.pausedPlayers = [];
    if (this._mprisRecycleGeneration === generation) this._mprisRecycleGeneration = null;
    for (const pending of this._mprisPending.values()) {
      if (pending.generation === generation) pending.reject(reason);
    }
    try {
      state.bus.connection.end();
    } catch {}
    return true;
  }

  _recycleMprisConnection() {
    const generation = this._mprisRecycleGeneration;
    if (generation === null) return;
    // Restore on the original connection; actual disconnects still discard unsafe owners.
    if ([...this._mediaSessions.values()].some((session) => session.pausedPlayers.length)) return;
    this._mprisRecycleGeneration = null;
    if (this._mprisBus?.generation !== generation) return;
    this._invalidateMprisConnection(generation, new Error("MPRIS connection recycled"));
    try {
      debugLogger.debug("Recycled timed-out MPRIS D-Bus connection", { generation }, "media");
    } catch {}
  }

  close() {
    this._closed = true;
    this._mediaSessions.clear();
    const state = this._mprisBus;
    if (state) {
      this._invalidateMprisConnection(
        state.generation,
        new Error("MPRIS connection closed during application shutdown")
      );
    }
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

  pauseMedia(sessionId) {
    const session = process.platform === "linux" ? this._beginMediaSession(sessionId) : null;
    if (process.platform === "linux" && !session) return Promise.resolve(false);

    return this._serialize(async () => {
      try {
        if (process.platform === "linux") {
          return await this._runLinuxOperation(() => this._pauseMpris(session));
        } else if (process.platform === "darwin") {
          return await this._pauseMacOS();
        } else if (process.platform === "win32") {
          return await this._pauseWindows();
        }
      } catch (err) {
        debugLogger.warn("Media pause failed", { error: err.message }, "media");
      }
      return false;
    });
  }

  resumeMedia(sessionId, restore = true) {
    if (process.platform === "linux") {
      if (!this._endMediaSession(sessionId, restore)) return Promise.resolve(false);
    } else if (!restore) {
      return Promise.resolve(false);
    }

    return this._serialize(async () => {
      try {
        if (process.platform === "linux") {
          return await this._runLinuxOperation(() => this._resumeLinux());
        } else if (process.platform === "darwin") {
          return await this._resumeMacOS();
        } else if (process.platform === "win32") {
          return await this._resumeWindows();
        }
      } catch (err) {
        debugLogger.warn("Media resume failed", { error: err.message }, "media");
      }
      return false;
    });
  }

  toggleMedia() {
    return this._serialize(async () => {
      try {
        if (process.platform === "linux") {
          return await this._runLinuxOperation(() => this._toggleLinux());
        } else if (process.platform === "darwin") {
          return await this._toggleMacOS();
        } else if (process.platform === "win32") {
          return await this._toggleWindows();
        }
      } catch (err) {
        debugLogger.warn("Media toggle failed", { error: err.message }, "media");
      }
      return false;
    });
  }

  // --- Linux: MPRIS-aware pause/resume ---

  async _resumeLinux() {
    // A stale end from recording A must not resume media while recording B is active.
    if ([...this._mediaSessions.values()].some((session) => session.active)) return false;

    const players = new Set();
    for (const [id, session] of this._mediaSessions) {
      if (!session.restore || session.pausedPlayers.length === 0) {
        this._mediaSessions.delete(id);
        continue;
      }
      for (const owner of session.pausedPlayers) players.add(owner);
    }
    if (players.size === 0) return false;
    const resumed = await this._resumeMpris([...players]);
    for (const [id, session] of this._mediaSessions) {
      if (!session.active && session.pausedPlayers.length === 0) this._mediaSessions.delete(id);
    }
    return resumed;
  }

  async _pauseMpris(session) {
    if (!session.active) return false;
    const players = await this._listMprisPlayers();
    if (!session.active || players.length === 0) return false;
    const seenOwners = new Set();

    await Promise.allSettled(
      players.map(async (player) => {
        const owner = await this._getMprisOwner(player);
        if (!session.active || !owner || seenOwners.has(owner)) return;
        seenOwners.add(owner);

        const status = await this._getMprisPlaybackStatus(player, owner);
        if (!session.active || !this._isMprisOperationCurrent() || status !== "Playing") return;

        debugLogger.debug("MPRIS Pause dispatched", { player, owner }, "media");
        try {
          await this._invokeMpris({
            destination: owner,
            path: MPRIS_PLAYER_PATH,
            interface: MPRIS_PLAYER_INTERFACE,
            member: "Pause",
          });
          if (!this._isMprisOperationCurrent()) return;
          // The end may arrive after dispatch; an acknowledged Pause still needs restoration.
          session.pausedPlayers.push(owner);
          debugLogger.debug("MPRIS Pause acknowledged", { player, owner }, "media");
        } catch (err) {
          debugLogger.debug(
            "MPRIS Pause not acknowledged",
            this._mprisErrorMeta(err, { player, owner }),
            "media"
          );
        }
      })
    );
    return session.pausedPlayers.length > 0;
  }

  async _resumeMpris(players) {
    const results = await Promise.all(
      players.map(async (owner) => {
        if (
          !this._isMprisOperationCurrent() ||
          [...this._mediaSessions.values()].some((session) => session.active)
        ) {
          return false;
        }
        // Once dispatched, the remote action cannot be canceled or safely retried.
        for (const session of this._mediaSessions.values()) {
          if (!session.active && session.restore) {
            session.pausedPlayers = session.pausedPlayers.filter(
              (candidate) => candidate !== owner
            );
          }
        }
        debugLogger.debug("MPRIS Play dispatched", { owner }, "media");
        try {
          await this._invokeMpris({
            destination: owner,
            path: MPRIS_PLAYER_PATH,
            interface: MPRIS_PLAYER_INTERFACE,
            member: "Play",
          });
          if (!this._isMprisOperationCurrent()) return false;
          debugLogger.debug("MPRIS Play acknowledged", { owner }, "media");
          return true;
        } catch (err) {
          debugLogger.debug(
            "MPRIS Play not acknowledged",
            this._mprisErrorMeta(err, { owner }),
            "media"
          );
          return false;
        }
      })
    );
    return results.some(Boolean);
  }

  async _listMprisPlayers() {
    try {
      const names = await this._invokeMpris({
        destination: MPRIS_BUS_DESTINATION,
        path: MPRIS_BUS_PATH,
        interface: MPRIS_BUS_INTERFACE,
        member: "ListNames",
      });
      return Array.isArray(names)
        ? names.filter((name) => typeof name === "string" && name.startsWith(MPRIS_NAME_PREFIX))
        : [];
    } catch (err) {
      debugLogger.debug("MPRIS ListNames failed", this._mprisErrorMeta(err), "media");
      return [];
    }
  }

  async _getMprisOwner(player) {
    try {
      const owner = await this._invokeMpris({
        destination: MPRIS_BUS_DESTINATION,
        path: MPRIS_BUS_PATH,
        interface: MPRIS_BUS_INTERFACE,
        member: "GetNameOwner",
        signature: "s",
        body: [player],
      });
      return typeof owner === "string" && owner.startsWith(":") ? owner : null;
    } catch (err) {
      debugLogger.debug(
        "MPRIS GetNameOwner failed",
        this._mprisErrorMeta(err, { player }),
        "media"
      );
      return null;
    }
  }

  async _getMprisPlaybackStatus(player, owner) {
    try {
      const variant = await this._invokeMpris({
        destination: owner,
        path: MPRIS_PLAYER_PATH,
        interface: MPRIS_PROPERTIES_INTERFACE,
        member: "Get",
        signature: "ss",
        body: [MPRIS_PLAYER_INTERFACE, "PlaybackStatus"],
      });
      const signature = variant?.[0];
      const status =
        Array.isArray(signature) &&
        signature.length === 1 &&
        signature[0]?.type === "s" &&
        Array.isArray(variant?.[1])
          ? variant[1][0]
          : null;
      return status === "Playing" || status === "Paused" || status === "Stopped" ? status : null;
    } catch (err) {
      debugLogger.debug(
        "MPRIS PlaybackStatus failed",
        this._mprisErrorMeta(err, { player, owner }),
        "media"
      );
      return null;
    }
  }

  // --- Linux toggle (legacy, used by toggleMedia) ---

  async _toggleLinux() {
    if (await this._toggleMpris()) return true;
    if (!this._isMprisOperationCurrent()) return false;

    const binary = this._resolveLinuxFastPaste();
    if (binary) {
      const result = await spawnAsync(binary, ["--media-play-pause"], { timeout: 3000 });
      if (result.status === 0) {
        debugLogger.debug("Media toggled via linux-fast-paste", {}, "media");
        return true;
      }
    }
    if (!this._isMprisOperationCurrent()) return false;

    const result = await spawnAsync("playerctl", ["play-pause"], { timeout: 3000 });
    if (result.status === 0) {
      debugLogger.debug("Media toggled via playerctl", {}, "media");
      return true;
    }

    debugLogger.warn("No media control method available on Linux", {}, "media");
    return false;
  }

  async _toggleMpris() {
    const players = await this._listMprisPlayers();
    if (players.length === 0) return false;
    const seenOwners = new Set();
    const results = await Promise.allSettled(
      players.map(async (player) => {
        const owner = await this._getMprisOwner(player);
        if (!this._isMprisOperationCurrent() || !owner || seenOwners.has(owner)) return false;
        seenOwners.add(owner);
        try {
          await this._invokeMpris({
            destination: owner,
            path: MPRIS_PLAYER_PATH,
            interface: MPRIS_PLAYER_INTERFACE,
            member: "PlayPause",
          });
          if (!this._isMprisOperationCurrent()) return false;
          debugLogger.debug("Media toggled via MPRIS", { player, owner }, "media");
          return true;
        } catch (err) {
          debugLogger.debug(
            "MPRIS PlayPause not acknowledged",
            this._mprisErrorMeta(err, { player, owner }),
            "media"
          );
          return false;
        }
      })
    );
    return results.some((result) => result.status === "fulfilled" && result.value);
  }

  // --- macOS: MediaRemote-aware pause/resume ---

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

  async _sendWindowsMediaKey() {
    const nircmd = this._resolveNircmd();
    if (nircmd) {
      const result = await spawnAsync(nircmd, ["sendkeypress", "0xB3"], { timeout: 3000 });
      if (result.status === 0) return true;
    }

    const result = await spawnAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class KB { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [KB]::keybd_event(0xB3, 0, 1, 0); [KB]::keybd_event(0xB3, 0, 3, 0)",
      ],
      { timeout: 5000 }
    );
    return result.status === 0;
  }

  async _pauseWindows() {
    this._pausedWinApps = [];
    this._didPause = false;

    // GSMTC (Windows 10 1809+) — state-aware, targets specific apps
    const result = await spawnAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcPauseScript()],
      { timeout: 5000 }
    );

    if (result.status === 0) {
      const output = result.stdout.trim();
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

    const stderr = result.stderr.trim();
    debugLogger.debug(
      "GSMTC PowerShell failed, falling back to media key",
      {
        status: result.status,
        timedOut: result.timedOut,
        stderr: stderr ? stderr.slice(0, 200) : undefined,
      },
      "media"
    );
    return this._pauseWindowsFallback();
  }

  async _pauseWindowsFallback() {
    if (await this._sendWindowsMediaKey()) {
      this._didPause = true;
      debugLogger.debug("Media paused via media key fallback", {}, "media");
      return true;
    }
    return false;
  }

  async _resumeWindows() {
    // Resume via GSMTC if we paused that way
    if (this._pausedWinApps && this._pausedWinApps.length > 0) {
      const apps = this._pausedWinApps;
      this._pausedWinApps = [];

      const result = await spawnAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", this._gsmtcResumeScript(apps)],
        { timeout: 5000 }
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
      if (await this._sendWindowsMediaKey()) {
        debugLogger.debug("Media resumed via media key fallback", {}, "media");
        return true;
      }
    }

    return false;
  }

  async _toggleWindows() {
    if (await this._sendWindowsMediaKey()) {
      debugLogger.debug("Media toggled via Windows media key", {}, "media");
      return true;
    }
    return false;
  }
}

module.exports = new MediaPlayer();
