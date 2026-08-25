/**
 * Bring the Windows control-panel window and its renderer into the foreground
 * before an onboarding hotkey field starts listening. DOM focus alone can set
 * document.activeElement inside an inactive BrowserWindow, but Windows still
 * sends the first keypress to whichever native window owns foreground focus.
 */
function focusWindowsHotkeyCaptureWindow(win, platform = process.platform) {
  if (platform !== "win32" || !win || win.isDestroyed?.() || typeof win.focus !== "function") {
    return false;
  }

  if (win.isMinimized?.()) win.restore?.();
  if (win.isVisible?.() === false) win.show?.();
  win.focus();
  win.webContents?.focus?.();
  return true;
}

module.exports = { focusWindowsHotkeyCaptureWindow };
