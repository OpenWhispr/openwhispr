const { clipboard, systemPreferences } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { killProcess } = require("../utils/process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 30000;

// isTrustedAccessibilityClient() is a cheap synchronous syscall, so the cache
// only exists to debounce the dialog shown on denial.
const ACCESSIBILITY_CHECK_TTL_MS = 5000;

const getLinuxDesktopEnv = () =>
  [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

const isGnomeDesktop = (desktopEnv) => desktopEnv.includes("gnome");

const isKdeDesktop = (desktopEnv) => desktopEnv.includes("kde");

const isWlrootsCompositor = (desktopEnv) => {
  const wlrootsDesktops = ["sway", "hyprland", "wayfire", "river", "dwl", "labwc", "cage"];
  return (
    wlrootsDesktops.some((wm) => desktopEnv.includes(wm)) ||
    !!process.env.SWAYSOCK ||
    !!process.env.HYPRLAND_INSTANCE_SIGNATURE
  );
};

const getLinuxSessionInfo = () => {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const xwaylandAvailable = isWayland && !!process.env.DISPLAY;
  const desktopEnv = getLinuxDesktopEnv();
  const isGnome = isWayland && isGnomeDesktop(desktopEnv);
  const isKde = isWayland && isKdeDesktop(desktopEnv);
  const isWlroots = isWayland && isWlrootsCompositor(desktopEnv);

  return { isWayland, xwaylandAvailable, desktopEnv, isGnome, isKde, isWlroots };
};

const PASTE_DELAYS = {
  darwin: 120,
  win32_fast: 10,
  win32_nircmd: 30,
  win32_pwsh: 40,
  linux: 50,
};

const RESTORE_DELAYS = {
  darwin: 450,
  win32_nircmd: 80,
  win32_pwsh: 80,
  linux: 200,
};

function writeClipboardInRenderer(webContents, text) {
  if (!webContents || !webContents.executeJavaScript) {
    return Promise.reject(new Error("Invalid webContents for clipboard write"));
  }
  const escaped = JSON.stringify(text);
  return webContents.executeJavaScript(`navigator.clipboard.writeText(${escaped})`);
}

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.commandAvailabilityCache = new Map();
    this.nircmdPath = null;
    this.nircmdChecked = false;
    this.fastPastePath = null;
    this.fastPasteChecked = false;
    this.winFastPastePath = null;
    this.winFastPasteChecked = false;
    this.linuxFastPastePath = null;
    this.linuxFastPasteChecked = false;
  }

  _isWayland() {
    if (process.platform !== "linux") return false;
    const { isWayland } = getLinuxSessionInfo();
    return isWayland;
  }

  _writeClipboardWayland(text, webContents) {
    if (this.commandExists("wl-copy")) {
      try {
        const result = spawnSync("wl-copy", ["--", text], { timeout: 2000 });
        if (result.status === 0) {
          clipboard.writeText(text);
          return;
        }
      } catch {}
    }

    if (webContents && !webContents.isDestroyed()) {
      writeClipboardInRenderer(webContents, text).catch(() => {});
    }

    clipboard.writeText(text);
  }

  getNircmdPath() {
    if (this.nircmdChecked) {
      return this.nircmdPath;
    }

    this.nircmdChecked = true;

    if (process.platform !== "win32") {
      return null;
    }

    const possiblePaths = [
      path.join(process.resourcesPath, "bin", "nircmd.exe"),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
      path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
    ];

    for (const nircmdPath of possiblePaths) {
      try {
        if (fs.existsSync(nircmdPath)) {
          this.safeLog(`✅ Found nircmd.exe at: ${nircmdPath}`);
          this.nircmdPath = nircmdPath;
          return nircmdPath;
        }
      } catch (error) {}
    }

    this.safeLog("⚠️ nircmd.exe not found, will use PowerShell fallback");
    return null;
  }

  getNircmdStatus() {
    if (process.platform !== "win32") {
      return { available: false, reason: "Not Windows" };
    }
    const nircmdPath = this.getNircmdPath();
    return {
      available: !!nircmdPath,
      path: nircmdPath,
    };
  }

  _resolveNativeBinary(binaryName, platform, cacheKeyChecked, cacheKeyPath) {
    if (this[cacheKeyChecked]) {
      return this[cacheKeyPath];
    }
    this[cacheKeyChecked] = true;

    if (process.platform !== platform) {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            fs.chmodSync(candidate, 0o755);
          }
          this[cacheKeyPath] = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  resolveFastPasteBinary() {
    return this._resolveNativeBinary(
      "macos-fast-paste",
      "darwin",
      "fastPasteChecked",
      "fastPastePath"
    );
  }

  resolveWindowsFastPasteBinary() {
    return this._resolveNativeBinary(
      "windows-fast-paste.exe",
      "win32",
      "winFastPasteChecked",
      "winFastPastePath"
    );
  }

  resolveLinuxFastPasteBinary() {
    return this._resolveNativeBinary(
      "linux-fast-paste",
      "linux",
      "linuxFastPasteChecked",
      "linuxFastPastePath"
    );
  }

  _isYdotoolDaemonRunning() {
    const uid = process.getuid?.();
    const socketPaths = [
      process.env.YDOTOOL_SOCKET,
      uid != null ? `/run/user/${uid}/.ydotool_socket` : null,
      "/tmp/.ydotool_socket",
    ].filter(Boolean);

    for (const socketPath of socketPaths) {
      try {
        if (fs.statSync(socketPath)) return true;
      } catch {}
    }

    try {
      return spawnSync("pidof", ["ydotoold"], { timeout: 1000 }).status === 0;
    } catch {
      return false;
    }
  }

  _canAccessUinput() {
    if (process.platform !== "linux") return false;
    const now = Date.now();
    if (this._uinputCache && now < this._uinputCache.expiresAt) {
      return this._uinputCache.accessible;
    }
    let accessible = false;
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
      accessible = true;
    } catch {}
    this._uinputCache = { accessible, expiresAt: now + 30000 };
    return accessible;
  }

  safeLog(...args) {
    if (process.env.NODE_ENV === "development") {
      try {
        console.log(...args);
      } catch (error) {
        // Silently ignore EPIPE errors in logging
        if (error.code !== "EPIPE") {
          process.stderr.write(`Log error: ${error.message}\n`);
        }
      }
    }
  }

  commandExists(cmd) {
    const now = Date.now();
    const cached = this.commandAvailabilityCache.get(cmd);
    if (cached && now < cached.expiresAt) {
      return cached.exists;
    }
    try {
      const res = spawnSync("sh", ["-c", `command -v ${cmd}`], {
        stdio: "ignore",
      });
      const exists = res.status === 0;
      this.commandAvailabilityCache.set(cmd, {
        exists,
        expiresAt: now + CACHE_TTL_MS,
      });
      return exists;
    } catch {
      this.commandAvailabilityCache.set(cmd, {
        exists: false,
        expiresAt: now + CACHE_TTL_MS,
      });
      return false;
    }
  }

  async pasteText(text, options = {}) {
    const startTime = Date.now();
    const platform = process.platform;
    let method = "unknown";
    const webContents = options.webContents;

    try {
      const originalClipboard = clipboard.readText();
      this.safeLog(
        "💾 Saved original clipboard content:",
        originalClipboard.substring(0, 50) + "..."
      );

      if (platform === "linux" && this._isWayland()) {
        this._writeClipboardWayland(text, webContents);
      } else {
        clipboard.writeText(text);
      }
      this.safeLog("📋 Text copied to clipboard:", text.substring(0, 50) + "...");

      if (platform === "darwin") {
        method = this.resolveFastPasteBinary() ? "cgevent" : "applescript";
        this.safeLog("🔍 Checking accessibility permissions for paste operation...");
        const hasPermissions = await this.checkAccessibilityPermissions();

        if (!hasPermissions) {
          this.safeLog("⚠️ No accessibility permissions - text copied to clipboard only");
          const errorMsg =
            "Accessibility permissions required for automatic pasting. Text has been copied to clipboard - please paste manually with Cmd+V.";
          throw new Error(errorMsg);
        }

        this.safeLog("✅ Permissions granted, attempting to paste...");
        try {
          await this.pasteMacOS(originalClipboard, options);
        } catch (firstError) {
          this.safeLog("⚠️ First paste attempt failed, retrying...", firstError?.message);
          clipboard.writeText(text);
          await new Promise((r) => setTimeout(r, 200));
          await this.pasteMacOS(originalClipboard, options);
        }
      } else if (platform === "win32") {
        const winFastPaste = this.resolveWindowsFastPasteBinary();
        if (winFastPaste) {
          method = "sendinput";
        } else {
          const nircmdPath = this.getNircmdPath();
          method = nircmdPath ? "nircmd" : "powershell";
        }
        await this.pasteWindows(originalClipboard);
      } else {
        method = this.resolveLinuxFastPasteBinary() ? "linux-xtest" : "linux-tools";
        await this.pasteLinux(originalClipboard, options);
      }

      this.safeLog("✅ Paste operation complete", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        textLength: text.length,
      });
    } catch (error) {
      this.safeLog("❌ Paste operation failed", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        error: error.message,
      });
      throw error;
    }
  }

  async pasteMacOS(originalClipboard, options = {}) {
    const fastPasteBinary = this.resolveFastPasteBinary();
    const useFastPaste = !!fastPasteBinary;
    const pasteDelay = options.fromStreaming ? (useFastPaste ? 15 : 50) : PASTE_DELAYS.darwin;

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = useFastPaste
          ? spawn(fastPasteBinary)
          : spawn("osascript", [
              "-e",
              'tell application "System Events" to key code 9 using command down',
            ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog(`Text pasted successfully via ${useFastPaste ? "CGEvent" : "osascript"}`);
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
            }, RESTORE_DELAYS.darwin);
            resolve();
          } else if (useFastPaste) {
            this.safeLog(
              code === 2
                ? "CGEvent binary lacks accessibility trust, falling back to osascript"
                : `CGEvent paste failed (code ${code}), falling back to osascript`
            );
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            this.accessibilityCache = { value: null, expiresAt: 0 };
            const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (useFastPaste) {
            this.safeLog("CGEvent paste error, falling back to osascript");
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V.";
          reject(new Error(errorMsg));
        }, 3000);
      }, pasteDelay);
    });
  }

  async pasteMacOSWithOsascript(originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to key code 9 using command down',
      ]);

      let hasTimedOut = false;

      pasteProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();

        if (code === 0) {
          this.safeLog("Text pasted successfully via osascript fallback");
          setTimeout(() => {
            clipboard.writeText(originalClipboard);
          }, RESTORE_DELAYS.darwin);
          resolve();
        } else {
          this.accessibilityCache = { value: null, expiresAt: 0 };
          const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
          reject(new Error(errorMsg));
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();
        const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
        reject(new Error(errorMsg));
      });

      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        killProcess(pasteProcess, "SIGKILL");
        pasteProcess.removeAllListeners();
        reject(
          new Error(
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V."
          )
        );
      }, 3000);
    });
  }

  async pasteWindows(originalClipboard) {
    const fastPastePath = this.resolveWindowsFastPasteBinary();

    if (fastPastePath) {
      return this.pasteWithFastPaste(fastPastePath, originalClipboard);
    }

    return this.pasteWithNircmdOrPowerShell(originalClipboard);
  }

  async pasteWithFastPaste(fastPastePath, originalClipboard) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog("⚡ Windows fast-paste starting");

        const pasteProcess = spawn(fastPastePath, [], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdoutData = "";
        let stderrData = "";

        pasteProcess.stdout.on("data", (data) => {
          stdoutData += data.toString();
        });

        pasteProcess.stderr.on("data", (data) => {
          stderrData += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;
          const output = stdoutData.trim();

          if (code === 0) {
            this.safeLog("✅ Windows fast-paste success", {
              elapsedMs: elapsed,
              output,
            });
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
              this.safeLog("🔄 Clipboard restored");
            }, RESTORE_DELAYS.win32_nircmd);
            resolve();
          } else {
            this.safeLog(
              `❌ Windows fast-paste failed (code ${code}), falling back to nircmd/PowerShell`,
              { elapsedMs: elapsed, stderr: stderrData.trim() }
            );
            this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          this.safeLog("❌ Windows fast-paste error, falling back to nircmd/PowerShell", {
            elapsedMs: Date.now() - startTime,
            error: error.message,
          });
          this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          this.safeLog("⏱️ Windows fast-paste timeout, falling back to nircmd/PowerShell");
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          this.pasteWithNircmdOrPowerShell(originalClipboard).then(resolve).catch(reject);
        }, 2000);
      }, PASTE_DELAYS.win32_fast);
    });
  }

  async pasteWithNircmdOrPowerShell(originalClipboard) {
    const nircmdPath = this.getNircmdPath();
    if (nircmdPath) {
      return this.pasteWithNircmd(nircmdPath, originalClipboard);
    }
    return this.pasteWithPowerShell(originalClipboard);
  }

  async pasteWithNircmd(nircmdPath, originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteDelay = PASTE_DELAYS.win32_nircmd;
      const restoreDelay = RESTORE_DELAYS.win32_nircmd;

      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog(`⚡ nircmd paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn(nircmdPath, ["sendkeypress", "ctrl+v"]);

        let errorOutput = "";

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            this.safeLog(`✅ nircmd paste success`, {
              elapsedMs: elapsed,
              restoreDelayMs: restoreDelay,
            });
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
              this.safeLog("🔄 Clipboard restored");
            }, restoreDelay);
            resolve();
          } else {
            this.safeLog(`❌ nircmd failed (code ${code}), falling back to PowerShell`, {
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ nircmd error, falling back to PowerShell`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ nircmd timeout, falling back to PowerShell`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          this.pasteWithPowerShell(originalClipboard).then(resolve).catch(reject);
        }, 2000);
      }, pasteDelay);
    });
  }

  async pasteWithPowerShell(originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteDelay = PASTE_DELAYS.win32_pwsh;
      const restoreDelay = RESTORE_DELAYS.win32_pwsh;

      setTimeout(() => {
        let hasTimedOut = false;
        const startTime = Date.now();

        this.safeLog(`🪟 PowerShell paste starting (delay: ${pasteDelay}ms)`);

        const pasteProcess = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.SendKeys]::SendWait('^v')",
        ]);

        let errorOutput = "";

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (code === 0) {
            this.safeLog(`✅ PowerShell paste success`, {
              elapsedMs: elapsed,
              restoreDelayMs: restoreDelay,
            });
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
              this.safeLog("🔄 Clipboard restored");
            }, restoreDelay);
            resolve();
          } else {
            this.safeLog(`❌ PowerShell paste failed`, {
              code,
              elapsedMs: elapsed,
              stderr: errorOutput,
            });
            reject(
              new Error(
                `Windows paste failed with code ${code}. Text is copied to clipboard - please paste manually with Ctrl+V.`
              )
            );
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          const elapsed = Date.now() - startTime;
          this.safeLog(`❌ PowerShell paste error`, {
            elapsedMs: elapsed,
            error: error.message,
          });
          reject(
            new Error(
              `Windows paste failed: ${error.message}. Text is copied to clipboard - please paste manually with Ctrl+V.`
            )
          );
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          const elapsed = Date.now() - startTime;
          this.safeLog(`⏱️ PowerShell paste timeout`, { elapsedMs: elapsed });
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          reject(
            new Error(
              "Paste operation timed out. Text is copied to clipboard - please paste manually with Ctrl+V."
            )
          );
        }, 5000);
      }, pasteDelay);
    });
  }

  async pasteLinux(originalClipboard, options = {}) {
    const { isWayland, xwaylandAvailable, isGnome, isKde, isWlroots } = getLinuxSessionInfo();
    const webContents = options.webContents;
    const xdotoolExists = this.commandExists("xdotool");
    const wtypeExists = this.commandExists("wtype");
    const ydotoolExists = this.commandExists("ydotool");
    const ydotoolDaemonRunning = ydotoolExists && this._isYdotoolDaemonRunning();
    const linuxFastPaste = this.resolveLinuxFastPasteBinary();

    debugLogger.debug(
      "Linux paste environment",
      {
        isWayland,
        xwaylandAvailable,
        isGnome,
        isKde,
        isWlroots,
        linuxFastPaste: !!linuxFastPaste,
        canAccessUinput: this._canAccessUinput(),
        xdotoolExists,
        wtypeExists,
        ydotoolExists,
        ydotoolDaemonRunning,
        display: process.env.DISPLAY,
        waylandDisplay: process.env.WAYLAND_DISPLAY,
        xdgSessionType: process.env.XDG_SESSION_TYPE,
        xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      },
      "clipboard"
    );

    const restoreClipboard = () => {
      setTimeout(() => {
        if (isWayland) {
          this._writeClipboardWayland(originalClipboard, webContents);
        } else {
          clipboard.writeText(originalClipboard);
        }
      }, RESTORE_DELAYS.linux);
    };

    const terminalClasses = [
      "konsole",
      "gnome-terminal",
      "terminal",
      "kitty",
      "alacritty",
      "terminator",
      "xterm",
      "urxvt",
      "rxvt",
      "tilix",
      "terminology",
      "wezterm",
      "foot",
      "st",
      "yakuake",
      "ghostty",
      "guake",
      "tilda",
      "hyper",
      "tabby",
      "sakura",
      "warp",
      "termius",
    ];

    // Pre-detect the target window BEFORE our window takes focus or blurs,
    // so the fast-paste binary and fallback tools know where to send keystrokes.
    const preDetectTargetWindow = () => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) return null;
      try {
        const result = spawnSync("xdotool", ["getactivewindow"]);
        return result.status === 0 ? result.stdout.toString().trim() || null : null;
      } catch {
        return null;
      }
    };

    const preDetectWindowClass = (windowId) => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) return null;
      try {
        const args = windowId
          ? ["getwindowclassname", windowId]
          : ["getactivewindow", "getwindowclassname"];
        const result = spawnSync("xdotool", args);
        return result.status === 0 ? result.stdout.toString().toLowerCase().trim() || null : null;
      } catch {
        return null;
      }
    };

    const targetWindowId = preDetectTargetWindow();
    const xdotoolWindowClass = preDetectWindowClass(targetWindowId);

    if (linuxFastPaste) {
      const earlyIsTerminal = xdotoolWindowClass
        ? terminalClasses.some((t) => xdotoolWindowClass.includes(t))
        : false;

      const spawnFastPaste = (args, label) =>
        new Promise((resolve, reject) => {
          debugLogger.debug(
            `Attempting native linux-fast-paste (${label})`,
            { linuxFastPaste, args, targetWindowId, xdotoolWindowClass, earlyIsTerminal },
            "clipboard"
          );
          const proc = spawn(linuxFastPaste, args);
          let stderr = "";

          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          let timedOut = false;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            killProcess(proc, "SIGKILL");
          }, 2000);

          proc.on("close", (code) => {
            if (timedOut) return reject(new Error("linux-fast-paste timed out"));
            clearTimeout(timeoutId);
            if (code === 0) {
              resolve();
            } else {
              reject(
                new Error(
                  `linux-fast-paste exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                )
              );
            }
          });

          proc.on("error", (error) => {
            if (timedOut) return;
            clearTimeout(timeoutId);
            reject(error);
          });
        });

      if (isWayland) {
        const uinputArgs = ["--uinput"];
        if (earlyIsTerminal) uinputArgs.push("--terminal");

        try {
          await spawnFastPaste(uinputArgs, "uinput");
          this.safeLog("✅ Paste successful using native linux-fast-paste (uinput)");
          debugLogger.info(
            "Paste successful",
            { tool: "linux-fast-paste", method: "uinput" },
            "clipboard"
          );
          restoreClipboard();
          return;
        } catch (uinputError) {
          debugLogger.warn("uinput paste failed", { error: uinputError?.message }, "clipboard");

          if (xwaylandAvailable) {
            const xtestArgs = [];
            if (targetWindowId) xtestArgs.push("--window", targetWindowId);
            if (earlyIsTerminal) xtestArgs.push("--terminal");

            try {
              await spawnFastPaste(xtestArgs, "XTest/XWayland fallback");
              this.safeLog("✅ Paste successful using native linux-fast-paste (XTest/XWayland)");
              debugLogger.info(
                "Paste successful",
                { tool: "linux-fast-paste", method: "xtest-xwayland" },
                "clipboard"
              );
              restoreClipboard();
              return;
            } catch (xtestError) {
              debugLogger.warn(
                "XTest/XWayland fallback also failed",
                { error: xtestError?.message },
                "clipboard"
              );
            }
          }

          this.safeLog(
            `⚠️ Native linux-fast-paste failed: ${uinputError?.message || uinputError}, falling back to system tools`
          );
        }
      } else {
        const xtestArgs = [];
        if (targetWindowId) xtestArgs.push("--window", targetWindowId);
        if (earlyIsTerminal) xtestArgs.push("--terminal");

        try {
          await spawnFastPaste(xtestArgs, "XTest");
          this.safeLog("✅ Paste successful using native linux-fast-paste (XTest)");
          debugLogger.info(
            "Paste successful",
            { tool: "linux-fast-paste", method: "xtest" },
            "clipboard"
          );
          restoreClipboard();
          return;
        } catch (error) {
          this.safeLog(
            `⚠️ Native linux-fast-paste failed: ${error?.message || error}, falling back to system tools`
          );
          debugLogger.warn(
            "Native linux-fast-paste failed, falling back",
            { error: error?.message },
            "clipboard"
          );
        }
      }
    }

    // Terminals use Ctrl+Shift+V instead of Ctrl+V
    const isTerminal = () => {
      if (xdotoolWindowClass) {
        const isTerminalWindow = terminalClasses.some((term) => xdotoolWindowClass.includes(term));
        if (isTerminalWindow) {
          this.safeLog(`🖥️ Terminal detected via xdotool: ${xdotoolWindowClass}`);
        }
        return isTerminalWindow;
      }

      try {
        if (this.commandExists("kdotool")) {
          const windowIdResult = spawnSync("kdotool", ["getactivewindow"]);
          if (windowIdResult.status === 0) {
            const windowId = windowIdResult.stdout.toString().trim();
            const classResult = spawnSync("kdotool", ["getwindowclassname", windowId]);
            if (classResult.status === 0) {
              const className = classResult.stdout.toString().toLowerCase().trim();
              const isTerminalWindow = terminalClasses.some((term) => className.includes(term));
              if (isTerminalWindow) {
                this.safeLog(`🖥️ Terminal detected via kdotool: ${className}`);
              }
              return isTerminalWindow;
            }
          }
        }
      } catch {}
      return false;
    };

    const inTerminal = isTerminal();
    const pasteKeys = inTerminal ? "ctrl+shift+v" : "ctrl+v";

    const canUseWtype = isWayland && isWlroots;
    const canUseYdotool = ydotoolDaemonRunning;
    const canUseXdotool = isWayland ? xwaylandAvailable && xdotoolExists : xdotoolExists;

    // windowactivate ensures the target window (not ours) receives the keystroke
    const xdotoolArgs = targetWindowId
      ? ["windowactivate", "--sync", targetWindowId, "key", pasteKeys]
      : ["key", pasteKeys];

    if (targetWindowId) {
      this.safeLog(
        `🎯 Targeting window ID ${targetWindowId} for paste (class: ${xdotoolWindowClass})`
      );
    }

    // Raw keycodes work across both ydotool 0.1.x and 1.0.x (key names silently fail on 1.0.x)
    // 29 = KEY_LEFTCTRL, 42 = KEY_LEFTSHIFT, 47 = KEY_V
    const ydotoolArgs = inTerminal
      ? ["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
      : ["key", "29:1", "47:1", "47:0", "29:0"];

    const wtypeEntry = canUseWtype
      ? [
          inTerminal
            ? {
                cmd: "wtype",
                args: ["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
              }
            : { cmd: "wtype", args: ["-M", "ctrl", "-k", "v", "-m", "ctrl"] },
        ]
      : [];
    const xdotoolEntry = canUseXdotool ? [{ cmd: "xdotool", args: xdotoolArgs }] : [];
    const ydotoolEntry = canUseYdotool ? [{ cmd: "ydotool", args: ydotoolArgs }] : [];

    // Compositor-aware priority ordering
    let candidates;
    if (!isWayland) {
      // X11: xdotool is native and needs no daemon; ydotool as fallback
      candidates = [...xdotoolEntry, ...ydotoolEntry];
    } else if (isWlroots) {
      // wlroots (Sway, Hyprland, etc.): wtype is native; then xdotool for XWayland; ydotool last
      candidates = [...wtypeEntry, ...xdotoolEntry, ...ydotoolEntry];
    } else {
      // GNOME, KDE, or unknown Wayland: ydotool (uinput) works for all windows; xdotool for XWayland only
      candidates = [...ydotoolEntry, ...xdotoolEntry, ...wtypeEntry];
    }

    const available = candidates.filter((c) => this.commandExists(c.cmd));

    debugLogger.debug(
      "Available paste tools",
      {
        candidateTools: candidates.map((c) => c.cmd),
        availableTools: available.map((c) => c.cmd),
        targetWindowId,
        xdotoolWindowClass,
        inTerminal,
        pasteKeys,
      },
      "clipboard"
    );

    const pasteWith = (tool) =>
      new Promise((resolve, reject) => {
        const delay = isWayland ? 0 : PASTE_DELAYS.linux;

        setTimeout(() => {
          debugLogger.debug(
            "Attempting paste",
            {
              cmd: tool.cmd,
              args: tool.args,
              delay,
              isWayland,
            },
            "clipboard"
          );

          const proc = spawn(tool.cmd, tool.args);
          let stderr = "";
          let stdout = "";

          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          proc.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          let timedOut = false;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            killProcess(proc, "SIGKILL");
            debugLogger.warn(
              "Paste tool timed out",
              {
                cmd: tool.cmd,
                timeoutMs: 2000,
              },
              "clipboard"
            );
          }, 2000);

          proc.on("close", (code) => {
            if (timedOut) return reject(new Error(`Paste with ${tool.cmd} timed out`));
            clearTimeout(timeoutId);

            if (code === 0) {
              debugLogger.debug("Paste successful", { cmd: tool.cmd }, "clipboard");
              restoreClipboard();
              resolve();
            } else {
              debugLogger.error(
                "Paste command failed",
                {
                  cmd: tool.cmd,
                  args: tool.args,
                  exitCode: code,
                  stderr: stderr.trim(),
                  stdout: stdout.trim(),
                },
                "clipboard"
              );
              reject(
                new Error(
                  `${tool.cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                )
              );
            }
          });

          proc.on("error", (error) => {
            if (timedOut) return;
            clearTimeout(timeoutId);
            debugLogger.error(
              "Paste command spawn error",
              {
                cmd: tool.cmd,
                error: error.message,
                code: error.code,
              },
              "clipboard"
            );
            reject(error);
          });
        }, delay);
      });

    const failedAttempts = [];
    for (const tool of available) {
      try {
        await pasteWith(tool);
        this.safeLog(`✅ Paste successful using ${tool.cmd}`);
        debugLogger.info("Paste successful", { tool: tool.cmd }, "clipboard");
        return;
      } catch (error) {
        const failureInfo = {
          tool: tool.cmd,
          args: tool.args,
          error: error?.message || String(error),
        };
        failedAttempts.push(failureInfo);
        this.safeLog(`⚠️ Paste with ${tool.cmd} failed:`, error?.message || error);
        debugLogger.warn("Paste tool failed, trying next", failureInfo, "clipboard");
      }
    }

    debugLogger.error("All paste tools failed", { failedAttempts }, "clipboard");

    // xdotool type fallback for terminals where Ctrl+Shift+V simulation fails
    if (inTerminal && xdotoolExists && !isWayland) {
      debugLogger.debug(
        "Trying xdotool type fallback for terminal",
        {
          textLength: clipboard.readText().length,
          targetWindowId,
        },
        "clipboard"
      );
      this.safeLog("🔄 Trying xdotool type fallback for terminal...");
      const textToType = clipboard.readText();
      const typeArgs = targetWindowId
        ? ["windowactivate", "--sync", targetWindowId, "type", "--clearmodifiers", "--", textToType]
        : ["type", "--clearmodifiers", "--", textToType];

      try {
        await pasteWith({ cmd: "xdotool", args: typeArgs });
        this.safeLog("✅ Paste successful using xdotool type fallback");
        debugLogger.info("Terminal paste successful via xdotool type", {}, "clipboard");
        return;
      } catch (error) {
        const fallbackFailure = {
          tool: "xdotool type",
          args: typeArgs,
          error: error?.message || String(error),
        };
        failedAttempts.push(fallbackFailure);
        this.safeLog(`⚠️ xdotool type fallback failed:`, error?.message || error);
        debugLogger.warn("xdotool type fallback failed", fallbackFailure, "clipboard");
      }
    }

    const failureSummary =
      failedAttempts.length > 0
        ? `\n\nAttempted tools: ${failedAttempts.map((f) => `${f.tool} (${f.error})`).join(", ")}`
        : "";

    let errorMsg;
    if (isWayland) {
      if (isGnome || isKde) {
        if (!xwaylandAvailable && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires xdotool (with XWayland) or ydotool (with ydotoold daemon running). Please paste manually with Ctrl+V.";
        } else if (!xdotoolExists && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting requires xdotool (recommended) or ydotool. Please install xdotool or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed. Please paste manually with Ctrl+V.";
        }
      } else if (isWlroots) {
        if (!wtypeExists && !xdotoolExists && !ydotoolDaemonRunning) {
          errorMsg =
            "Clipboard copied, but automatic pasting requires wtype (recommended for your compositor) or xdotool. Please install one or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed. Please paste manually with Ctrl+V.";
        }
      } else {
        errorMsg =
          "Clipboard copied, but paste simulation failed on Wayland. Please install xdotool or paste manually with Ctrl+V.";
      }
    } else {
      errorMsg =
        "Clipboard copied, but paste simulation failed on X11. Please install xdotool or paste manually with Ctrl+V.";
    }

    if (ydotoolExists && !ydotoolDaemonRunning) {
      errorMsg +=
        "\n\nNote: ydotool is installed but the ydotoold daemon is not running. Start it with: sudo systemctl enable --now ydotool";
    }

    const err = new Error(errorMsg + failureSummary);
    err.code = "PASTE_SIMULATION_FAILED";
    err.failedAttempts = failedAttempts;
    debugLogger.error(
      "Throwing paste simulation failed error",
      {
        errorMsg,
        failedAttempts,
        isWayland,
        isGnome,
        isKde,
        isWlroots,
      },
      "clipboard"
    );
    throw err;
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") return true;

    const now = Date.now();
    if (now < this.accessibilityCache.expiresAt && this.accessibilityCache.value !== null) {
      return this.accessibilityCache.value;
    }

    const allowed = systemPreferences.isTrustedAccessibilityClient(false);
    this.accessibilityCache = {
      value: allowed,
      expiresAt: Date.now() + ACCESSIBILITY_CHECK_TTL_MS,
    };

    if (!allowed) {
      this.showAccessibilityDialog("not allowed assistive access");
    }

    return allowed;
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 OpenWhispr needs Accessibility permissions, but it looks like you may have OLD PERMISSIONS from a previous version.

❗ COMMON ISSUE: If you've rebuilt/reinstalled OpenWhispr, the old permissions may be "stuck" and preventing new ones.

🔧 To fix this:
1. Open System Settings → Privacy & Security → Accessibility
2. Look for ANY old "OpenWhispr" entries and REMOVE them (click the - button)
3. Also remove any entries that say "Electron" or have unclear names
4. Click the + button and manually add the NEW OpenWhispr app
5. Make sure the checkbox is enabled
6. Restart OpenWhispr

⚠️ This is especially common during development when rebuilding the app.

📝 Without this permission, text will only copy to clipboard (no automatic pasting).

Would you like to open System Settings now?`;
    } else {
      dialogMessage = `🔒 OpenWhispr needs Accessibility permissions to paste text into other applications.

📋 Current status: Clipboard copy works, but pasting (Cmd+V simulation) fails.

🔧 To fix this:
1. Open System Settings (or System Preferences on older macOS)
2. Go to Privacy & Security → Accessibility
3. Click the lock icon and enter your password
4. Add OpenWhispr to the list and check the box
5. Restart OpenWhispr

⚠️ Without this permission, dictated text will only be copied to clipboard but won't paste automatically.

💡 In production builds, this permission is required for full functionality.

Would you like to open System Settings now?`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"Cancel", "Open System Settings"} default button "Open System Settings"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", () => {});
  }

  openSystemSettings() {
    const settingsCommands = [
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {});
        });
      }
    };

    tryNextCommand();
  }

  preWarmAccessibility() {
    if (process.platform === "linux") {
      this.resolveLinuxFastPasteBinary();
      return;
    }
    if (process.platform !== "darwin") return;
    this.checkAccessibilityPermissions().catch(() => {});
    this.resolveFastPasteBinary();
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async writeClipboard(text, webContents = null) {
    if (process.platform === "linux" && this._isWayland()) {
      this._writeClipboardWayland(text, webContents);
    } else {
      clipboard.writeText(text);
    }
    return { success: true };
  }

  checkPasteTools() {
    const platform = process.platform;

    if (platform === "darwin") {
      const fastPaste = this.resolveFastPasteBinary();
      return {
        platform: "darwin",
        available: true,
        method: fastPaste ? "cgevent" : "applescript",
        requiresPermission: true,
        tools: [],
      };
    }

    if (platform === "win32") {
      const winFastPaste = this.resolveWindowsFastPasteBinary();
      return {
        platform: "win32",
        available: true,
        method: winFastPaste ? "sendinput" : "powershell",
        requiresPermission: false,
        terminalAware: !!winFastPaste,
        tools: [],
      };
    }

    const { isWayland, xwaylandAvailable, isGnome, isKde, isWlroots } = getLinuxSessionInfo();
    const linuxFastPaste = this.resolveLinuxFastPasteBinary();
    const hasNativeBinary = !!linuxFastPaste;

    const tools = [];
    const canUseWtype = isWayland && isWlroots;
    const canUseYdotool = this.commandExists("ydotool") && this._isYdotoolDaemonRunning();
    const canUseXdotool = !isWayland || xwaylandAvailable;

    if (!isWayland) {
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
    } else if (isWlroots) {
      if (canUseWtype && this.commandExists("wtype")) tools.push("wtype");
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
    } else {
      if (canUseXdotool && this.commandExists("xdotool")) tools.push("xdotool");
      if (canUseYdotool) tools.push("ydotool");
      if (canUseWtype && this.commandExists("wtype")) tools.push("wtype");
    }

    const hasUinput = this._canAccessUinput();
    const nativeBinaryUsable = hasNativeBinary && (!isWayland || hasUinput || xwaylandAvailable);
    const available = nativeBinaryUsable || tools.length > 0;
    let recommendedInstall;
    if (!nativeBinaryUsable && tools.length === 0) {
      if (!isWayland) {
        recommendedInstall = "xdotool";
      } else if (isWlroots) {
        recommendedInstall = "wtype";
      } else {
        recommendedInstall = "xdotool";
      }
    } else if (isWayland && hasNativeBinary && !hasUinput && tools.length === 0) {
      recommendedInstall = "usermod -aG input $USER";
    }

    return {
      platform: "linux",
      available,
      method: nativeBinaryUsable
        ? isWayland && hasUinput
          ? "uinput"
          : "xtest"
        : available
          ? tools[0]
          : null,
      requiresPermission: false,
      isWayland,
      xwaylandAvailable,
      hasNativeBinary,
      hasUinput,
      tools,
      recommendedInstall,
    };
  }
}

module.exports = ClipboardManager;
