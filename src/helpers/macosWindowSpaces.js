const { resolveBundledBinary } = require("./binaryResolver");
const debugLogger = require("./debugLogger");

// macOS can pin a hidden overlay panel to a single Space, and nothing Electron
// exposes can undo it (see native/macos-window-spaces). The addon is loaded on
// first use, once; when it is missing or fails, the caller's show goes ahead.
let addon;
let callFailureLogged = false;

function loadAddon() {
  if (addon !== undefined) return addon;
  addon = null;
  try {
    const binary = resolveBundledBinary("macos-window-spaces.node", "window");
    if (!binary) throw new Error("macos-window-spaces.node not found");
    const loaded = { exports: {} };
    process.dlopen(loaded, binary);
    addon = loaded.exports;
  } catch (error) {
    debugLogger.debug("macOS Spaces helper unavailable", { error: error.message }, "window");
  }
  return addon;
}

// Re-joins `win` to every Space of its display. Only ever called on a hidden
// window; returns whether the re-assert ran, and never throws.
function reassertAllSpaces(win) {
  if (process.platform !== "darwin") return false;
  const native = loadAddon();
  if (!native) return false;
  try {
    return native.reassertAllSpaces(win.getNativeWindowHandle());
  } catch (error) {
    if (!callFailureLogged) {
      callFailureLogged = true;
      debugLogger.debug("macOS Spaces re-assert failed", { error: error.message }, "window");
    }
    return false;
  }
}

module.exports = { reassertAllSpaces };
