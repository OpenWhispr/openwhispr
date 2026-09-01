// Double-press ("hands-free") gesture detection shared by every hotkey path.
// Pure logic: callers pass timestamps and perform the side effects themselves,
// so the state machine stays unit-testable without timers.
//
// A double-press is two key-downs of the same slot between
// DOUBLE_PRESS_MIN_GAP_MS and DOUBLE_PRESS_MAX_GAP_MS apart. The floor matters:
// the same physical press can be delivered twice (a DE backend phase plus the
// low-level listener), and those duplicates arrive inside the floor, matching
// the existing 150 ms toggle debounce.
const DOUBLE_PRESS_MIN_GAP_MS = 150;
const DOUBLE_PRESS_MAX_GAP_MS = 400;
// An Fn interrupt (Fn used as a navigation modifier) this soon after a latch
// means the "double press" was really a quick tap followed by Fn+key; a latch
// older than this is a deliberate hands-free session and survives Fn combos.
const RECENT_LATCH_INTERRUPT_MS = 1000;

class PressGestureTracker {
  constructor() {
    this._slots = new Map();
    this._nextPrimeToken = 1;
  }

  _slot(kind) {
    let state = this._slots.get(kind);
    if (!state) {
      state = {
        lastToggleDownAt: 0,
        lastToggleWasStartEdge: false,
        lastPushDownAt: 0,
        primeToken: 0,
        handsFree: false,
        handsFreeSince: 0,
      };
      this._slots.set(kind, state);
    }
    return state;
  }

  _isInWindow(gap) {
    return gap > DOUBLE_PRESS_MIN_GAP_MS && gap <= DOUBLE_PRESS_MAX_GAP_MS;
  }

  // Tap mode. Returns true when this press is the second press of a double
  // press and must be suppressed: the recording started by the first press
  // keeps running (hands-free) instead of being toggled off. `pipelineActive`
  // is the caller's evidence that the first press really is preparing or
  // recording this kind — without it (the renderer declined: mic in use,
  // permission denied, policy) the press flows through so a retry works.
  handleTogglePress(kind, now, isStartEdge, pipelineActive) {
    const state = this._slot(kind);
    const suppress =
      pipelineActive &&
      state.lastToggleWasStartEdge &&
      this._isInWindow(now - state.lastToggleDownAt);
    state.lastToggleDownAt = now;
    state.lastToggleWasStartEdge = suppress ? false : isStartEdge;
    return suppress;
  }

  // Push (hold) mode key-down. "ignore": a duplicate delivery of the previous
  // down (a DE backend phase plus the low-level listener can both report one
  // physical press) — do nothing. "stop-hands-free": a latched recording is
  // running and this press ends it. "latch": this is the second press of a
  // double press — start recording and keep it running past the release.
  // "proceed": drive the normal push-to-talk machine.
  handlePushDown(kind, now) {
    const state = this._slot(kind);
    const sinceLastDown = now - state.lastPushDownAt;
    if (state.lastPushDownAt !== 0 && sinceLastDown <= DOUBLE_PRESS_MIN_GAP_MS) {
      return "ignore";
    }
    if (state.handsFree) {
      state.handsFree = false;
      state.primeToken = 0;
      state.lastPushDownAt = now;
      return "stop-hands-free";
    }
    if (state.primeToken !== 0 && this._isInWindow(sinceLastDown)) {
      state.primeToken = 0;
      state.handsFree = true;
      state.handsFreeSince = now;
      state.lastPushDownAt = now;
      return "latch";
    }
    state.primeToken = 0;
    state.lastPushDownAt = now;
    return "proceed";
  }

  // Push mode released before recording started (a quick tap). Prime a
  // potential double press instead of cancelling the prepared session right
  // away; the caller schedules the cancel after cancelDelayMs and passes
  // primeToken back through shouldCancelPreparation when the timer fires.
  handlePushQuickRelease(kind, now) {
    const state = this._slot(kind);
    const primeToken = this._nextPrimeToken++;
    state.primeToken = primeToken;
    return {
      primeToken,
      cancelDelayMs: Math.min(
        DOUBLE_PRESS_MAX_GAP_MS,
        Math.max(0, DOUBLE_PRESS_MAX_GAP_MS - (now - state.lastPushDownAt))
      ),
    };
  }

  shouldCancelPreparation(kind, primeToken) {
    const state = this._slot(kind);
    if (state.primeToken === 0 || state.primeToken !== primeToken) return false;
    state.primeToken = 0;
    return true;
  }

  // Fn was used as a navigation modifier mid-gesture. Tells the caller what to
  // unwind: a primed (still preparing) session, a just-latched recording, or
  // nothing when the hands-free session is old enough to be deliberate.
  interruptGesture(kind, now) {
    const state = this._slot(kind);
    if (state.primeToken !== 0) {
      state.primeToken = 0;
      return "cancel-preparation";
    }
    if (state.handsFree && now - state.handsFreeSince <= RECENT_LATCH_INTERRUPT_MS) {
      state.handsFree = false;
      return "cancel-recording";
    }
    return "none";
  }

  isHandsFreeActive(kind) {
    return this._slot(kind).handsFree;
  }

  clearHandsFree(kind) {
    this._slot(kind).handsFree = false;
  }

  // The renderer owns the real recording state; when it reports the recording
  // over (Escape, a UI stop, a mic error), the latch is gone with it.
  clearAllHandsFree() {
    for (const state of this._slots.values()) {
      state.handsFree = false;
    }
  }

  reset() {
    this._slots.clear();
  }
}

module.exports = {
  PressGestureTracker,
  DOUBLE_PRESS_MIN_GAP_MS,
  DOUBLE_PRESS_MAX_GAP_MS,
  RECENT_LATCH_INTERRUPT_MS,
};
