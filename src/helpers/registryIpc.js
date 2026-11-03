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
  // The synchronous listener stays until exit: a window reloading after teardown
  // would otherwise block forever on sendSync.
  return () => {
    unsubscribe();
    ipcMain.removeHandler("get-model-registry");
  };
}
module.exports = { registerRegistryIpc };
