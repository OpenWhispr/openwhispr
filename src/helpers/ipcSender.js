// An IPC message came from this window's own top frame: a window's privileged
// channels must not answer another window or a subframe.
function isFromWindow(event, window) {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  );
}

module.exports = { isFromWindow };
