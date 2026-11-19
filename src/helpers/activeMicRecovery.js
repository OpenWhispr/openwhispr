import { CHROMIUM_ALIAS_DEVICE_IDS } from "./microphoneSelection";

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTE_GRACE_MS = 800;
const DEFAULT_RETRY_MS = 2000;

const deviceKey = (device) =>
  [device?.deviceId || "", device?.groupId || "", device?.label || ""].join("\u0000");

const describeTrack = (track) => ({
  readyState: track?.readyState ?? "none",
  muted: Boolean(track?.muted),
});

const stopStream = (stream) => stream?.getTracks?.().forEach((track) => track.stop());

export const describeAudioInputs = (devices = []) => {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return {
    defaultInput: inputs[0],
    defaultKey: inputs.length > 0 ? deviceKey(inputs[0]) : "",
    keys: new Set(inputs.map(deviceKey)),
    deviceIds: new Set(inputs.map((device) => device.deviceId).filter(Boolean)),
    groupIds: new Set(inputs.map((device) => device.groupId).filter(Boolean)),
  };
};

const trackMatchesDefault = (track, device) => {
  if (!device) return null;
  const settings = track.getSettings();
  // Chromium's default device ID is an alias. Only compare physical IDs
  // directly; fall back to the group when either endpoint exposes the alias.
  const isPhysicalId = (id) => id && !CHROMIUM_ALIAS_DEVICE_IDS.has(id);
  if (isPhysicalId(settings.deviceId) && isPhysicalId(device.deviceId)) {
    return settings.deviceId === device.deviceId;
  }
  if (settings.groupId && device.groupId) return settings.groupId === device.groupId;
  return null;
};

export const activeTrackIsAvailable = (track, inputs) => {
  if (!track || track.readyState === "ended") return false;
  const settings = track.getSettings?.() || {};
  if (settings.deviceId && inputs.deviceIds.has(settings.deviceId)) return true;
  if (settings.groupId && inputs.groupIds.has(settings.groupId)) return true;
  // Device labels are not a stable identity, but a live track with no exposed IDs
  // is healthier than guessing that a permission-redacted enumeration removed it.
  return !settings.deviceId && !settings.groupId;
};

export class ActiveMicRecoveryController {
  constructor({
    mediaDevices,
    acquire,
    onRecovered,
    onStatusChange,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    muteGraceMs = DEFAULT_MUTE_GRACE_MS,
    retryMs = DEFAULT_RETRY_MS,
    logger,
    logScope,
  }) {
    this.mediaDevices = mediaDevices;
    this.acquire = acquire;
    this.onRecovered = onRecovered;
    this.onStatusChange = onStatusChange;
    this.debounceMs = debounceMs;
    this.muteGraceMs = muteGraceMs;
    this.retryMs = retryMs;
    this.logger = logger;
    this.logScope = logScope;
    this.status = "inactive";
    this.stream = null;
    this.track = null;
    this.followDefault = true;
    this.inputs = describeAudioInputs();
    this.inputRead = 0;
    this.appliedInputRead = 0;
    this.deviceChangeCount = 0;
    this.generation = 0;
    this.recoveryPromise = null;
    this.debounceTimer = null;
    this.muteTimer = null;
    this.restoreOnUnmute = null;
    this.retryTimer = null;
    this.started = false;
    // Consecutive failed attempts, so a mic that stays gone logs one warning
    // per outage rather than one every retry.
    this.failedAttempts = 0;
    this.recoveryStartedAt = null;
    this.onDeviceChange = () => this.scheduleEvaluation();
    this.onTrackEnded = () => this.recover("ended");
    this.onTrackMute = () => {
      clearTimeout(this.muteTimer);
      this.log("debug", "Microphone track muted", { graceMs: this.muteGraceMs });
      const timer = setTimeout(async () => {
        // A mute on the replacement gets its own deadline even while the swap
        // is settling. Unmute, detach or a newer mute cancels this callback.
        if (this.recoveryPromise) await this.recoveryPromise;
        if (this.muteTimer !== timer) return;
        this.muteTimer = null;
        if (this.track?.muted) this.recover("muted");
      }, this.muteGraceMs);
      this.muteTimer = timer;
    };
    this.onTrackUnmute = () => {
      if (this.muteTimer !== null) this.log("debug", "Microphone track unmuted");
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
      if (this.track?.readyState === "live" && !this.track.muted) this.restoreOnUnmute?.();
    };
  }

