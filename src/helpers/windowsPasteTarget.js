// Whether a Windows paste may restore the window captured at record start
// (#859). The predicate is "ours and not one of our windows", not "ours and
// editable": a tray-menu start leaves the menu's owner window foreground, and
// force-activating that at paste time would pull the foreground onto OpenWhispr
// and drop the keystroke. Our real windows — the control panel's note editor —
// stay valid targets, so dictating into a note still pastes there.

/** "TARGET %p" prints hex, with or without an 0x prefix. */
function parseWindowHandle(value) {
  try {
    return BigInt(`0x${String(value).replace(/^0x/i, "")}`);
  } catch {
    return null;
  }
}

// Win64 hands back an 8-byte pointer, Win32 a 4-byte one.
function readWindowHandle(buffer) {
  return buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
}

function isRestorablePasteTarget({ target, ownExeName, ownWindowHandles = [] }) {
  if (!target?.id) return false;

  // An unreadable exe name reads as someone else's window, keeping the pre-#859
  // behaviour rather than dropping a target that was probably legitimate.
  const exeName = String(target.exeName || "").toLowerCase();
  if (!exeName || exeName !== String(ownExeName || "").toLowerCase()) return true;

  const handle = parseWindowHandle(target.id);
  if (handle === null) return false;
  return ownWindowHandles.some((buffer) => readWindowHandle(buffer) === handle);
}

module.exports = { isRestorablePasteTarget, parseWindowHandle };
