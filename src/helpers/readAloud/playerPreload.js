const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ttsPlayer", {
  onCommand: (callback) => {
    ipcRenderer.on("tts-player:command", (_event, command) => callback(command));
  },
  reportState: (state) => ipcRenderer.send("tts-player:state", state),
  action: (action) => ipcRenderer.send("tts-player:action", action),
});
