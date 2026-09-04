const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const EventEmitter = require("events");
const debugLogger = require("./debugLogger");
const { resolveBundledBinary } = require("./binaryResolver");
const { getOwnProcessPids } = require("./ownProcessPids");

const execAsync = promisify(exec);

const CHECK_INTERVAL_MS = process.platform === "win32" ? 15 * 1000 : 3 * 1000;
const SUSTAINED_THRESHOLD_CHECKS = 2;
const SUSTAINED_EVENT_DRIVEN_MS = 2 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const INACTIVE_RESET_MS = 60 * 1000;
// PipeWire/PulseAudio emit 'change' subscribe events several times a second on
// cork/volume churn, and every reconcile forks a pactl subprocess.
const LINUX_RECONCILE_MIN_SPACING_MS = 1000;
const EXEC_OPTS = { timeout: 5000, encoding: "utf8" };

class AudioActivityDetector extends EventEmitter {
  // `getExcludedProcessIds` lists every pid whose mic use is OpenWhispr's own:
  // the Electron process tree by default, plus any live capture helpers when
  // main.js composes them in (see electronProcessIds.js).
  constructor(getExcludedProcessIds = () => [...getOwnProcessPids()]) {
    super();
    this._getExcludedProcessIds = getExcludedProcessIds;
    this.checkInterval = null;
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this.lastDismissedAt = null;
    this._userRecording = false;
    this._checking = false;
    this._listenerProcess = null;
    this._activeMicPids = new Set();
    this._activeSources = 0;
    this._sustainedTimer = null;
    this._running = false;
    this._eventDriven = false;
    this._resetTimer = null;
    this._startGeneration = 0;
    this._micWarmHold = false;
    this._lastKnownMicState = false;
    this._cooldownReevalTimer = null;
    this._linuxOwnershipRequest = 0;
    this._linuxReconcileQueued = false;
    this._linuxReconcileRunning = false;
    this._linuxReconcileTimer = null;
    this._linuxLastReconcileAt = 0;
    this._pidScopedCapability = false;
    this._externalMicReliable = false;
    this._externalMicActive = false;
    this._lastEmittedExternalMicReliable = false;
    this._lastEmittedExternalMicActive = false;
    this._externalCapturePids = new Set();
    this._promptedCapturePids = new Set();
    this._captureIdleSincePrompt = false;
  }

  _markPrompted() {
    this.hasPrompted = true;
    this._promptedCapturePids = new Set(this._externalCapturePids);
    this._captureIdleSincePrompt = false;
  }

  // A later call re-arms the prompt, but only after the capture that was
  // prompted for has actually gone quiet. A pid set that merely differs is not
  // evidence the call ended: an app rebuilds its input unit when screen share
  // starts, and a capture helper can die and respawn under a new pid inside a
  // single reconcile window, so the swap is observed with no idle gap at all.
  // Prompting again there would drop a card over a live call, which is exactly
  // what hasPrompted exists to prevent.
  _rearmPromptForSourceChange(active) {
    if (!active) this._captureIdleSincePrompt = true;
    if (!this.hasPrompted || !this._pidScopedCapability || !this._externalCapturePids.size) return;
    if (!this._promptedCapturePids.size) {
      this._promptedCapturePids = new Set(this._externalCapturePids);
      return;
    }
    if (!this._captureIdleSincePrompt) return;

    const previousSourceGone = [...this._promptedCapturePids].every(
      (pid) => !this._externalCapturePids.has(pid)
    );
    if (!previousSourceGone) return;

    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    debugLogger.info("Re-armed meeting prompt for a changed capture source", {}, "meeting");
  }

  getExternalMicState() {
    this._updateExternalMicState(false);
    return {
      reliable: this._externalMicReliable,
      externalMicActive: this._externalMicActive,
    };
  }

  setUserRecording(active) {
    this._userRecording = active;
    if (active) {
      this.consecutiveChecks = 0;
      this.audioActiveStart = null;
      this._clearSustainedTimer();
    } else {
      this._reevaluateAfterGate();
    }
    debugLogger.debug("User recording state changed", { active }, "meeting");
  }

