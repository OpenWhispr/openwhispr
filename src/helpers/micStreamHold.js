// Opt-in idle-hold: keep one "master" mic stream open after a dictation so the
// next one re-acquires in ~0.1ms (track.clone) instead of paying a cold driver
// open. Recordings only ever own clones, so every existing teardown path keeps
// stopping the stream it was given, and releasing the master never interrupts a
// live recording (clones are independent of their source track).
export class MicStreamHold {
  constructor({
    holdSeconds = 0,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onHoldChange = null,
    makeStream = (track) => new MediaStream([track]),
    isBusy = () => false,
  } = {}) {
    this.holdSeconds = holdSeconds > 0 ? holdSeconds : 0;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onHoldChange = onHoldChange;
    this.makeStream = makeStream;
    this.isBusy = isBusy;
    this.master = null;
    this.masterKey = null;
    this.releaseTimer = null;
  }

  get active() {
    return this.master !== null;
  }

  setHoldSeconds(seconds) {
    this.holdSeconds = seconds > 0 ? seconds : 0;
    if (this.holdSeconds === 0) this.drop();
    else if (this.master) this.touch();
  }

  // Returns a clone of the held master, or null when the caller must open the
  // device itself (hold disabled, no master, device changed, or master died).
  acquireClone(constraintsKey) {
    if (this.holdSeconds === 0 || !this.master) return null;
    const track = this._masterTrack();
    if (this.masterKey !== constraintsKey || !this._isLive(track)) {
      this.drop();
      return null;
    }
    this.touch();
    return this.makeStream(track.clone());
  }

  // Keeps a freshly opened stream as the master and returns a clone for the
  // recording — one getUserMedia serves both roles. Pass-through when disabled.
  adoptAndClone(stream, constraintsKey) {
    if (this.holdSeconds === 0) return stream;
    const wasActive = this.active;
    // Replacing a master is a swap, not a release+acquire: stop the old tracks
    // silently so observers see one continuous hold, not a false→true blip.
    this._clearReleaseTimer();
    this.master?.getAudioTracks().forEach((track) => track.stop());
    this.master = stream;
    this.masterKey = constraintsKey;
    if (!wasActive) this.onHoldChange?.(true);
    this.touch();
    return this.makeStream(this._masterTrack().clone());
  }

  touch() {
    this._clearReleaseTimer();
    if (this.holdSeconds > 0 && this.master) {
      this.releaseTimer = this.setTimer(() => {
        this.releaseTimer = null;
        // A recording longer than the hold window must not lose its master —
        // the countdown belongs after the dictation ends, so defer instead.
        if (this.isBusy()) {
          this.touch();
          return;
        }
        this.drop();
      }, this.holdSeconds * 1000);
    }
  }

  drop() {
    this._clearReleaseTimer();
    if (!this.master) return;
    this.master.getAudioTracks().forEach((track) => track.stop());
    this.master = null;
    this.masterKey = null;
    this.onHoldChange?.(false);
  }

  _masterTrack() {
    return this.master?.getAudioTracks()[0] ?? null;
  }

  _isLive(track) {
    return !!track && track.readyState === "live" && !track.muted;
  }

  _clearReleaseTimer() {
    if (this.releaseTimer !== null) {
      this.clearTimer(this.releaseTimer);
      this.releaseTimer = null;
    }
  }
}
