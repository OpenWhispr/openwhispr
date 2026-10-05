const { spawn } = require("child_process");
const { app } = require("electron");
const { resolveBundledBinary } = require("./binaryResolver");
const debugLogger = require("./debugLogger");

const APPLY_TIMEOUT_MS = 1000;

function createLinuxWindowInputRegion(win) {
  let child = null;
  let failure = null;
  let buffer = "";
  const pending = [];
  let finishStopping;
  const stopped = new Promise((resolve) => {
    finishStopping = resolve;
  });

  const finish = () => {
    for (const request of pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    app.removeListener("before-quit", onClose);
    win.removeListener("closed", onClose);
    finishStopping();
  };
  const stop = (error = new Error("Input region writer stopped")) => {
    if (failure) return;
    failure = error;
    if (child) child.kill("SIGKILL");
    else finish();
  };
  const onClose = () => stop();
  const fail = (error) => {
    if (failure) return;
    debugLogger.warn("Linux input region unavailable", { error: error.message });
    stop(error);
  };

  const start = () => {
    const binary = resolveBundledBinary("linux-fast-paste", "linux-input-region");
    if (!binary) throw new Error("Linux input region helper not found");
    const windowId = win.getNativeWindowHandle().readUInt32LE();
    if (!windowId) throw new Error("X11 window handle unavailable");
    child = spawn(
      binary,
      ["--capabilities", "--input-region-server", "--window", String(windowId)],
      {
        stdio: ["pipe", "pipe", "ignore"],
      }
    );
    child.on("error", fail);
    child.on("close", () => {
      if (!failure) fail(new Error("Linux input region helper exited"));
      finish();
    });
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      buffer += chunk;
      if (buffer.length > 1024) return fail(new Error("Invalid input region response"));
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line !== "OK" || !pending.length)
          return fail(new Error("Invalid input region response"));
        const request = pending.shift();
        clearTimeout(request.timer);
        request.resolve();
      }
    });
  };

  const set = (region) => {
    if (failure)
      return stopped.then(() => {
        throw failure;
      });
    let line = "full\n";
    if (region !== null) {
      const values = [
        region?.viewportWidth,
        region?.viewportHeight,
        region?.x,
        region?.y,
        region?.width,
        region?.height,
      ];
      if (
        !values.every(Number.isFinite) ||
        values[0] <= 0 ||
        values[1] <= 0 ||
        values[4] < 0 ||
        values[5] < 0
      ) {
        fail(new Error("Invalid input region"));
        return stopped.then(() => {
          throw failure;
        });
      }
      line = `${values.join(" ")}\n`;
    }
    return new Promise((resolve, reject) => {
      pending.push({
        resolve,
        reject,
        timer: setTimeout(
          () => fail(new Error("Linux input region update timed out")),
          APPLY_TIMEOUT_MS
        ),
      });
      try {
        if (!child) start();
        child.stdin.write(line);
      } catch (error) {
        fail(error);
      }
    });
  };

  app.once("before-quit", onClose);
  win.once("closed", onClose);
  return { set, stop };
}

module.exports = { createLinuxWindowInputRegion };
