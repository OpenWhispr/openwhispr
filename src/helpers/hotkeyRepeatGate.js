// A held key re-fires globalShortcut on every keyboard autorepeat and never
// reports the release: macOS starts repeating 225–375ms after the press by
// default and then every 30–90ms, and Windows' RegisterHotKey repeats the same
// way. A tap-to-toggle hotkey would start and stop dictation a few times a
// second for as long as the key is down. Every fire inside the window of the
// previous fire is a repeat, and each repeat renews the window, so one hold is
// exactly one press however long it lasts.
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
