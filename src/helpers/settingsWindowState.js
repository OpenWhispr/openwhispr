const { execFile } = require("child_process");
const { resolveBundledBinary } = require("./binaryResolver");

// The guide polls this while the overlay is open, so a hung helper must never
// hold it up: the query is cheap enough that a short timeout is plenty.
const TIMEOUT_MS = 400;

// { settings: bounds | null, authPrompt: boolean }, or null when the state could
// not be read at all. null means unknown, never "closed": dismissing the overlay
// on a transient read failure would strand the user mid-permission.
function readSettingsWindowState() {
  if (process.platform !== "darwin") return Promise.resolve(null);

  const binary = resolveBundledBinary("macos-window-bounds", "permission-guide");
  if (!binary) return Promise.resolve(null);

  return new Promise((resolve) => {
    execFile(binary, [], { timeout: TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(null);

      try {
        const { settings, authPrompt, frontmost } = JSON.parse(String(stdout));
        const readable =
          settings && ["x", "y", "width", "height"].every((key) => Number.isFinite(settings[key]));

        resolve({
          settings: readable
            ? {
                x: settings.x,
                y: settings.y,
                width: settings.width,
                height: settings.height,
              }
            : null,
          authPrompt: authPrompt === true,
          frontmost: typeof frontmost === "string" ? frontmost : null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

module.exports = { readSettingsWindowState };
