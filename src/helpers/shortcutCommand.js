const { execFile } = require("child_process");
const { performance } = require("perf_hooks");
const debugLogger = require("./debugLogger");

// Wait for execFile's exit/stdio completion, including after cancellation. A
// killed client may already have delivered its command; callers still own rollback.
function shortcutCommand(file, args, { timeout = 5000, signal } = {}) {
  signal?.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true },
      (err, stdout) => {
        signal?.removeEventListener("abort", cancel);
        debugLogger.debug("Shortcut backend command completed", {
          command: file,
          operation: args[0],
          durationMs: Math.round(performance.now() - started),
          success: !err && !cancelled,
          cancelled,
        });
        if (cancelled) reject(signal.reason || new Error("Shortcut command cancelled"));
        else if (err) reject(err);
        else resolve(stdout);
      }
    );
    const cancel = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

module.exports = shortcutCommand;