  log(level, message, meta) {
    this.logger?.[level](message, meta, this.logScope);
  }

  isCurrent(generation) {
    return this.started && generation === this.generation;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }

  async start(stream, { followDefault = true } = {}) {
    this.stop();
    this.started = true;
    this.generation += 1;
    const generation = this.generation;
    this.followDefault = followDefault;
    this.inputs = describeAudioInputs();
    this.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.stream = stream;
    this.watchTrack(stream?.getAudioTracks?.()[0]);
    await this.refreshInputs(generation);
    if (!this.isCurrent(generation) || this.status !== "inactive") return;
    // The track may have died (or come up muted) before our listeners attached;
    // those events won't replay, so evaluate the track's state directly.
    const alive = this.track && this.track.readyState !== "ended";
    this.setStatus(alive ? "active" : "unavailable");
    if (!alive) {
      this.log("info", "Recording started without a live microphone track", {
        track: describeTrack(this.track),
      });
      this.recover("start");
    } else if (this.track.muted) {
      this.onTrackMute();
    }
  }

  watchTrack(track) {
    this.detachTrack();
    this.track = track || null;
    this.track?.addEventListener?.("ended", this.onTrackEnded);
    this.track?.addEventListener?.("mute", this.onTrackMute);
    this.track?.addEventListener?.("unmute", this.onTrackUnmute);
  }

  detachTrack() {
    this.track?.removeEventListener?.("ended", this.onTrackEnded);
    this.track?.removeEventListener?.("mute", this.onTrackMute);
    this.track?.removeEventListener?.("unmute", this.onTrackUnmute);
    this.track = null;
    this.restoreOnUnmute = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = null;
  }

  // A slow enumeration must not overwrite a newer devicechange or recording.
  async refreshInputs(generation) {
    const read = ++this.inputRead;
    try {
      const inputs = describeAudioInputs(await this.mediaDevices.enumerateDevices());
      if (generation !== this.generation || read < this.appliedInputRead) return null;
      this.inputs = inputs;
      this.appliedInputRead = read;
      return inputs;
    } catch (error) {
      this.log("debug", "Microphone enumeration failed", { error: error?.message });
      return null;
    }
  }

