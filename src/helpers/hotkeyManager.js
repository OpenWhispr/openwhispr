const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");

// Delay to ensure localStorage is accessible after window load
const HOTKEY_REGISTRATION_DELAY_MS = 1000;

// Right-side single modifiers are handled by native listeners, not globalShortcut
const RIGHT_SIDE_MODIFIER_PATTERN =
  /^Right(Control|Ctrl|Alt|Option|Shift|Command|Cmd|Super|Meta|Win)$/i;

function isRightSideModifier(hotkey) {
  return RIGHT_SIDE_MODIFIER_PATTERN.test(hotkey);
}

// Suggested alternative hotkeys when registration fails
const SUGGESTED_HOTKEYS = {
  single: ["F8", "F9", "F10", "Pause", "ScrollLock"],
  compound: ["Control+Super", "Control+Alt", "Control+Shift+Space", "Alt+F7"],
};

class HotkeyManager {
  constructor() {
    this.currentHotkey = process.platform === "darwin" ? "GLOBE" : "Control+Super";
    this.isInitialized = false;
    this.isListeningMode = false;
    this.gnomeManager = null;
    this.useGnome = false;
    this.hotkeyCallback = null;
  }

  setListeningMode(enabled) {
    this.isListeningMode = enabled;
    debugLogger.log(`[HotkeyManager] Listening mode: ${enabled ? "enabled" : "disabled"}`);
  }

  isInListeningMode() {
    return this.isListeningMode;
  }

  getFailureReason(hotkey) {
    if (globalShortcut.isRegistered(hotkey)) {
      return {
        reason: "already_registered",
        message: `"${hotkey}" is already registered by another application.`,
        suggestions: this.getSuggestions(hotkey),
      };
    }

    if (process.platform === "linux" || process.platform === "win32") {
      // Linux DE's often reserve Super/Meta combinations
      // Windows reserves Win (Super/Meta) key combinations for OS shortcuts
      if (hotkey.includes("Super") || hotkey.includes("Meta")) {
        return {
          reason: "os_reserved",
          message: `"${hotkey}" may be reserved by your ${process.platform === "win32" ? "operating system" : "desktop environment"}.`,
          suggestions: this.getSuggestions(hotkey),
        };
      }
    }

    return {
      reason: "registration_failed",
      message: `Could not register "${hotkey}". It may be in use by another application.`,
      suggestions: this.getSuggestions(hotkey),
    };
  }

  getSuggestions(failedHotkey) {
    const isCompound = failedHotkey.includes("+");
    let suggestions = isCompound ? [...SUGGESTED_HOTKEYS.compound] : [...SUGGESTED_HOTKEYS.single];

    if (process.platform === "darwin" && isCompound) {
      suggestions = ["Control+Alt", "Alt+Command", "Command+Shift+Space"];
    } else if (process.platform === "win32" && isCompound) {
      suggestions = ["Control+Alt", "Control+Shift+K", "Control+Shift+Space"];
    } else if (process.platform === "linux" && isCompound) {
      suggestions = ["Control+Super", "Control+Shift+K", "Super+Shift+R"];
    }

    return suggestions.filter((s) => s !== failedHotkey).slice(0, 3);
  }

  setupShortcuts(hotkey = "Control+Super", callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey setup");
    }

    debugLogger.log(`[HotkeyManager] Setting up hotkey: "${hotkey}"`);
    debugLogger.log(`[HotkeyManager] Platform: ${process.platform}, Arch: ${process.arch}`);
    debugLogger.log(`[HotkeyManager] Current hotkey: "${this.currentHotkey}"`);

    // If we're already using this hotkey AND it's actually registered, return success
    // Note: We need to check isRegistered because on first run, currentHotkey is set to the
    // default value but it's not actually registered yet.
    const checkAccelerator = hotkey.startsWith("Fn+") ? hotkey.slice(3) : hotkey;
    try {
      if (
        hotkey === this.currentHotkey &&
        hotkey !== "GLOBE" &&
        !isRightSideModifier(hotkey) &&
        globalShortcut.isRegistered(checkAccelerator)
      ) {
        debugLogger.log(
          `[HotkeyManager] Hotkey "${hotkey}" is already the current hotkey and registered, no change needed`
        );
        return { success: true, hotkey };
      }
    } catch {
      // Invalid accelerator string (e.g. "Control+Super" on Windows) — fall through to re-register
      debugLogger.log(`[HotkeyManager] isRegistered check failed for "${checkAccelerator}", will attempt fresh registration`);
    }

