const { BrowserWindow } = require("electron");

function broadcastToWindows(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

module.exports = { broadcastToWindows };
