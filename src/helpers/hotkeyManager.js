const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const { i18nMain } = require("./i18nMain");

// Delay to ensure localStorage is accessible after window load
const HOTKEY_REGISTRATION_DELAY_MS = 1000;

// Right-side single modifiers are handled by native listeners, not globalShortcut
const RIGHT_SIDE_MODIFIER_PATTERN =
  /^Right(Control|Ctrl|Alt|Option|Shift|Command|Cmd|Super|Meta|Win)$/i;

function isRightSideModifier(hotkey) {
  return RIGHT_SIDE_MODIFIER_PATTERN.test(hotkey);
}

// Modifier-only combos (e.g. "Control+Super") bypass globalShortcut on Windows
// and use the native low-level keyboard hook instead.
const MODIFIER_NAMES = new Set([
  "control",
  "ctrl",
  "alt",
  "option",
  "shift",
  "super",
  "meta",
  "win",
  "command",
  "cmd",
  "commandorcontrol",
  "cmdorctrl",
]);

function isModifierOnlyHotkey(hotkey) {
  if (!hotkey || !hotkey.includes("+")) return false;
  return hotkey.split("+").every((part) => MODIFIER_NAMES.has(part.toLowerCase()));
}

function normalizeToAccelerator(hotkey) {
  let accelerator = hotkey.startsWith("Fn+") ? hotkey.slice(3) : hotkey;
  accelerator = accelerator
    .replace(/\bRight(Command|Cmd)\b/g, "Command")
    .replace(/\bRight(Control|Ctrl)\b/g, "Control")
    .replace(/\bRight(Alt|Option)\b/g, "Alt")
    .replace(/\bRightShift\b/g, "Shift");
  return accelerator;
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
        message: i18nMain.t("hotkey.errors.alreadyRegistered", { hotkey }),
        suggestions: this.getSuggestions(hotkey),
      };
    }

    if (process.platform === "linux") {
      // Linux DE's often reserve Super/Meta combinations
      if (hotkey.includes("Super") || hotkey.includes("Meta")) {
        return {
          reason: "os_reserved",
          message: i18nMain.t("hotkey.errors.osReserved", { hotkey }),
          suggestions: this.getSuggestions(hotkey),
        };
      }
    }

    return {
      reason: "registration_failed",
      message: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
      suggestions: this.getSuggestions(hotkey),
    };
  }

  getSuggestions(failedHotkey) {
    const isCompound = failedHotkey.includes("+");
    let suggestions = isCompound ? [...SUGGESTED_HOTKEYS.compound] : [...SUGGESTED_HOTKEYS.single];

    if (process.platform === "darwin" && isCompound) {
      suggestions = ["Control+Alt", "Alt+Command", "Command+Shift+Space"];
    } else if (process.platform === "win32" && isCompound) {
      suggestions = ["Control+Super", "Control+Alt", "Control+Shift+K"];
    } else if (process.platform === "linux" && isCompound) {
      suggestions = ["Control+Super", "Control+Shift+K", "Super+Shift+R"];
    }

    return suggestions.filter((s) => s !== failedHotkey).slice(0, 3);
  }

  setupShortcuts(hotkey = "Control+Super", callback) {
    if (!callback) {
      throw new Error(i18nMain.t("hotkey.errors.callbackRequired"));
    }

    debugLogger.log(`[HotkeyManager] Setting up hotkey: "${hotkey}"`);
    debugLogger.log(`[HotkeyManager] Platform: ${process.platform}, Arch: ${process.arch}`);
    debugLogger.log(`[HotkeyManager] Current hotkey: "${this.currentHotkey}"`);

    // If we're already using this hotkey AND it's actually registered, return success
    // Note: We need to check isRegistered because on first run, currentHotkey is set to the
    // default value but it's not actually registered yet.
    const checkAccelerator = normalizeToAccelerator(hotkey);
    if (
      hotkey === this.currentHotkey &&
      hotkey !== "GLOBE" &&
      !isRightSideModifier(hotkey) &&
      !isModifierOnlyHotkey(hotkey) &&
      globalShortcut.isRegistered(checkAccelerator)
    ) {
      debugLogger.log(
        `[HotkeyManager] Hotkey "${hotkey}" is already the current hotkey and registered, no change needed`
      );
      return { success: true, hotkey };
    }

    const previousHotkey = this.currentHotkey;

    // Unregister the previous hotkey (skip native-listener-only hotkeys)
    if (
      this.currentHotkey &&
      this.currentHotkey !== "GLOBE" &&
      !isRightSideModifier(this.currentHotkey) &&
      !isModifierOnlyHotkey(this.currentHotkey)
    ) {
      const prevAccelerator = normalizeToAccelerator(this.currentHotkey);
      try {
        debugLogger.log(`[HotkeyManager] Unregistering previous hotkey: "${prevAccelerator}"`);
        globalShortcut.unregister(prevAccelerator);
      } catch (error) {
        debugLogger.warn(
          `[HotkeyManager] Skipping previous hotkey unregister for non-accelerator "${prevAccelerator}": ${error.message}`
        );
      }
    }

    try {
      if (hotkey === "GLOBE") {
        if (process.platform !== "darwin") {
          debugLogger.log("[HotkeyManager] GLOBE key rejected - not on macOS");
          return {
            success: false,
            error: i18nMain.t("hotkey.errors.globeOnlyMac"),
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

      // Modifier-only combos use the native keyboard hook on Windows
      if (isModifierOnlyHotkey(hotkey) && process.platform === "win32") {
        this.currentHotkey = hotkey;
        debugLogger.log(
          `[HotkeyManager] Modifier-only "${hotkey}" set - using Windows native listener`
        );
        return { success: true, hotkey };
      }

      const accelerator = normalizeToAccelerator(hotkey);

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
        debugLogger.error("Failed to register hotkey", { error: hotkey, ...failureInfo }, "hotkey");
        debugLogger.log(`[HotkeyManager] Registration failed:`, failureInfo);

        this._restorePreviousHotkey(previousHotkey, callback);

        let errorMessage = failureInfo.message;
        if (failureInfo.suggestions.length > 0) {
          errorMessage += ` ${i18nMain.t("hotkey.errors.trySuggestions", {
            suggestions: failureInfo.suggestions.join(", "),
          })}`;
        }

        return {
          success: false,
          error: errorMessage,
          reason: failureInfo.reason,
          suggestions: failureInfo.suggestions,
        };
      }
    } catch (error) {
      debugLogger.error("Error setting up shortcuts", { error: error.message }, "hotkey");
      debugLogger.log(`[HotkeyManager] Exception during registration:`, error.message);
      this._restorePreviousHotkey(previousHotkey, callback);
      return { success: false, error: error.message };
    }
  }

  _restorePreviousHotkey(previousHotkey, callback) {
    if (
      !previousHotkey ||
      previousHotkey === "GLOBE" ||
      isRightSideModifier(previousHotkey) ||
      isModifierOnlyHotkey(previousHotkey)
    ) {
      return;
    }
    const prevAccel = normalizeToAccelerator(previousHotkey);
    try {
      const restored = globalShortcut.register(prevAccel, callback);
      if (restored) {
        debugLogger.log(
          `[HotkeyManager] Restored previous hotkey "${previousHotkey}" after failed registration`
        );
      } else {
        debugLogger.warn(`[HotkeyManager] Could not restore previous hotkey "${previousHotkey}"`);
      }
    } catch (err) {
      debugLogger.warn(
        `[HotkeyManager] Exception restoring previous hotkey "${previousHotkey}": ${err.message}`
      );
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

        // If we found a hotkey in localStorage but not in env, migrate it to .env file
        if (savedHotkey && savedHotkey.trim() !== "") {
          debugLogger.log(
            `[HotkeyManager] Migrating hotkey "${savedHotkey}" from localStorage to .env`
          );
          await this._persistHotkeyToEnvFile(savedHotkey);
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
        await this._persistHotkeyToEnvFile("GLOBE");
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
      debugLogger.error("Failed to initialize hotkey", { error: err.message }, "hotkey");
    }
  }

  async _persistHotkeyToEnvFile(hotkey) {
    process.env.DICTATION_KEY = hotkey;
    try {
      const EnvironmentManager = require("./environment");
      const envManager = new EnvironmentManager();
      await envManager.saveAllKeysToEnvFile();
      debugLogger.log(`[HotkeyManager] Persisted hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to persist hotkey to .env file:", err.message);
    }
  }

  async saveHotkeyToRenderer(hotkey) {
    const escapedHotkey = hotkey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    await this._persistHotkeyToEnvFile(hotkey);

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
module.exports.isModifierOnlyHotkey = isModifierOnlyHotkey;
module.exports.isRightSideModifier = isRightSideModifier;