    // Unregister the previous hotkey (skip GLOBE and right-side modifiers - they use native listeners)
    if (
      this.currentHotkey &&
      this.currentHotkey !== "GLOBE" &&
      !isRightSideModifier(this.currentHotkey)
    ) {
      const prevAccelerator = this.currentHotkey.startsWith("Fn+")
        ? this.currentHotkey.slice(3)
        : this.currentHotkey;
      debugLogger.log(`[HotkeyManager] Unregistering previous hotkey: "${prevAccelerator}"`);
      try {
        globalShortcut.unregister(prevAccelerator);
      } catch {
        debugLogger.log(`[HotkeyManager] Could not unregister "${prevAccelerator}" (invalid accelerator)`);
      }
    }

    try {
      if (hotkey === "GLOBE") {
        if (process.platform !== "darwin") {
          debugLogger.log("[HotkeyManager] GLOBE key rejected - not on macOS");
          return {
            success: false,
            error: "The Globe key is only available on macOS.",
          };
        }
        this.currentHotkey = hotkey;
        debugLogger.log("[HotkeyManager] GLOBE key set successfully");
        return { success: true, hotkey };
      }

      // Right-side single modifiers are handled by native listeners (Swift/C), not globalShortcut
      if (isRightSideModifier(hotkey)) {
        this.currentHotkey = hotkey;
        debugLogger.log(
          `[HotkeyManager] Right-side modifier "${hotkey}" set - using native listener`
        );
        return { success: true, hotkey };
      }

      // Fn+ prefix is a UI-level distinction (user holds Fn to get real F-keys on macOS).
      // At the OS/Electron level, the accelerator is just the key without Fn.
      const accelerator = hotkey.startsWith("Fn+") ? hotkey.slice(3) : hotkey;

      const alreadyRegistered = globalShortcut.isRegistered(accelerator);
      debugLogger.log(
        `[HotkeyManager] Is "${accelerator}" already registered? ${alreadyRegistered}`
      );

      if (process.platform === "linux") {
        globalShortcut.unregister(accelerator);
      }

      const success = globalShortcut.register(accelerator, callback);
      debugLogger.log(`[HotkeyManager] Registration result for "${hotkey}": ${success}`);

      if (success) {
        this.currentHotkey = hotkey;
        debugLogger.log(`[HotkeyManager] Hotkey "${hotkey}" registered successfully`);
        return { success: true, hotkey };
      } else {
        const failureInfo = this.getFailureReason(accelerator);
        console.error(`[HotkeyManager] Failed to register hotkey: ${hotkey}`, failureInfo);
        debugLogger.log(`[HotkeyManager] Registration failed:`, failureInfo);

        let errorMessage = failureInfo.message;
        if (failureInfo.suggestions.length > 0) {
          errorMessage += ` Try: ${failureInfo.suggestions.join(", ")}`;
        }

        return {
          success: false,
          error: errorMessage,
          reason: failureInfo.reason,
          suggestions: failureInfo.suggestions,
        };
      }
    } catch (error) {
      console.error("[HotkeyManager] Error setting up shortcuts:", error);
      debugLogger.log(`[HotkeyManager] Exception during registration:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async initializeGnomeShortcuts(callback) {
    if (process.platform !== "linux" || !GnomeShortcutManager.isWayland()) {
      return false;
    }

    if (GnomeShortcutManager.isGnome()) {
      try {
        this.gnomeManager = new GnomeShortcutManager();

        const dbusOk = await this.gnomeManager.initDBusService(callback);
        if (dbusOk) {
          this.useGnome = true;
          this.hotkeyCallback = callback;
          return true;
        }
      } catch (err) {
        debugLogger.log("[HotkeyManager] GNOME shortcut init failed:", err.message);
        this.gnomeManager = null;
        this.useGnome = false;
      }
    }

    return false;
  }

  async initializeHotkey(mainWindow, callback) {
    if (!mainWindow || !callback) {
      throw new Error("mainWindow and callback are required");
    }

    this.mainWindow = mainWindow;
    this.hotkeyCallback = callback;

    if (process.platform === "linux" && GnomeShortcutManager.isWayland()) {
      const gnomeOk = await this.initializeGnomeShortcuts(callback);

      if (gnomeOk) {
        const registerGnomeHotkey = async () => {
          try {
            const savedHotkey = await mainWindow.webContents.executeJavaScript(`
              localStorage.getItem("dictationKey") || ""
            `);
            const hotkey = savedHotkey && savedHotkey.trim() !== "" ? savedHotkey : "Control+Super";
            const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);

            const success = await this.gnomeManager.registerKeybinding(gnomeHotkey);
            if (success) {
              this.currentHotkey = hotkey;
              debugLogger.log(`[HotkeyManager] GNOME hotkey "${hotkey}" registered successfully`);
            } else {
              debugLogger.log("[HotkeyManager] GNOME keybinding failed, falling back to X11");
              this.useGnome = false;
              this.loadSavedHotkeyOrDefault(mainWindow, callback);
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] GNOME keybinding failed, falling back to X11:",
              err.message
            );
            this.useGnome = false;
            this.loadSavedHotkeyOrDefault(mainWindow, callback);
          }
        };

        setTimeout(registerGnomeHotkey, HOTKEY_REGISTRATION_DELAY_MS);
        this.isInitialized = true;
        return;
      }
    }

    if (process.platform === "linux") {
      globalShortcut.unregisterAll();
    }

    setTimeout(() => {
      this.loadSavedHotkeyOrDefault(mainWindow, callback);
    }, HOTKEY_REGISTRATION_DELAY_MS);

    this.isInitialized = true;
  }

  async loadSavedHotkeyOrDefault(mainWindow, callback) {
    try {
      // First check file-based storage (environment variable) - more reliable
      let savedHotkey = process.env.DICTATION_KEY || "";

      // Fall back to localStorage if env var is empty
      if (!savedHotkey) {
        savedHotkey = await mainWindow.webContents.executeJavaScript(`
          localStorage.getItem("dictationKey") || ""
        `);

        // If we found a hotkey in localStorage but not in env, migrate it
        if (savedHotkey && savedHotkey.trim() !== "") {
          process.env.DICTATION_KEY = savedHotkey;
          debugLogger.log(
            `[HotkeyManager] Migrated hotkey "${savedHotkey}" from localStorage to env`
          );
        }
      }

      if (savedHotkey && savedHotkey.trim() !== "") {
        const result = this.setupShortcuts(savedHotkey, callback);
        if (result.success) {
          debugLogger.log(`[HotkeyManager] Restored saved hotkey: "${savedHotkey}"`);
          return;
        }
        debugLogger.log(`[HotkeyManager] Saved hotkey "${savedHotkey}" failed to register`);
        this.notifyHotkeyFailure(savedHotkey, result);
      }

      const defaultHotkey = process.platform === "darwin" ? "GLOBE" : "Control+Super";

      if (defaultHotkey === "GLOBE") {
        this.currentHotkey = "GLOBE";
        debugLogger.log("[HotkeyManager] Using GLOBE key as default on macOS");
        return;
      }

      const result = this.setupShortcuts(defaultHotkey, callback);
      if (result.success) {
        debugLogger.log(
          `[HotkeyManager] Default hotkey "${defaultHotkey}" registered successfully`
        );
        return;
      }

      debugLogger.log(
        `[HotkeyManager] Default hotkey "${defaultHotkey}" failed, trying fallbacks...`
      );
      const fallbackHotkeys = ["F8", "F9", "Control+Shift+Space"];

      for (const fallback of fallbackHotkeys) {
        const fallbackResult = this.setupShortcuts(fallback, callback);
        if (fallbackResult.success) {
          debugLogger.log(`[HotkeyManager] Fallback hotkey "${fallback}" registered successfully`);
          await this.saveHotkeyToRenderer(fallback);
          this.notifyHotkeyFallback(defaultHotkey, fallback);
          return;
        }
      }

      debugLogger.log("[HotkeyManager] All hotkey fallbacks failed");
      this.notifyHotkeyFailure(defaultHotkey, result);
    } catch (err) {
      console.error("Failed to initialize hotkey:", err);
      debugLogger.error("[HotkeyManager] Failed to initialize hotkey:", err.message);
    }
  }

  async saveHotkeyToRenderer(hotkey) {
    // Escape the hotkey string to prevent injection issues
    const escapedHotkey = hotkey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    // Save to environment variable for file-based persistence (more reliable)
    process.env.DICTATION_KEY = hotkey;

    // Persist to .env file for reliable startup
    try {
      // Lazy require to avoid circular dependencies
      const EnvironmentManager = require("./environment");
      const envManager = new EnvironmentManager();
      envManager.saveAllKeysToEnvFile();
      debugLogger.log(`[HotkeyManager] Saved hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to persist hotkey to .env file:", err.message);
    }

    // Also save to localStorage for backwards compatibility
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        await this.mainWindow.webContents.executeJavaScript(
          `localStorage.setItem("dictationKey", "${escapedHotkey}"); true;`
        );
        debugLogger.log(`[HotkeyManager] Saved hotkey "${hotkey}" to localStorage`);
        return true;
      } catch (err) {
        debugLogger.error("[HotkeyManager] Failed to save hotkey to localStorage:", err.message);
        return false;
      }
    } else {
      debugLogger.warn(
        "[HotkeyManager] Main window not available for saving hotkey to localStorage"
      );
      return false;
    }
  }

  notifyHotkeyFallback(originalHotkey, fallbackHotkey) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-fallback-used", {
        original: originalHotkey,
        fallback: fallbackHotkey,
        message: `The "${originalHotkey}" key was unavailable. Using "${fallbackHotkey}" instead. You can change this in Settings.`,
      });
    }
  }

  notifyHotkeyFailure(hotkey, result) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-registration-failed", {
        hotkey,
        error: result?.error || `Could not register "${hotkey}"`,
        suggestions: result?.suggestions || ["F8", "F9", "Control+Shift+Space"],
      });
    }
  }

  async updateHotkey(hotkey, callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey update");
    }

    try {
      if (this.useGnome && this.gnomeManager) {
        debugLogger.log(`[HotkeyManager] Updating GNOME hotkey to "${hotkey}"`);
        const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);
        const success = await this.gnomeManager.updateKeybinding(gnomeHotkey);
        if (!success) {
          return {
            success: false,
            message: `Failed to update GNOME hotkey to "${hotkey}". Check the format is valid.`,
          };
        }
        this.currentHotkey = hotkey;
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] GNOME hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${hotkey} (via GNOME native shortcut)`,
        };
      }

      const result = this.setupShortcuts(hotkey, callback);
      if (result.success) {
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hotkey registered but failed to persist to localStorage"
          );
        }
        return { success: true, message: `Hotkey updated to: ${hotkey}` };
      } else {
        return {
          success: false,
          message: result.error,
          suggestions: result.suggestions,
        };
      }
    } catch (error) {
      debugLogger.error("[HotkeyManager] Failed to update hotkey:", error.message);
      return {
        success: false,
        message: `Failed to update hotkey: ${error.message}`,
      };
    }
  }

  getCurrentHotkey() {
    return this.currentHotkey;
  }

  unregisterAll() {
    if (this.gnomeManager) {
      this.gnomeManager.unregisterKeybinding().catch((err) => {
        debugLogger.warn("[HotkeyManager] Error unregistering GNOME keybinding:", err.message);
      });
      this.gnomeManager.close();
      this.gnomeManager = null;
      this.useGnome = false;
    }
    globalShortcut.unregisterAll();
  }

  isUsingGnome() {
    return this.useGnome;
  }

  isHotkeyRegistered(hotkey) {
    return globalShortcut.isRegistered(hotkey);
  }
}

module.exports = HotkeyManager;
