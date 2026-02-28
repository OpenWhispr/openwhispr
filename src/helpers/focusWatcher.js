const { exec } = require("child_process");
const { EventEmitter } = require("events");
const path = require("path");

class FocusWatcher extends EventEmitter {
  constructor() {
    super();
    this._interval = null;
    this._initialHwnd = null;
    this._busy = false;
  }

  start() {
    if (this._interval) return;
    if (process.platform !== "win32") return;

    // Capture initial HWND asynchronously; interval starts immediately
    // and skips until _initialHwnd is populated.
    this._getForegroundHwnd()
      .then((hwnd) => {
        this._initialHwnd = hwnd;
      })
      .catch(() => {
        /* ignore */
      });

    this._interval = setInterval(async () => {
      // Skip this tick if a previous PowerShell call is still running
      if (this._busy || !this._initialHwnd) return;
      this._busy = true;
      try {
        const currentHwnd = await this._getForegroundHwnd();
        if (currentHwnd && this._initialHwnd && currentHwnd !== this._initialHwnd) {
          this.emit("focus-changed", {
            from: this._initialHwnd,
            to: currentHwnd,
          });
          this.stop();
        }
      } catch (e) {
        /* ignore transient errors */
      } finally {
        this._busy = false;
      }
    }, 400);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._initialHwnd = null;
    this._busy = false;
  }

  _resolvePsScript() {
    const fs = require("fs");
    const candidates = [
      // Development: relative to src/helpers/
      path.join(__dirname, "../../resources/get-foreground-pid.ps1"),
    ];

    // Production: process.resourcesPath points to <app>/resources/
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "get-foreground-pid.ps1"),
        path.join(process.resourcesPath, "resources", "get-foreground-pid.ps1"),
        path.join(process.resourcesPath, "bin", "get-foreground-pid.ps1")
      );
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  _getForegroundHwnd() {
    return new Promise((resolve, reject) => {
      const psScript = this._resolvePsScript();
      if (!psScript) {
        return reject(new Error("get-foreground-pid.ps1 not found"));
      }
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${psScript}"`,
        { encoding: "utf8", timeout: 3000, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          // HWND is returned as a 64-bit integer string
          const hwnd = stdout.trim();
          resolve(hwnd || null);
        }
      );
    });
  }
}

module.exports = { FocusWatcher };
