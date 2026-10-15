const { getRegistrySnapshot, subscribeRegistry } = require("../models/registryData.js");

function registerRegistryIpc(ipcMain, broadcast) {
  const initial = (event) => {
    event.returnValue = getRegistrySnapshot();
  };
  ipcMain.on("model-registry-initial", initial);
  ipcMain.handle("get-model-registry", getRegistrySnapshot);
  const unsubscribe = subscribeRegistry(() =>
    broadcast("model-registry-updated", getRegistrySnapshot())
  );
  return () => {
    unsubscribe();
    ipcMain.removeListener("model-registry-initial", initial);
    ipcMain.removeHandler("get-model-registry");
  };
}
module.exports = { registerRegistryIpc };