  // Our own idle-hold keeps the device "in use" after a dictation ends, and the
  // macOS/Linux mic signals are device-global — they cannot tell us apart from
  // a meeting app. Mic evidence during the hold is dropped outright (never
  // queued: it is not a meeting). Sustained state resets on both transitions so
  // a half-armed detection from before the hold cannot fire after it.
  setMicWarmHold(active) {
    this._micWarmHold = active;
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this._clearSustainedTimer();
    if (!active) {
      this._reevaluateAfterGate();
    }
    debugLogger.debug("Mic warm-hold state changed", { active }, "meeting");
  }

  async start() {
    if (this._running) return;
    this._running = true;
    const generation = ++this._startGeneration;

    const started = await this._tryEventDriven(generation);
    if (this._isStale(generation)) return;

    if (started) {
      this._eventDriven = true;
      debugLogger.info(
        "Audio activity detector started (event-driven)",
        { platform: process.platform },
        "meeting"
      );
    } else {
      this._eventDriven = false;
      this._startPolling();
      debugLogger.info(
        "Audio activity detector started (polling)",
        { intervalMs: CHECK_INTERVAL_MS, threshold: SUSTAINED_THRESHOLD_CHECKS },
        "meeting"
      );
    }
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    this._killListenerProcess();
    this._clearSustainedTimer();
    this._clearResetTimer();
    this._resetListenerState();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this._reset();
    this._eventDriven = false;
    debugLogger.info("Audio activity detector stopped", {}, "meeting");
  }

  dismiss() {
    this.lastDismissedAt = Date.now();
    this._reset();
    this._clearSustainedTimer();
    this._clearResetTimer();
    // Polling parity: polling re-detects a still-running call once the cooldown
    // lapses, but the edge-triggered listeners will never re-announce it.
    if (this._eventDriven && this._lastKnownMicState) {
      this._scheduleCooldownReeval(COOLDOWN_MS);
    }
    debugLogger.info(
      "Audio detection dismissed, cooldown started",
      { cooldownMs: COOLDOWN_MS },
      "meeting"
    );
  }

  resetPrompt() {
    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    this._clearSustainedTimer();
    this.audioActiveStart = null;
    debugLogger.info("Audio detection prompt reset (no cooldown)", {}, "meeting");
  }

  _reset() {
    this.consecutiveChecks = 0;
    this.audioActiveStart = null;
    this.hasPrompted = false;
    this._promptedCapturePids.clear();
    this._captureIdleSincePrompt = false;
    this._clearResetTimer();
  }

  // The pid set, source count, and ownership snapshot mirror what the OS told
  // us is open, not our own detection state — only losing the listener
  // invalidates them. Clearing them on dismissal would desync the reference
  // count, so an unrelated app's mic session ending would report the
  // still-running call as gone.
  _resetListenerState() {
    this._activeMicPids.clear();
    this._activeSources = 0;
    this._lastKnownMicState = false;
    this._externalCapturePids.clear();
    this._clearCooldownReevalTimer();
    this._linuxOwnershipRequest++;
    this._linuxReconcileQueued = false;
    this._clearLinuxReconcileTimer();
    this._pidScopedCapability = false;
    this._externalMicReliable = false;
    this._externalMicActive = false;
    this._lastEmittedExternalMicReliable = false;
    this._lastEmittedExternalMicActive = false;
  }

  _clearSustainedTimer() {
    if (this._sustainedTimer) {
      clearTimeout(this._sustainedTimer);
      this._sustainedTimer = null;
    }
  }

  _startResetTimer() {
    this._clearResetTimer();
    this._resetTimer = setTimeout(() => {
      this._resetTimer = null;
      this.hasPrompted = false;
      this._promptedCapturePids.clear();
      debugLogger.debug("hasPrompted reset after sustained inactivity", {}, "meeting");
    }, INACTIVE_RESET_MS);
  }

  _clearResetTimer() {
    if (this._resetTimer) {
      clearTimeout(this._resetTimer);
      this._resetTimer = null;
    }
  }

  _killListenerProcess() {
    if (this._listenerProcess) {
      try {
        this._listenerProcess.kill();
      } catch {
        // already exited
      }
      this._listenerProcess = null;
    }
  }

