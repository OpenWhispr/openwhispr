const { spawn } = require("child_process");

// Opens the Sound dialog's Recording tab, where a microphone's Properties → Advanced
// holds the exclusive-mode checkbox (#1138). Windows only.
function openRecordingDevicesSettings({ platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform !== "win32") return Promise.resolve({ success: false });
  return new Promise((resolve) => {
    const fail = (error) => resolve({ success: false, error: error.message });
    let child;
    try {
      child = spawnProcess("control.exe", ["mmsys.cpl,,1"], { detached: true, stdio: "ignore" });
    } catch (error) {
      // spawn throws synchronously for some errors (EPERM, for example).
      fail(error);
      return;
    }
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      resolve({ success: true });
    });
  });
}

module.exports = { openRecordingDevicesSettings };
