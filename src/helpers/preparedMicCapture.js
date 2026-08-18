// A prepared value not taken within this window is disposed: prepare fires on
// main-process guesses (toggle key-down) that the renderer may decline, and a
// forgotten prepared stream would otherwise hold the mic open indefinitely.
export const PREPARED_MAX_AGE_MS = 10000;

// Pre-roll older than a normal key-down-to-start gap was buffered by a prepare
// the recording never answered, so it holds audio from before the user meant to
// dictate. The stream is still reusable; only the buffered chunks are not.
export const PRE_ROLL_MAX_AGE_MS = 2000;

export const discardPreRoll = (prepared) => {
  const recorder = prepared?.recorder;
  if (recorder) {
    try {
      // Detach before stop: the recorder's final dataavailable fires async and
      // would otherwise repopulate the chunks array after it is cleared.
      recorder.ondataavailable = null;
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // Recorder already torn down by the browser.
    }
    prepared.recorder = null;
  }
  if (prepared?.chunks) prepared.chunks.length = 0;
};

export const disposePreparedCapture = (prepared) => {
  if (!prepared) return;
  discardPreRoll(prepared);
  prepared.stream?.getTracks?.().forEach((track) => track.stop());
};

export class PreparedMicCapture {
  constructor({
    dispose = disposePreparedCapture,
    maxAgeMs = PREPARED_MAX_AGE_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onActiveChange = null,
  } = {}) {
    this.dispose = dispose;
    this.maxAgeMs = maxAgeMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onActiveChange = onActiveChange;
    this.generation = 0;
    this.prepared = null;
    this.pending = null;
    this.inFlight = 0;
    this.expiryTimer = null;
    this._reportedActive = false;
  }

  // The window in which the device is open (or opening) for this capture. A
  // cancel clears `pending` so the next prepare can start, but the acquisition
  // it abandoned still owns the mic until it settles — hence the in-flight
  // count rather than a `pending` check.
  get active() {
    return this.prepared !== null || this.inFlight > 0;
  }

  prepare(acquire) {
    if (this.prepared) return Promise.resolve(this.prepared);
    if (this.pending) return this.pending;

    const generation = this.generation;
    this.inFlight += 1;
    const pending = Promise.resolve()
      .then(acquire)
      .then((prepared) => {
        if (generation !== this.generation) {
          this.dispose(prepared);
          return null;
        }
        this.prepared = prepared;
        this._armExpiry();
        return prepared;
      })
      .finally(() => {
        this.inFlight -= 1;
        if (this.pending === pending) this.pending = null;
        this._notifyActive();
      });

    this.pending = pending;
    this._notifyActive();
    return pending;
  }

  async take() {
    if (this.pending) {
      try {
        await this.pending;
      } catch {
        // The caller can fall back to a normal acquisition.
      }
    }
    const prepared = this.prepared;
    this.prepared = null;
    this.generation += 1;
    this._clearExpiry();
    this._notifyActive();
    return prepared;
  }

  cancel() {
    this.generation += 1;
    this._clearExpiry();
    this.dispose(this.prepared);
    this.prepared = null;
    this.pending = null;
    this._notifyActive();
  }

  _notifyActive() {
    if (this.active === this._reportedActive) return;
    this._reportedActive = this.active;
    this.onActiveChange?.(this._reportedActive);
  }

  _armExpiry() {
    this._clearExpiry();
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.cancel();
    }, this.maxAgeMs);
  }

  _clearExpiry() {
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