  // True once stop() or a newer start() has superseded the run that owns `generation`.
  _isStale(generation) {
    return !this._running || generation !== this._startGeneration;
  }

  // ---------------------------------------------------------------------------
  // Event-driven approach
  // ---------------------------------------------------------------------------

  async _tryEventDriven(generation) {
    switch (process.platform) {
      case "darwin":
        return this._tryEventDrivenDarwin(generation);
      case "win32":
        return this._tryEventDrivenWin32(generation);
      case "linux":
        return this._tryEventDrivenLinux(generation);
      default:
        return false;
    }
  }

  // Spawns a listener and resolves only once the OS has confirmed it started, so a
  // failure to launch (missing binary, not executable) is reported as false instead
  // of being raced by the asynchronous "error" event.
  _spawnListener({ command, args = [], options, label, generation, onLine }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, options);
      } catch (err) {
        debugLogger.warn(`Failed to spawn ${label}`, { error: err.message }, "meeting");
        resolve(false);
        return;
      }

      const onSpawn = () => {
        child.removeListener("error", onError);
        if (this._isStale(generation)) {
          child.kill();
          resolve(false);
          return;
        }

        this._listenerProcess = child;
        this._readLines(child.stdout, onLine);
        child.stderr.on("data", (data) => {
          debugLogger.debug(`${label} stderr`, { output: data.toString().trim() }, "meeting");
        });
        this._attachFallbackHandlers(child, label);
        resolve(true);
      };

      const onError = (err) => {
        child.removeListener("spawn", onSpawn);
        debugLogger.warn(`Failed to spawn ${label}`, { error: err.message }, "meeting");
        resolve(false);
      };

      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  _readLines(stream, onLine) {
    let buffer = "";
    stream.on("data", (data) => {
      buffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        onLine(line);
      }
    });
  }

  _attachFallbackHandlers(child, label) {
    const fallbackToPolling = () => {
      if (this._listenerProcess !== child) return;
      this._listenerProcess = null;
      // Announce the reliability loss before the snapshot is reset, or the
      // emit de-dupe would swallow it.
      this._setPidScopedCapability(false);
      this._resetListenerState();
      if (this._running && this._eventDriven) {
        this._eventDriven = false;
        this._startPolling();
      }
    };

    child.on("error", (err) => {
      debugLogger.warn(`${label} error`, { error: err.message }, "meeting");
      fallbackToPolling();
    });

    child.on("exit", (code) => {
      debugLogger.warn(`${label} exited`, { code }, "meeting");
      fallbackToPolling();
    });
  }

  _tryEventDrivenDarwin(generation) {
    const binaryPath = resolveBundledBinary("macos-mic-listener", "meeting");
    if (!binaryPath) {
      debugLogger.warn("macos-mic-listener binary not found, will use polling", {}, "meeting");
      return false;
    }

    return this._spawnListener({
      command: binaryPath,
      options: { stdio: ["ignore", "pipe", "pipe"] },
      label: "macos-mic-listener",
      generation,
      onLine: (line) => this._parseDarwinListenerLine(line),
    });
  }

  _parseDarwinListenerLine(line) {
    if (!this._running) return;

    if (line === "CAPABILITY PID") {
      this._setPidScopedCapability(true);
      return;
    }
    if (line === "CAPABILITY AGGREGATE") {
      this._setPidScopedCapability(false);
      return;
    }
    if (line === "MIC_ACTIVE") {
      this._onMicStateChanged(true);
      return;
    }
    if (line === "MIC_INACTIVE") {
      this._onMicStateChanged(false);
      return;
    }

    this._parsePidScopedListenerLine(line);
  }

  _tryEventDrivenWin32(generation) {
    const binaryPath = resolveBundledBinary("windows-mic-listener.exe", "meeting");
    if (!binaryPath) {
      debugLogger.warn("windows-mic-listener.exe not found, will use polling", {}, "meeting");
      return false;
    }

    return this._spawnListener({
      command: binaryPath,
      args: [],
      // stdin must be "pipe" — the Windows binary monitors stdin for parent death
      options: { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      label: "windows-mic-listener",
      generation,
      onLine: (line) => this._parseWin32ListenerLine(line),
    });
  }

  _parseWin32ListenerLine(line) {
    if (!this._running) return;
    // Only rebuilt binaries announce CAPABILITY PID. Pre-refcounting builds
    // print READY and MIC_START/MIC_STOP too, but their un-refcounted stop
    // events must never be treated as reliable evidence for auto-end.
    if (line === "CAPABILITY PID") {
      this._setPidScopedCapability(true);
      return;
    }
    // The helper downgrades itself mid-run on an unrecoverable coverage gap
    // and keeps emitting best-effort transitions for meeting detection.
    if (line === "CAPABILITY AGGREGATE") {
      this._setPidScopedCapability(false);
      return;
    }

    this._parsePidScopedListenerLine(line);
  }

  // Our own captures never enter the pid set: dictation opens the mic from
  // Chromium's audio service and the system-audio helpers are child processes,
  // so the OS reports both under pids that are not the main one (#1392). Kept
  // out at ingest so they can neither arm the prompt nor, on their stop, read
  // as "every mic closed" while another app still holds one.
  _isExcludedProcessId(pid) {
    try {
      return this._getExcludedProcessIdSet().has(pid);
    } catch {
      // A failing provider is reported as unreliable by _updateExternalMicState.
      return false;
    }
  }

  _parsePidScopedListenerLine(line) {
    const startMatch = line.match(/^MIC_START\s+(\d+)$/);
    if (startMatch) {
      const pid = parseInt(startMatch[1], 10);
      if (this._isExcludedProcessId(pid)) return;
      this._activeMicPids.add(pid);
      const externalMicActive = this._updateExternalMicState();
      this._onMicStateChanged(externalMicActive);
      return;
    }

    const stopMatch = line.match(/^MIC_STOP\s+(\d+)$/);
    if (stopMatch) {
      const pid = parseInt(stopMatch[1], 10);
      if (this._isExcludedProcessId(pid)) return;
      this._activeMicPids.delete(pid);
      const externalMicActive = this._updateExternalMicState();
      this._onMicStateChanged(externalMicActive);
      return;
    }
  }

  async _tryEventDrivenLinux(generation) {
    const started = await this._spawnListener({
      command: "pactl",
      args: ["subscribe"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      label: "pactl subscribe",
      generation,
      onLine: (line) => this._parsePactlSubscribeLine(line),
    });
    if (!started || this._isStale(generation)) return false;

    await this._reconcileLinuxSourceOutputs(generation);
    return !this._isStale(generation) && this._listenerProcess !== null;
  }

  _parsePactlSubscribeLine(line) {
    if (!this._running || !line.includes("source-output")) return;

    if (/Event\s+'new'\s+on\s+source-output/i.test(line)) {
      this._activeSources++;
    } else if (/Event\s+'remove'\s+on\s+source-output/i.test(line)) {
      this._activeSources = Math.max(0, this._activeSources - 1);
    }

    this._queueLinuxReconcile();
  }

  // Bursts of subscribe events coalesce into at most one running and one queued
  // reconcile instead of spawning a `pactl list` subprocess per line, and
  // successive reconciles stay LINUX_RECONCILE_MIN_SPACING_MS apart: the first
  // event after quiet reconciles immediately, and a trailing reconcile always
  // follows the last event of a burst so no state change is dropped.
  _queueLinuxReconcile() {
    if (this._linuxReconcileQueued) return;
    this._linuxReconcileQueued = true;
    if (this._linuxReconcileRunning || this._linuxReconcileTimer) return;
    this._scheduleQueuedLinuxReconcile();
  }

  _scheduleQueuedLinuxReconcile() {
    const waitMs = this._linuxLastReconcileAt + LINUX_RECONCILE_MIN_SPACING_MS - Date.now();
    if (waitMs <= 0) {
      this._runQueuedLinuxReconcile();
      return;
    }
    this._linuxReconcileTimer = setTimeout(() => {
      this._linuxReconcileTimer = null;
      this._runQueuedLinuxReconcile();
    }, waitMs);
  }

  _runQueuedLinuxReconcile() {
    this._linuxReconcileRunning = true;
    void (async () => {
      try {
        this._linuxReconcileQueued = false;
        if (this._running && this._listenerProcess) {
          await this._reconcileLinuxSourceOutputs(this._startGeneration);
        }
      } finally {
        this._linuxReconcileRunning = false;
        if (this._linuxReconcileQueued && this._running && this._listenerProcess) {
          this._scheduleQueuedLinuxReconcile();
        } else {
          this._linuxReconcileQueued = false;
        }
      }
    })();
  }

  _clearLinuxReconcileTimer() {
    if (this._linuxReconcileTimer) {
      clearTimeout(this._linuxReconcileTimer);
      this._linuxReconcileTimer = null;
    }
  }

  async _reconcileLinuxSourceOutputs(generation) {
    const request = ++this._linuxOwnershipRequest;
    this._linuxLastReconcileAt = Date.now();

    try {
      const { stdout } = await execAsync("pactl --format=json list source-outputs", EXEC_OPTS);
      if (this._isStale(generation) || request !== this._linuxOwnershipRequest) return;

      const sourceOutputs = JSON.parse(stdout);
      if (!Array.isArray(sourceOutputs)) throw new Error("pactl returned a non-array response");

      const activeMicPids = new Set();
      for (const sourceOutput of sourceOutputs) {
        // Audio-server plumbing (module-echo-cancel, loopbacks) legitimately
        // lacks application.process.id — client streams always carry it. Skip
        // such streams instead of surrendering PID reliability, or systems
        // with these modules loaded could never arm auto-end.
        const processId = Number(sourceOutput?.properties?.["application.process.id"]);
        if (!Number.isInteger(processId) || processId <= 0) continue;
        activeMicPids.add(processId);
      }

      this._activeMicPids = activeMicPids;
      // Raw total, matching the subscribe-event counter: it is the only signal
      // left if a later reconcile cannot parse pactl's JSON.
      this._activeSources = sourceOutputs.length;
      this._setPidScopedCapability(true);
      // A live listener makes the snapshot reliable unless the excluded-pid
      // provider itself failed. It is external and can, so keep the raw total as
      // the fallback signal rather than reporting a silent mic.
      this._onMicStateChanged(
        this._externalMicReliable ? this._externalMicActive : this._activeSources > 0
      );
    } catch (err) {
      if (this._isStale(generation) || request !== this._linuxOwnershipRequest) return;
      this._setPidScopedCapability(false);
      this._onMicStateChanged(this._activeSources > 0);
      debugLogger.warn(
        "Failed to reconcile pactl source-output ownership",
        { error: err.message },
        "meeting"
      );
    }
  }

  _getExcludedProcessIdSet() {
    const processIds = this._getExcludedProcessIds();
    return new Set(
      [...processIds]
        .map((processId) => Number(processId))
        .filter((processId) => Number.isInteger(processId) && processId > 0)
    );
  }

  _setPidScopedCapability(reliable) {
    this._pidScopedCapability = reliable;
    this._updateExternalMicState();
  }

  // Auto-end may only trust the ownership snapshot while a listener is pushing
  // every transition into it. The poller cannot carry that guarantee: it samples
  // at CHECK_INTERVAL_MS and stops outright while gated by a recording, a warm
  // hold or a dismissal cooldown — so a snapshot taken before a meeting began
  // would still read as "another app holds the mic" for the whole recording,
  // and the controller's ownership mode would never release it.
  _isOwnershipSnapshotLive() {
    return this._listenerProcess !== null;
  }

  _updateExternalMicState(emitChange = true) {
    let excludedProcessIds;
    try {
      excludedProcessIds = this._getExcludedProcessIdSet();
    } catch (err) {
      this._externalCapturePids.clear();
      this._setExternalMicSnapshot(false, false, emitChange);
      debugLogger.warn(
        "Failed to resolve excluded microphone PIDs",
        { error: err.message },
        "meeting"
      );
      return false;
    }

    const externalPids = [...this._activeMicPids].filter(
      (processId) => !excludedProcessIds.has(processId)
    );
    this._externalCapturePids = new Set(externalPids);
    const externalMicActive = externalPids.length > 0;
    if (!this._pidScopedCapability || !this._isOwnershipSnapshotLive()) {
      this._setExternalMicSnapshot(false, false, emitChange);
      return externalMicActive;
    }

    this._setExternalMicSnapshot(true, externalMicActive, emitChange);
    return externalMicActive;
  }

  _setExternalMicSnapshot(reliable, externalMicActive, emitChange) {
    this._externalMicReliable = reliable;
    this._externalMicActive = reliable ? externalMicActive : false;
    if (
      emitChange &&
      (this._externalMicReliable !== this._lastEmittedExternalMicReliable ||
        this._externalMicActive !== this._lastEmittedExternalMicActive) &&
      this._running
    ) {
      this._lastEmittedExternalMicReliable = this._externalMicReliable;
      this._lastEmittedExternalMicActive = this._externalMicActive;
      this.emit("external-mic-state-changed", this.getExternalMicState());
    }
  }

  // ---------------------------------------------------------------------------
  // Shared event-driven handler
  // ---------------------------------------------------------------------------

  // The listeners are edge-triggered: they announce transitions, never steady
  // state. A gate may swallow the only edge a call will ever produce, so the
  // state is recorded unconditionally and re-evaluated when gates lift.
  _onMicStateChanged(active) {
    if (!this._running) return;
    this._lastKnownMicState = active;
    this._rearmPromptForSourceChange(active);
    this._evaluateMicState(active);
  }

  _reevaluateAfterGate() {
    if (this._running && this._eventDriven && this._lastKnownMicState) {
      this._evaluateMicState(true);
    }
  }

  _cooldownRemainingMs() {
    if (!this.lastDismissedAt) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - this.lastDismissedAt));
  }

  _scheduleCooldownReeval(delayMs) {
    this._clearCooldownReevalTimer();
    this._cooldownReevalTimer = setTimeout(() => {
      this._cooldownReevalTimer = null;
      this._reevaluateAfterGate();
    }, delayMs);
  }

  _clearCooldownReevalTimer() {
    if (this._cooldownReevalTimer) {
      clearTimeout(this._cooldownReevalTimer);
      this._cooldownReevalTimer = null;
    }
  }

  _evaluateMicState(active) {
    if (this._userRecording) {
      debugLogger.debug("Mic state changed but user recording, ignoring", { active }, "meeting");
      return;
    }
    if (this._micWarmHold) {
      debugLogger.debug("Mic state changed during warm-hold, ignoring", { active }, "meeting");
      return;
    }
    const cooldownRemainingMs = this._cooldownRemainingMs();
    if (cooldownRemainingMs > 0) {
      debugLogger.debug(
        "Mic state changed but in cooldown",
        { active, remainingMs: cooldownRemainingMs },
        "meeting"
      );
      if (active) {
        this._scheduleCooldownReeval(cooldownRemainingMs);
      } else {
        this._clearCooldownReevalTimer();
      }
      return;
    }

    debugLogger.debug(
      "Mic state changed (event-driven)",
      { active, hasPrompted: this.hasPrompted },
      "meeting"
    );

    if (active) {
      this._clearResetTimer();
      if (this.hasPrompted) {
        debugLogger.debug("Mic active but already prompted, suppressing", {}, "meeting");
        return;
      }
      if (!this.audioActiveStart) this.audioActiveStart = Date.now();

      if (!this._sustainedTimer) {
        this._sustainedTimer = setTimeout(() => {
          this._sustainedTimer = null;
          if (this._userRecording || this._micWarmHold || this.hasPrompted) return;
          if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;

          this._markPrompted();
          const now = Date.now();
          const durationMs = now - this.audioActiveStart;
          debugLogger.info(
            "Sustained audio activity detected (event-driven)",
            { durationMs },
            "meeting"
          );
          this.emit("sustained-audio-detected", { durationMs, detectedAt: now });
        }, SUSTAINED_EVENT_DRIVEN_MS);
      }
    } else {
      this._clearSustainedTimer();
      this.audioActiveStart = null;
      if (this.hasPrompted) this._startResetTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  _startPolling() {
    this._check();
    this.checkInterval = setInterval(() => this._check(), CHECK_INTERVAL_MS);
  }

  async _check() {
    if (this._checking) return;
    if (this.lastDismissedAt && Date.now() - this.lastDismissedAt < COOLDOWN_MS) return;
    if (this._userRecording) return;
    if (this._micWarmHold) return;

    this._checking = true;
    try {
      const active = await this._isMicActive();
      this._rearmPromptForSourceChange(active);
      debugLogger.debug(
        "Mic check",
        { active, consecutiveChecks: this.consecutiveChecks },
        "meeting"
      );

      if (active) {
        this._clearResetTimer();
        this.consecutiveChecks++;
        if (!this.audioActiveStart) this.audioActiveStart = Date.now();

        if (!this.hasPrompted && this.consecutiveChecks >= SUSTAINED_THRESHOLD_CHECKS) {
          this._markPrompted();
          const now = Date.now();
          const durationMs = now - this.audioActiveStart;
          debugLogger.info(
            "Sustained audio activity detected",
            { consecutiveChecks: this.consecutiveChecks, durationMs },
            "meeting"
          );
          this.emit("sustained-audio-detected", { durationMs, detectedAt: now });
        }
      } else {
        if (this.consecutiveChecks > 0) {
          debugLogger.debug(
            "Mic activity reset",
            { previousChecks: this.consecutiveChecks },
            "meeting"
          );
        }
        this.consecutiveChecks = 0;
        this.audioActiveStart = null;
        if (this.hasPrompted) this._startResetTimer();
      }
    } finally {
      this._checking = false;
    }
  }

  async _isMicActive() {
    switch (process.platform) {
      case "darwin":
        return this._checkDarwin();
      case "win32":
        return this._checkWin32();
      case "linux":
        return this._checkLinux();
      default:
        return false;
    }
  }

  async _checkDarwin() {
    try {
      const { stdout } = await execAsync(
        "ioreg -l -w 0 | grep '\"IOAudioEngineState\" = 1'",
        EXEC_OPTS
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async _checkWin32() {
    try {
      const processListCache = require("./processListCache");
      const names = await processListCache.getProcessList();
      return (
        names.includes("cpthost.exe") ||
        names.includes("ms-teams_modulehost.exe") ||
        names.includes("webexmeetingsapp.exe")
      );
    } catch {
      return false;
    }
  }

  async _checkLinux() {
    try {
      const { stdout } = await execAsync("pactl --format=json list source-outputs", EXEC_OPTS);
      const sourceOutputs = JSON.parse(stdout);
      if (!Array.isArray(sourceOutputs)) throw new Error("pactl returned a non-array response");

      const capturePids = sourceOutputs
        .map((sourceOutput) => Number(sourceOutput?.properties?.["application.process.id"]))
        .filter((processId) => Number.isInteger(processId) && processId > 0);
      // A stream without application.process.id carries no ownership
      // information. When nothing in a non-empty listing is attributable, the
      // unfiltered listings below still answer "is anything capturing" — far
      // better than reporting silence and never detecting a meeting.
      if (sourceOutputs.length > 0 && capturePids.length === 0) {
        throw new Error("no source-output reported an application.process.id");
      }

      const excludedProcessIds = this._getExcludedProcessIdSet();
      this._activeMicPids = new Set(capturePids);
      this._setPidScopedCapability(true);
      return capturePids.some((processId) => !excludedProcessIds.has(processId));
    } catch (err) {
      this._setPidScopedCapability(false);
      debugLogger.debug(
        "Linux mic check fell back to an unfiltered listing",
        { error: err.message },
        "meeting"
      );
    }

    try {
      const { stdout } = await execAsync("pactl list source-outputs short", EXEC_OPTS);
      return stdout.trim().length > 0;
    } catch {
      // pactl unavailable, try PipeWire
    }

    try {
      const { stdout } = await execAsync(
        "pw-cli list-objects | grep -c 'Stream/Input/Audio'",
        EXEC_OPTS
      );
      return parseInt(stdout.trim(), 10) > 0;
    } catch {
      return false;
    }
  }
}

module.exports = AudioActivityDetector;
