// A held key re-fires globalShortcut on every autorepeat (macOS: first after
// 225–375ms, then every 30–90ms) and never reports the release. Fires inside
// the window of the previous fire are repeats and renew the window, so one
// hold is one press however long it lasts.
const HOTKEY_REPEAT_WINDOW_MS = 600;

function createHotkeyRepeatGate(windowMs = HOTKEY_REPEAT_WINDOW_MS, now = Date.now) {
  let lastFireAt = -Infinity;
  return () => {
    const firedAt = now();
    const isRepeat = firedAt - lastFireAt < windowMs;
    lastFireAt = firedAt;
    return !isRepeat;
  };
}

module.exports = { HOTKEY_REPEAT_WINDOW_MS, createHotkeyRepeatGate };