  scheduleEvaluation() {
    if (!this.started) return;
    this.deviceChangeCount += 1;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.evaluateDeviceChange(), this.debounceMs);
  }

  async evaluateDeviceChange() {
    if (!this.started) return;
    const generation = this.generation;
    const previous = this.inputs;
    const current = await this.refreshInputs(generation);
    if (!this.isCurrent(generation)) return;
    if (!current) {
      if (this.track?.readyState === "ended") this.recover("devicechange-ended");
      return;
    }

    const defaultChanged = this.followDefault && previous.defaultKey !== current.defaultKey;
    const activeMissing = !activeTrackIsAvailable(this.track, current);
    if (
      defaultChanged ||
      activeMissing ||
      (this.status === "unavailable" && !this.restoreOnUnmute)
    ) {
      this.log("debug", "Microphone device change needs recovery", {
        defaultChanged,
        activeMissing,
        status: this.status,
      });
      this.recover("devicechange");
    }
  }

  recover(reason, recoveringMute = reason === "muted") {
    if (!this.started) return Promise.resolve(false);
    if (this.recoveryPromise) {
      // The attempt in flight rechecks its replacement before it settles, so a
      // replacement that dies meanwhile is not lost by folding this call into it.
      this.log("debug", "Microphone recovery already in progress", { reason });
      return this.recoveryPromise;
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = this.generation;
    this.restoreOnUnmute = null;
    const oldStream = this.stream;
    const defaultAtAcquire = this.inputs.defaultKey;
    const changesAtAcquire = this.deviceChangeCount;
    const selectionMayHaveChanged = () =>
      this.followDefault &&
      (defaultAtAcquire !== this.inputs.defaultKey || changesAtAcquire !== this.deviceChangeCount);
    let followNewDefault = false;
    this.log(this.recoveryStartedAt === null ? "info" : "debug", "Microphone recovery started", {
      reason,
      status: this.status,
      track: describeTrack(this.track),
      attempt: this.failedAttempts + 1,
    });
    this.recoveryStartedAt ??= Date.now();
    this.setStatus("reconnecting");

    const attempt = async () => {
      let replacement = null;
      let track;
      try {
        replacement = await this.acquire(reason);
        track = replacement?.getAudioTracks?.()[0];
        if (!track) throw new Error("No audio track returned");
        if (!this.isCurrent(generation)) {
          stopStream(replacement);
          this.log("debug", "Discarded a microphone opened for a recording that ended", {
            reason,
          });
          return false;
        }
        // Recorder rotation can outlast the mute grace. Watch the candidate
        // immediately, but keep ownership of the old stream until the swap succeeds.
        this.watchTrack(track);
        if (track.muted && !recoveringMute) this.onTrackMute();
        await this.onRecovered(replacement, oldStream, reason);
        if (!this.isCurrent(generation)) {
          stopStream(replacement);
          this.log("debug", "Discarded a microphone opened for a recording that ended", {
            reason,
          });
          return false;
        }
        this.stream = replacement;
        await this.refreshInputs(generation);
        // stop() already reset the status; a stale attempt must not set it again.
        if (!this.isCurrent(generation)) return false;
        // An `ended` event, or the replacement recorder stopping on a dead track,
        // can arrive at any await above. Those calls were folded into this
        // attempt (#2743), so the replacement is checked here before it counts.
        if (track.readyState === "ended") {
          throw new Error("Replacement microphone ended before recovery finished");
        }
        // Enumeration can consume the only devicechange for a second default
        // switch, so re-resolve the selection after releasing this attempt.
        // Without exposed IDs, only a changed default justifies another open.
        if (selectionMayHaveChanged()) {
          const matches = trackMatchesDefault(track, this.inputs.defaultInput);
          followNewDefault =
            matches === false || (matches === null && defaultAtAcquire !== this.inputs.defaultKey);
          if (followNewDefault) return false;
        }

        const restored = () => {
          this.restoreOnUnmute = null;
          this.log("info", "Microphone recovered", {
            reason,
            durationMs: Date.now() - this.recoveryStartedAt,
            label: track.label || "",
            failedAttempts: this.failedAttempts,
          });
          this.failedAttempts = 0;
          this.recoveryStartedAt = null;
          this.setStatus("active");
        };
        if (track.muted) {
          this.restoreOnUnmute = restored;
          this.setStatus("unavailable");
          return false;
        }
        restored();
        return true;
      } catch (error) {
        if (replacement && replacement !== this.stream) {
          if (this.track === track) {
            this.watchTrack(oldStream?.getAudioTracks?.()[0]);
          }
          stopStream(replacement);
        }
        if (this.isCurrent(generation)) {
          this.failedAttempts += 1;
          this.log(this.failedAttempts === 1 ? "warn" : "debug", "Microphone recovery failed", {
            reason,
            error: error?.message,
            attempt: this.failedAttempts,
            retryInMs: this.retryMs,
          });
          this.setStatus("unavailable");
          const retryReason =
            reason === "devicechange" || selectionMayHaveChanged() ? "devicechange" : "retry";
          this.scheduleRetry(retryReason, recoveringMute);
        }
        return false;
      }
    };
    // Only clear our own handle: a stale attempt settling after stop()+start()
    // must not clobber a newer in-flight recovery's dedup handle.
    const promise = attempt().finally(() => {
      if (this.recoveryPromise !== promise) return;
      this.recoveryPromise = null;
      if (followNewDefault) this.recover("devicechange");
    });
    this.recoveryPromise = promise;
    return promise;
  }

  scheduleRetry(reason, recoveringMute) {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.recover(reason, recoveringMute);
    }, this.retryMs);
  }

  stop() {
    if (this.started && (this.status === "reconnecting" || this.status === "unavailable")) {
      this.log("info", "Recording ended while its microphone was unavailable", {
        status: this.status,
        failedAttempts: this.failedAttempts,
      });
    }
    this.started = false;
    this.generation += 1;
    this.failedAttempts = 0;
    this.recoveryStartedAt = null;
    this.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.detachTrack();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.debounceTimer = null;
    this.retryTimer = null;
    this.recoveryPromise = null;
    this.stream = null;
    this.setStatus("inactive");
  }
}
