/**
 * Overlay chrome for the dictation/assistant window.
 *
 * On Linux X11/XWayland, Chromium maps always-on-top frameless windows to
 * override-redirect. The WM then cannot give the assistant panel keyboard
 * focus, so typing lands in the previously focused app (#2027).
 */
function getAssistantPanelChrome({ platform, open }) {
  if (!open) {
    return { focusable: false, alwaysOnTop: true, skipTaskbar: true };
  }
  if (platform === "linux") {
    return { focusable: true, alwaysOnTop: false, skipTaskbar: false };
  }
  return { focusable: true, alwaysOnTop: true, skipTaskbar: true };
}

module.exports = { getAssistantPanelChrome };
