const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_MUTE_GRACE_MS = 800;
const DEFAULT_RETRY_MS = 2000;

const deviceKey = (device) =>
  [device?.deviceId || "", device?.groupId || "", device?.label || ""].join("\u0000");

export const describeAudioInputs = (devices = []) => {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return {
    defaultKey: inputs.length > 0 ? deviceKey(inputs[0]) : "",
    keys: new Set(inputs.map(deviceKey)),
    deviceIds: new Set(inputs.map((device) => device.deviceId).filter(Boolean)),
    groupIds: new Set(inputs.map((device) => device.groupId).filter(Boolean)),
  };
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
  }) {
    this.mediaDevices = mediaDevices;
    this.acquire = acquire;
    this.onRecovered = onRecovered;
    this.onStatusChange = onStatusChange;
    this.debounceMs = debounceMs;
    this.muteGraceMs = muteGraceMs;
    this.retryMs = retryMs;
    this.status = "inactive";
    this.stream = null;
    this.track = null;
    this.followDefault = true;
    this.inputs = describeAudioInputs();
    this.generation = 0;
    this.recoveryPromise = null;
    this.debounceTimer = null;
    this.muteTimer = null;
    this.retryTimer = null;
    this.started = false;
    this.onDeviceChange = () => this.scheduleEvaluation();
    this.onTrackEnded = () => this.recover("ended");
    this.onTrackMute = () => {
      clearTimeout(this.muteTimer);
      this.muteTimer = setTimeout(() => {
        if (this.track?.muted) this.recover("muted");
      }, this.muteGraceMs);
    };
    this.onTrackUnmute = () => clearTimeout(this.muteTimer);
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
    this.followDefault = followDefault;
    this.mediaDevices?.addEventListener?.("devicechange", this.onDeviceChange);
    this.attachStream(stream);
    await this.refreshInputs();
    if (!this.started) return;
    // The track may have died (or come up muted) before our listeners attached;
    // those events won't replay, so evaluate the track's state directly.
    const alive = this.track && this.track.readyState !== "ended";
    this.setStatus(alive ? "active" : "unavailable");
    if (!alive) {
      this.recover("start");
    } else if (this.track.muted) {
      this.onTrackMute();
    }
  }

  attachStream(stream) {
    this.detachTrack();
    this.stream = stream || null;
    this.track = stream?.getAudioTracks?.()[0] || null;
    this.track?.addEventListener?.("ended", this.onTrackEnded);
    this.track?.addEventListener?.("mute", this.onTrackMute);
    this.track?.addEventListener?.("unmute", this.onTrackUnmute);
  }

  detachTrack() {
    this.track?.removeEventListener?.("ended", this.onTrackEnded);
    this.track?.removeEventListener?.("mute", this.onTrackMute);
    this.track?.removeEventListener?.("unmute", this.onTrackUnmute);
    this.track = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = null;
  }

  async refreshInputs() {
    try {
      this.inputs = describeAudioInputs(await this.mediaDevices.enumerateDevices());
      return this.inputs;
    } catch {
      return null;
    }
  }

  scheduleEvaluation() {
    if (!this.started) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.evaluateDeviceChange(), this.debounceMs);
  }

  async evaluateDeviceChange() {
    if (!this.started) return;
    const previous = this.inputs;
    const current = await this.refreshInputs();
    if (!this.started || !current) {
      if (this.track?.readyState === "ended") this.recover("devicechange-ended");
      return;
    }

    const defaultChanged = previous.defaultKey !== current.defaultKey;
    const activeMissing = !activeTrackIsAvailable(this.track, current);
    if ((this.followDefault && defaultChanged) || activeMissing || this.status === "unavailable") {
      this.recover("devicechange");
    }
  }

  recover(reason) {
    if (!this.started) return Promise.resolve(false);
    if (this.recoveryPromise) return this.recoveryPromise;

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = this.generation;
    const oldStream = this.stream;
    this.setStatus("reconnecting");

    const attempt = async () => {
      let replacement = null;
      try {
        replacement = await this.acquire(reason);
        if (!replacement?.getAudioTracks?.()[0]) throw new Error("No audio track returned");
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        await this.onRecovered(replacement, oldStream, reason);
        if (!this.started || generation !== this.generation) {
          replacement.getTracks?.().forEach((track) => track.stop());
          return false;
        }
        this.attachStream(replacement);
        await this.refreshInputs();
        this.setStatus("active");
        return true;
      } catch {
        if (replacement && replacement !== this.stream) {
          replacement.getTracks?.().forEach((track) => track.stop());
        }
        if (this.started && generation === this.generation) {
          this.setStatus("unavailable");
          this.scheduleRetry();
        }
        return false;
      }
    };
    // Only clear our own handle: a stale attempt settling after stop()+start()
    // must not clobber a newer in-flight recovery's dedup handle.
    const promise = attempt().finally(() => {
      if (this.recoveryPromise === promise) this.recoveryPromise = null;
    });
    this.recoveryPromise = promise;
    return promise;
  }

  scheduleRetry() {
    if (!this.started || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.recover("retry");
    }, this.retryMs);
  }

  stop() {
    this.started = false;
    this.generation += 1;
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
