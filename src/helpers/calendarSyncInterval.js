const debugLogger = require("./debugLogger");

const FOCUS_SYNC_THROTTLE_MS = 30 * 1000;

// Interval runner for calendar REST providers: exponential backoff on
// consecutive failures (intervalMs × 2 per failure, capped at maxIntervalMs)
// and a 30s throttle on focus-triggered syncs.
class CalendarSyncInterval {
  constructor(syncFn, { intervalMs, maxIntervalMs, logScope }) {
    this.syncFn = syncFn;
    this.intervalMs = intervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.logScope = logScope;
    this.timer = null;
    this._consecutiveFailures = 0;
    this._lastFocusSync = 0;
    // Pending syncs must not revive a stopped timer or alter a later run.
    this._generation = 0;
  }

  start() {
    this._generation++;
    this._consecutiveFailures = 0;
    this._schedule();
  }

  stop() {
    this._generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Resets the backoff after an out-of-band successful sync.
  notifySuccess() {
    if (this._consecutiveFailures > 0) {
      this._consecutiveFailures = 0;
      if (this.timer) this._schedule();
    }
  }

  syncOnFocus() {
    const now = Date.now();
    if (now - this._lastFocusSync < FOCUS_SYNC_THROTTLE_MS) return;
    this._lastFocusSync = now;

    const generation = this._generation;
    this.syncFn()
      .then(() => {
        if (generation === this._generation) this.notifySuccess();
      })
      .catch((err) =>
        debugLogger.error("Focus-triggered sync failed", { error: err.message }, this.logScope)
      );
  }

  _schedule() {
    if (this.timer) clearInterval(this.timer);

    const interval = this._getInterval();
    debugLogger.info(
      "Calendar sync scheduled",
      { intervalMs: interval, consecutiveFailures: this._consecutiveFailures },
      this.logScope
    );

    const generation = this._generation;
    this.timer = setInterval(() => {
      this.syncFn()
        .then(() => {
          if (generation === this._generation) this.notifySuccess();
        })
        .catch((err) => {
          if (generation !== this._generation) return;
          this._consecutiveFailures++;
          debugLogger.error(
            "Calendar sync failed",
            {
              error: err.message,
              consecutiveFailures: this._consecutiveFailures,
              nextIntervalMs: this._getInterval(),
            },
            this.logScope
          );
          this._schedule();
        });
    }, interval);
  }

  _getInterval() {
    if (this._consecutiveFailures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * Math.pow(2, this._consecutiveFailures), this.maxIntervalMs);
  }
}

module.exports = CalendarSyncInterval;
module.exports.FOCUS_SYNC_THROTTLE_MS = FOCUS_SYNC_THROTTLE_MS;
