const { clipboard, app } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { killProcess } = require("../utils/process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const CACHE_TTL_MS = 30000;

// macOS accessibility: once granted, permissions persist across app sessions,
// so use a long TTL. Denied results re-check quickly so granting takes effect fast.
const ACCESSIBILITY_GRANTED_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESSIBILITY_DENIED_TTL_MS = 5000;

const getLinuxDesktopEnv = () =>
  [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

const isGnomeDesktop = (desktopEnv) => desktopEnv.includes("gnome");

const getLinuxSessionInfo = () => {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const xwaylandAvailable = isWayland && !!process.env.DISPLAY;
  const desktopEnv = getLinuxDesktopEnv();
  const isGnome = isWayland && isGnomeDesktop(desktopEnv);

  return { isWayland, xwaylandAvailable, desktopEnv, isGnome };
};

// ms before simulating keystroke
const PASTE_DELAYS = {
  darwin: 120,
  win32_nircmd: 30,
  win32_pwsh: 40,
  linux: 50,
};

// ms after paste completes before restoring clipboard
const RESTORE_DELAYS = {
  darwin: 450,
  win32_nircmd: 80,
  win32_pwsh: 80,
  linux: 200,
};

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.commandAvailabilityCache = new Map();
    this.nircmdPath = null;
    this.nircmdChecked = false;
    this.fastPastePath = null;
    this.fastPasteChecked = false;
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
      } catch (error) {
        // Continue checking other paths
      }
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

  resolveFastPasteBinary() {
    if (this.fastPasteChecked) {
      return this.fastPastePath;
    }
    this.fastPasteChecked = true;

    if (process.platform !== "darwin") {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", "macos-fast-paste"),
      path.join(__dirname, "..", "..", "resources", "macos-fast-paste"),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, "macos-fast-paste"),
        path.join(process.resourcesPath, "bin", "macos-fast-paste"),
        path.join(process.resourcesPath, "resources", "macos-fast-paste"),
        path.join(process.resourcesPath, "resources", "bin", "macos-fast-paste"),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "macos-fast-paste"),
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "resources",
          "bin",
          "macos-fast-paste"
        ),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          this.fastPastePath = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
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

    try {
      const originalClipboard = clipboard.readText();
      this.safeLog(
        "💾 Saved original clipboard content:",
        originalClipboard.substring(0, 50) + "..."
      );

      clipboard.writeText(text);
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
        await this.pasteMacOS(originalClipboard, options);
      } else if (platform === "win32") {
        const nircmdPath = this.getNircmdPath();
        method = nircmdPath ? "nircmd" : "powershell";
        await this.pasteWindows(originalClipboard);
      } else {
        method = "linux-tools";
        await this.pasteLinux(originalClipboard);
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
              'tell application "System Events" to keystroke "v" using command down',
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
        'tell application "System Events" to keystroke "v" using command down',
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
    const nircmdPath = this.getNircmdPath();

    if (nircmdPath) {
      return this.pasteWithNircmd(nircmdPath, originalClipboard);
    } else {
      return this.pasteWithPowerShell(originalClipboard);
    }
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

  async pasteLinux(originalClipboard) {
    const { isWayland, xwaylandAvailable, isGnome } = getLinuxSessionInfo();
    const xdotoolExists = this.commandExists("xdotool");
    const wtypeExists = this.commandExists("wtype");
    const ydotoolExists = this.commandExists("ydotool");

    debugLogger.debug(
      "Linux paste environment",
      {
        isWayland,
        xwaylandAvailable,
        isGnome,
        xdotoolExists,
        wtypeExists,
        ydotoolExists,
        display: process.env.DISPLAY,
        waylandDisplay: process.env.WAYLAND_DISPLAY,
        xdgSessionType: process.env.XDG_SESSION_TYPE,
        xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      },
      "clipboard"
    );

    // Capture target window before our window takes focus
    const getXdotoolActiveWindow = () => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) {
        return null;
      }
      try {
        const result = spawnSync("xdotool", ["getactivewindow"]);
        if (result.status !== 0) {
          return null;
        }
        return result.stdout.toString().trim() || null;
      } catch {
        return null;
      }
    };

    const getXdotoolWindowClass = (windowId) => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) {
        return null;
      }
      try {
        const args = windowId
          ? ["getwindowclassname", windowId]
          : ["getactivewindow", "getwindowclassname"];
        const result = spawnSync("xdotool", args);
        if (result.status !== 0) {
          return null;
        }
        const className = result.stdout.toString().toLowerCase().trim();
        return className || null;
      } catch {
        return null;
      }
    };

    const targetWindowId = getXdotoolActiveWindow();
    const xdotoolWindowClass = getXdotoolWindowClass(targetWindowId);

    // Terminals use Ctrl+Shift+V instead of Ctrl+V
    const isTerminal = () => {
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
      ];

      // On GNOME Wayland, xdotool can't see native Wayland windows and returns
      // OpenWhispr's own window instead. Use AT-SPI2 accessibility API first,
      // which works for both native Wayland and XWayland windows.
      if (isGnome && isWayland) {
        try {
          const atspiScript = `import gi
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
d=Atspi.get_desktop(0)
skip={'gnome-shell',''}
for i in range(d.get_child_count()):
 a=d.get_child_at_index(i)
 if not a:continue
 n=a.get_name()
 if n.lower() in skip:continue
 for j in range(a.get_child_count()):
  w=a.get_child_at_index(j)
  if w and w.get_state_set().contains(Atspi.StateType.ACTIVE):
   print(n.lower());raise SystemExit(0)`;
          const result = spawnSync("python3", ["-c", atspiScript], {
            timeout: 1000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (result.status === 0) {
            const appName = result.stdout.toString().trim();
            if (appName) {
              const isTerminalWindow = terminalClasses.some((term) => appName.includes(term));
              this.safeLog(
                isTerminalWindow
                  ? `🖥️ Terminal detected via AT-SPI2: ${appName}`
                  : `🪟 Non-terminal detected via AT-SPI2: ${appName}`
              );
              return isTerminalWindow;
            }
          }
        } catch {
          // AT-SPI2 detection failed, continue to other methods
        }
      }

      // xdotool window class detection (reliable on X11 and for XWayland apps
      // on non-GNOME Wayland; skipped on GNOME Wayland where AT-SPI2 is used above)
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
      } catch {
        // Detection failed, assume non-terminal
      }
      return false;
    };

    const inTerminal = isTerminal();
    const pasteKeys = inTerminal ? "ctrl+shift+v" : "ctrl+v";

    const canUseWtype = isWayland && !isGnome;
    const canUseYdotool = isWayland;
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

    // ydotool key codes: 29=Ctrl, 42=Shift, 47=V; :1=press, :0=release
    const ydotoolArgs = inTerminal
      ? ["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"]
      : ["key", "29:1", "47:1", "47:0", "29:0"];

    // On GNOME Wayland, prefer ydotool over xdotool because xdotool can only
    // interact with XWayland windows and may target the wrong window (e.g. OpenWhispr
    // itself) while reporting success, preventing fallback to ydotool.
    // ydotool uses the regular ydotoolArgs which respects terminal detection:
    // Ctrl+Shift+V for detected terminals, Ctrl+V for everything else.
    const candidates = [
      ...(canUseWtype
        ? [
            inTerminal
              ? {
                  cmd: "wtype",
                  args: ["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
                }
              : { cmd: "wtype", args: ["-M", "ctrl", "-k", "v", "-m", "ctrl"] },
          ]
        : []),
      ...(isGnome && isWayland
        ? [
            ...(canUseYdotool ? [{ cmd: "ydotool", args: ydotoolArgs }] : []),
            ...(canUseXdotool ? [{ cmd: "xdotool", args: xdotoolArgs }] : []),
          ]
        : [
            ...(canUseXdotool ? [{ cmd: "xdotool", args: xdotoolArgs }] : []),
            ...(canUseYdotool ? [{ cmd: "ydotool", args: ydotoolArgs }] : []),
          ]),
    ];

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
              setTimeout(() => clipboard.writeText(originalClipboard), RESTORE_DELAYS.linux);
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
        return; // Success!
      } catch (error) {
        const failureInfo = {
          tool: tool.cmd,
          args: tool.args,
          error: error?.message || String(error),
        };
        failedAttempts.push(failureInfo);
        this.safeLog(`⚠️ Paste with ${tool.cmd} failed:`, error?.message || error);
        debugLogger.warn("Paste tool failed, trying next", failureInfo, "clipboard");
        // Continue to next tool
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
      const textToType = clipboard.readText(); // Read what we put in clipboard
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
      if (isGnome) {
        if (!xwaylandAvailable) {
          errorMsg =
            "Clipboard copied, but GNOME Wayland blocks automatic pasting. Please paste manually with Ctrl+V.";
        } else if (!xdotoolExists) {
          errorMsg =
            "Clipboard copied, but automatic pasting on GNOME Wayland requires xdotool for XWayland apps. Please install xdotool or paste manually with Ctrl+V.";
        } else if (!xdotoolWindowClass) {
          errorMsg =
            "Clipboard copied, but the active app isn't running under XWayland. Please paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed via XWayland. Please paste manually with Ctrl+V.";
        }
      } else if (!wtypeExists && !xdotoolExists) {
        if (!xwaylandAvailable) {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires wtype or xdotool. Please install one or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires xdotool (recommended for Electron/XWayland apps) or wtype. Please install one or paste manually with Ctrl+V.";
        }
      } else {
        const xdotoolNote =
          xwaylandAvailable && !xdotoolExists
            ? " Consider installing xdotool, which works well with Electron apps running under XWayland."
            : "";
        errorMsg =
          "Clipboard copied, but paste simulation failed on Wayland. Your compositor may not support the virtual keyboard protocol." +
          xdotoolNote +
          " Alternatively, paste manually with Ctrl+V.";
      }
    } else {
      errorMsg =
        "Clipboard copied, but paste simulation failed on X11. Please install xdotool or paste manually with Ctrl+V.";
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

    return new Promise((resolve) => {
      const testProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to get name of first process',
      ]);

      let testOutput = "";
      let testError = "";

      testProcess.stdout.on("data", (data) => {
        testOutput += data.toString();
      });

      testProcess.stderr.on("data", (data) => {
        testError += data.toString();
      });

      testProcess.on("close", (code) => {
        const allowed = code === 0;
        this.accessibilityCache = {
          value: allowed,
          expiresAt:
            Date.now() + (allowed ? ACCESSIBILITY_GRANTED_TTL_MS : ACCESSIBILITY_DENIED_TTL_MS),
        };
        if (!allowed) {
          this.showAccessibilityDialog(testError);
        }
        resolve(allowed);
      });

      testProcess.on("error", (error) => {
        this.accessibilityCache = {
          value: false,
          expiresAt: Date.now() + ACCESSIBILITY_DENIED_TTL_MS,
        };
        resolve(false);
      });
    });
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
    if (process.platform !== "darwin") return;
    this.checkAccessibilityPermissions().catch(() => {});
    this.resolveFastPasteBinary();
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async writeClipboard(text) {
    clipboard.writeText(text);
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
      return {
        platform: "win32",
        available: true,
        method: "powershell",
        requiresPermission: false,
        tools: [],
      };
    }

    const { isWayland, xwaylandAvailable, isGnome } = getLinuxSessionInfo();
    const tools = [];
    const canUseWtype = isWayland && !isGnome;
    const canUseYdotool = isWayland;
    const canUseXdotool = !isWayland || xwaylandAvailable;

    if (canUseWtype && this.commandExists("wtype")) {
      tools.push("wtype");
    }
    if (canUseXdotool && this.commandExists("xdotool")) {
      tools.push("xdotool");
    }
    if (canUseYdotool && this.commandExists("ydotool")) {
      tools.push("ydotool");
    }

    const available = tools.length > 0;
    let recommendedInstall;
    if (!available) {
      if (!isWayland) {
        recommendedInstall = "xdotool";
      } else if (isGnome) {
        recommendedInstall = xwaylandAvailable ? "xdotool" : undefined;
      } else {
        recommendedInstall = xwaylandAvailable ? "xdotool" : "wtype or xdotool";
      }
    }

    return {
      platform: "linux",
      available,
      method: available ? tools[0] : null,
      requiresPermission: false,
      isWayland,
      xwaylandAvailable,
      tools,
      recommendedInstall,
    };
  }
}

module.exports = ClipboardManager;
