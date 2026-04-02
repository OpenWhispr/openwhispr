const { globalShortcut } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const KDEShortcutManager = require("./kdeShortcut");
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

function isGlobeLikeHotkey(hotkey) {
  return hotkey === "GLOBE" || hotkey === "Fn";
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
    this.slots = new Map();
    const defaultDictation = process.platform === "darwin" ? "GLOBE" : "Control+Super";
    this.slots.set("dictation", { hotkey: defaultDictation, callback: null, accelerator: null });
    this.isInitialized = false;
    this.isListeningMode = false;
    this.gnomeManager = null;
    this.useGnome = false;
    this.hyprlandManager = null;
    this.useHyprland = false;
    this.kdeManager = null;
    this.useKDE = false;
  }

  // Backward-compatible property accessors
  get currentHotkey() {
    return this.slots.get("dictation")?.hotkey ?? null;
  }

  set currentHotkey(value) {
    const slot = this.slots.get("dictation") || { hotkey: null, callback: null, accelerator: null };
    slot.hotkey = value;
    this.slots.set("dictation", slot);
  }

  get hotkeyCallback() {
    return this.slots.get("dictation")?.callback ?? null;
  }

  set hotkeyCallback(value) {
    const slot = this.slots.get("dictation") || { hotkey: null, callback: null, accelerator: null };
    slot.callback = value;
    this.slots.set("dictation", slot);
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

  async registerSlot(slotName, hotkey, callback) {
    this.unregisterSlot(slotName);

    // On GNOME Wayland, route non-dictation slots (e.g. "agent") through the
    // native GNOME keybinding system instead of Electron's globalShortcut,
    // which does not work under the Wayland security model.
    if (this.useGnome && this.gnomeManager && slotName !== "dictation") {
      const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);
      if (!gnomeHotkey) {
        debugLogger.log(
          `[HotkeyManager] Could not convert hotkey "${hotkey}" to GNOME format for slot "${slotName}"`
        );
        return { success: false, error: `Invalid hotkey format for GNOME: "${hotkey}"` };
      }

      // Register (or update) the agent callback on the shared D-Bus interface
      if (slotName === "agent") {
        this.gnomeManager.setAgentCallback(callback);
      }

      const success = await this.gnomeManager.registerKeybinding(gnomeHotkey, slotName);
      if (!success) {
        debugLogger.log(
          `[HotkeyManager] GNOME keybinding registration failed for slot "${slotName}" ("${hotkey}")`
        );
        return {
          success: false,
          error: `Failed to register GNOME hotkey "${hotkey}" for ${slotName}`,
        };
      }

      const slot = this.slots.get(slotName) || { hotkey: null, callback: null, accelerator: null };
      slot.hotkey = hotkey;
      slot.callback = callback;
      slot.accelerator = null;
      this.slots.set(slotName, slot);

      debugLogger.log(
        `[HotkeyManager] GNOME slot "${slotName}" set to "${hotkey}" (GNOME format: "${gnomeHotkey}")`
      );
      return { success: true, hotkey };
    }

    // On KDE Wayland, route all slots through KGlobalAccel D-Bus
    if (this.useKDE && this.kdeManager) {
      if (slotName === "agent") {
        this.kdeManager.setAgentCallback(callback);
      }

      const success = await this.kdeManager.registerKeybinding(hotkey, slotName, callback);
      if (!success) {
        debugLogger.log(
          `[HotkeyManager] KDE keybinding registration failed for slot "${slotName}" ("${hotkey}")`
        );
        return {
          success: false,
          error: `Failed to register KDE hotkey "${hotkey}" for ${slotName}`,
        };
      }

      const slot = this.slots.get(slotName) || { hotkey: null, callback: null, accelerator: null };
      slot.hotkey = hotkey;
      slot.callback = callback;
      slot.accelerator = null;
      this.slots.set(slotName, slot);

      debugLogger.log(`[HotkeyManager] KDE slot "${slotName}" set to "${hotkey}"`);
      return { success: true, hotkey };
    }

    const result = this.setupShortcuts(hotkey, callback, slotName);
    if (result.success) {
      const slot = this.slots.get(slotName) || {};
      slot.callback = callback;
      this.slots.set(slotName, slot);
    }
    return result;
  }

  unregisterSlot(slotName) {
    const slot = this.slots.get(slotName);
    if (!slot || !slot.hotkey) return;

    // On KDE Wayland, all slots are managed via KGlobalAccel
    if (this.useKDE && this.kdeManager) {
      this.kdeManager.unregisterKeybinding(slotName).catch((err) => {
        debugLogger.warn(
          `[HotkeyManager] Error unregistering KDE keybinding for slot "${slotName}":`,
          err.message
        );
      });
      slot.hotkey = null;
      slot.accelerator = null;
      return;
    }

    // On GNOME Wayland, non-dictation slots are managed via gsettings, not globalShortcut
    if (this.useGnome && this.gnomeManager && slotName !== "dictation") {
      this.gnomeManager.unregisterKeybinding(slotName).catch((err) => {
        debugLogger.warn(
          `[HotkeyManager] Error unregistering GNOME keybinding for slot "${slotName}":`,
          err.message
        );
      });
      slot.hotkey = null;
      slot.accelerator = null;
      return;
    }

    const hk = slot.hotkey;
    if (!isGlobeLikeHotkey(hk) && !isRightSideModifier(hk) && !isModifierOnlyHotkey(hk)) {
      const accel = normalizeToAccelerator(hk);
      try {
        globalShortcut.unregister(accel);
      } catch {
        // already unregistered
      }
    }
    slot.hotkey = null;
    slot.accelerator = null;
  }

  getSlotHotkey(slotName) {
    return this.slots.get(slotName)?.hotkey ?? null;
  }

  setupShortcuts(hotkey = "Control+Super", callback, slotName = "dictation") {
    if (!callback) {
      throw new Error(i18nMain.t("hotkey.errors.callbackRequired"));
    }

    const slot = this.slots.get(slotName) || { hotkey: null, callback: null, accelerator: null };
    this.slots.set(slotName, slot);

    debugLogger.log(`[HotkeyManager] Setting up hotkey: "${hotkey}" for slot "${slotName}"`);
    debugLogger.log(`[HotkeyManager] Platform: ${process.platform}, Arch: ${process.arch}`);
    debugLogger.log(`[HotkeyManager] Current hotkey for slot: "${slot.hotkey}"`);

    const checkAccelerator = normalizeToAccelerator(hotkey);
    if (
      hotkey === slot.hotkey &&
      !isGlobeLikeHotkey(hotkey) &&
      !isRightSideModifier(hotkey) &&
      !isModifierOnlyHotkey(hotkey) &&
      globalShortcut.isRegistered(checkAccelerator)
    ) {
      debugLogger.log(
        `[HotkeyManager] Hotkey "${hotkey}" is already registered for slot "${slotName}", no change needed`
      );
      return { success: true, hotkey };
    }

    const previousHotkey = slot.hotkey;

    // Unregister the previous hotkey for this slot (skip native-listener-only hotkeys)
    if (
      previousHotkey &&
      !isGlobeLikeHotkey(previousHotkey) &&
      !isRightSideModifier(previousHotkey) &&
      !isModifierOnlyHotkey(previousHotkey)
    ) {
      const prevAccelerator = normalizeToAccelerator(previousHotkey);
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
      const conflict = this._findSlotConflict(slotName, hotkey);
      if (conflict) return conflict;

      if (isGlobeLikeHotkey(hotkey)) {
        if (process.platform !== "darwin") {
          debugLogger.log("[HotkeyManager] GLOBE key rejected - not on macOS");
          return {
            success: false,
            error: i18nMain.t("hotkey.errors.globeOnlyMac"),
          };
        }
        slot.hotkey = hotkey;
        slot.accelerator = null;
        debugLogger.log(`[HotkeyManager] GLOBE/Fn key "${hotkey}" set successfully`);
        return { success: true, hotkey };
      }

      if (isRightSideModifier(hotkey)) {
        slot.hotkey = hotkey;
        slot.accelerator = null;
        debugLogger.log(
          `[HotkeyManager] Right-side modifier "${hotkey}" set - using native listener`
        );
        return { success: true, hotkey };
      }

      if (isModifierOnlyHotkey(hotkey) && process.platform === "win32") {
        slot.hotkey = hotkey;
        slot.accelerator = null;
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
        slot.hotkey = hotkey;
        slot.accelerator = accelerator;
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

  _findSlotConflict(slotName, hotkey) {
    const accelerator =
      isGlobeLikeHotkey(hotkey) || isRightSideModifier(hotkey) || isModifierOnlyHotkey(hotkey)
        ? null
        : normalizeToAccelerator(hotkey);

    for (const [otherSlotName, otherSlot] of this.slots) {
      if (otherSlotName === slotName) continue;
      const match =
        otherSlot.hotkey === hotkey || (accelerator && otherSlot.accelerator === accelerator);
      if (match) {
        debugLogger.warn(
          `[HotkeyManager] Hotkey "${hotkey}" conflicts with slot "${otherSlotName}"`
        );
        return {
          success: false,
          error: i18nMain.t("hotkey.errors.slotConflict", {
            slot: otherSlotName,
            defaultValue: `This hotkey is already used for ${otherSlotName}`,
          }),
          reason: "slot_conflict",
          conflictSlot: otherSlotName,
        };
      }
    }
    return null;
  }

  _restorePreviousHotkey(previousHotkey, callback) {
    if (
      !previousHotkey ||
      isGlobeLikeHotkey(previousHotkey) ||
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

  async initializeKDEShortcuts(callback) {
    if (
      process.platform !== "linux" ||
      !KDEShortcutManager.isWayland() ||
      !KDEShortcutManager.isKDE()
    ) {
      return false;
    }

    try {
      this.kdeManager = new KDEShortcutManager();
      const ok = await this.kdeManager.init();
      if (ok) {
        this.useKDE = true;
        this.hotkeyCallback = callback;
        debugLogger.log("[HotkeyManager] KDE Wayland shortcuts initialized via KGlobalAccel D-Bus");
        return true;
      }
    } catch (err) {
      debugLogger.log("[HotkeyManager] KDE shortcut init failed:", err.message);
      this.kdeManager = null;
      this.useKDE = false;
    }

    return false;
  }

  async initializeHyprlandShortcuts(callback) {
    const isLinux = process.platform === "linux";
    const isWayland = HyprlandShortcutManager.isWayland();
    const isHyprland = HyprlandShortcutManager.isHyprland();

    debugLogger.log("[HotkeyManager] Hyprland detection", {
      isLinux,
      isWayland,
      isHyprland,
      XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE || "(unset)",
      HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE ? "present" : "(unset)",
      XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP || "(unset)",
    });

    if (!isLinux || !isWayland) {
      return false;
    }

    if (isHyprland) {
      if (!HyprlandShortcutManager.isHyprctlAvailable()) {
        debugLogger.log("[HotkeyManager] Hyprland detected but hyprctl not available");
        return false;
      }

      try {
        this.hyprlandManager = new HyprlandShortcutManager();

        const dbusOk = await this.hyprlandManager.initDBusService(callback);
        debugLogger.log("[HotkeyManager] Hyprland D-Bus init result:", dbusOk);
        if (dbusOk) {
          this.useHyprland = true;
          this.hotkeyCallback = callback;
          return true;
        }
      } catch (err) {
        debugLogger.log("[HotkeyManager] Hyprland shortcut init failed:", err.message);
        this.hyprlandManager = null;
        this.useHyprland = false;
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

      // Try KDE native shortcuts via KGlobalAccel
      const kdeOk = await this.initializeKDEShortcuts(callback);

      if (kdeOk) {
        const registerKDEHotkey = async () => {
          try {
            const savedHotkey = await mainWindow.webContents.executeJavaScript(`
              localStorage.getItem("dictationKey") || ""
            `);
            const hotkey = savedHotkey && savedHotkey.trim() !== "" ? savedHotkey : "Control+Super";
            const success = await this.kdeManager.registerKeybinding(hotkey, "dictation", callback);
            if (success) {
              this.currentHotkey = hotkey;
              debugLogger.log(`[HotkeyManager] KDE hotkey "${hotkey}" registered successfully`);
            } else {
              debugLogger.log(
                "[HotkeyManager] KDE keybinding failed, falling back to globalShortcut"
              );
              this.kdeManager.close();
              this.kdeManager = null;
              this.useKDE = false;
              this.loadSavedHotkeyOrDefault(mainWindow, callback);
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] KDE keybinding failed, falling back to globalShortcut:",
              err.message
            );
            this.kdeManager?.close();
            this.kdeManager = null;
            this.useKDE = false;
            this.loadSavedHotkeyOrDefault(mainWindow, callback);
          }
        };

        setTimeout(registerKDEHotkey, HOTKEY_REGISTRATION_DELAY_MS);
        this.isInitialized = true;
        return;
      }

      // Try Hyprland native shortcuts if GNOME/KDE paths were not applicable
      const hyprlandOk = await this.initializeHyprlandShortcuts(callback);

      if (hyprlandOk) {
        const registerHyprlandHotkey = async () => {
          try {
            const savedHotkey = await mainWindow.webContents.executeJavaScript(`
              localStorage.getItem("dictationKey") || ""
            `);
            const hotkey = savedHotkey && savedHotkey.trim() !== "" ? savedHotkey : "Control+Super";

            const success = await this.hyprlandManager.registerKeybinding(hotkey);
            if (success) {
              this.currentHotkey = hotkey;
              debugLogger.log(
                `[HotkeyManager] Hyprland hotkey "${hotkey}" registered successfully`
              );
            } else {
              debugLogger.log(
                "[HotkeyManager] Hyprland keybinding failed, falling back to globalShortcut"
              );
              this.useHyprland = false;
              this.loadSavedHotkeyOrDefault(mainWindow, callback);
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] Hyprland keybinding failed, falling back to globalShortcut:",
              err.message
            );
            this.useHyprland = false;
            this.loadSavedHotkeyOrDefault(mainWindow, callback);
          }
        };

        setTimeout(registerHyprlandHotkey, HOTKEY_REGISTRATION_DELAY_MS);
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
    await this._persistHotkeyToEnvFile(hotkey);

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send("setting-updated", { key: "dictationKey", value: hotkey });
        debugLogger.log(`[HotkeyManager] Sent dictationKey update to main window`);
        return true;
      } catch (err) {
        debugLogger.error("[HotkeyManager] Failed to send dictationKey update:", err.message);
        return false;
      }
    } else {
      debugLogger.warn("[HotkeyManager] Main window not available for setting sync");
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
      const conflict = this._findSlotConflict("dictation", hotkey);
      if (conflict) {
        return { success: false, message: conflict.error, reason: conflict.reason };
      }

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

      if (this.useHyprland && this.hyprlandManager) {
        debugLogger.log(`[HotkeyManager] Updating Hyprland hotkey to "${hotkey}"`);
        const success = await this.hyprlandManager.updateKeybinding(hotkey);
        if (!success) {
          return {
            success: false,
            message: `Failed to update Hyprland hotkey to "${hotkey}". Check the format is valid.`,
          };
        }
        this.currentHotkey = hotkey;
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hyprland hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${hotkey} (via Hyprland native shortcut)`,
        };
      }

      if (this.useKDE && this.kdeManager) {
        debugLogger.log(`[HotkeyManager] Updating KDE hotkey to "${hotkey}"`);
        const success = await this.kdeManager.registerKeybinding(hotkey, "dictation", callback);
        if (!success) {
          return {
            success: false,
            message: `Failed to update KDE hotkey to "${hotkey}". Check the format is valid.`,
          };
        }
        this.currentHotkey = hotkey;
        const saved = await this.saveHotkeyToRenderer(hotkey);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] KDE hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${hotkey} (via KDE D-Bus shortcut)`,
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
      // Unregister every slot that was registered via GNOME
      const gnomeSlots = [...this.gnomeManager.registeredSlots];
      for (const slotName of gnomeSlots) {
        this.gnomeManager.unregisterKeybinding(slotName).catch((err) => {
          debugLogger.warn(
            `[HotkeyManager] Error unregistering GNOME keybinding for slot "${slotName}":`,
            err.message
          );
        });
      }
      this.gnomeManager.close();
      this.gnomeManager = null;
      this.useGnome = false;
    }
    if (this.kdeManager) {
      const kdeSlots = [...this.kdeManager.registeredSlots];
      for (const slotName of kdeSlots) {
        this.kdeManager.unregisterKeybinding(slotName).catch((err) => {
          debugLogger.warn(
            `[HotkeyManager] Error unregistering KDE keybinding for slot "${slotName}":`,
            err.message
          );
        });
      }
      this.kdeManager.close();
      this.kdeManager = null;
      this.useKDE = false;
    }
    if (this.hyprlandManager) {
      this.hyprlandManager.unregisterKeybinding().catch((err) => {
        debugLogger.warn("[HotkeyManager] Error unregistering Hyprland keybinding:", err.message);
      });
      this.hyprlandManager.close();
      this.hyprlandManager = null;
      this.useHyprland = false;
    }
    for (const slotName of this.slots.keys()) {
      const slot = this.slots.get(slotName);
      if (slot) {
        slot.hotkey = null;
        slot.accelerator = null;
      }
    }
    globalShortcut.unregisterAll();
  }

  isUsingGnome() {
    return this.useGnome;
  }

  isUsingHyprland() {
    return this.useHyprland;
  }

  isUsingKDE() {
    return this.useKDE;
  }

  isUsingNativeShortcut() {
    return this.useGnome || this.useHyprland || this.useKDE;
  }

  isHotkeyRegistered(hotkey) {
    return globalShortcut.isRegistered(hotkey);
  }
}

module.exports = HotkeyManager;
module.exports.isGlobeLikeHotkey = isGlobeLikeHotkey;
module.exports.isModifierOnlyHotkey = isModifierOnlyHotkey;
module.exports.isRightSideModifier = isRightSideModifier;
