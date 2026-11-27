const MIN_TAP_INTERVAL_MS = 40;
const MAX_TAP_INTERVAL_MS = 400;

class DictationDoublePress {
  constructor(now = Date.now) {
    this.now = now;
    this.lastTap = null;
    this.latch = null;
  }

  canPair(hotkey) {
    if (this.lastTap?.hotkey !== hotkey) return false;
    const elapsed = this.now() - this.lastTap.time;
    return elapsed >= 0 && elapsed <= MAX_TAP_INTERVAL_MS;
  }

  shortRelease(hotkey) {
    if (this.latch) return false;
    if (this.canPair(hotkey)) {
      // A backend can deliver both edges of one physical tap twice.
      if (this.now() - this.lastTap.time < MIN_TAP_INTERVAL_MS) return false;
      this.clearTap();
      return true;
    }
    this.lastTap = { hotkey, time: this.now() };
    return false;
  }

  clearTap() {
    this.lastTap = null;
  }

  start(hotkey, requestId) {
    this.latch = { hotkey, requestId, stopModifiers: null };
  }

  press(hotkey, modifiers = []) {
    if (!this.latch) {
      if (this.lastTap?.hotkey !== hotkey) this.clearTap();
      return false;
    }
    if (this.latch.hotkey === hotkey && !this.latch.stopModifiers) {
      this.latch.stopModifiers = new Set(modifiers);
    }
    return true;
  }

  release(hotkey) {
    if (this.latch?.hotkey !== hotkey || this.latch.stopModifiers?.size !== 0) return false;
    return this.clearLatch();
  }

  getArmedModifierStopHotkey() {
    return this.latch?.stopModifiers?.size ? this.latch.hotkey : null;
  }

  releaseModifier(modifier) {
    const modifiers = this.latch?.stopModifiers;
    if (!modifiers?.delete(modifier) || modifiers.size !== 0) return false;
    return this.clearLatch();
  }

  interrupt(hotkey) {
    if (this.lastTap?.hotkey === hotkey) this.clearTap();
    if (this.latch?.hotkey === hotkey) this.latch.stopModifiers = null;
  }

  rejectStart(requestId) {
    if (this.latch?.requestId === requestId) this.clearLatch();
  }

  clearLatch() {
    const wasLatched = this.latch !== null;
    this.latch = null;
    return wasLatched;
  }
}

module.exports = DictationDoublePress;
