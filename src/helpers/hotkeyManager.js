const EventEmitter = require("events");
const { globalShortcut, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const KDEShortcutManager = require("./kdeShortcut");
const { i18nMain } = require("./i18nMain");
const { parseHotkeyList } = require("./hotkeyList");

// Delay to ensure localStorage is accessible after window load
const HOTKEY_REGISTRATION_DELAY_MS = 1000;

// Fallback hotkeys tried when primary hotkey registration fails on startup
const FALLBACK_HOTKEYS = ["F8", "F9", "Control+Shift+Space"];

// Default hotkey for dictation if no saved value exists
const DEFAULT_HOTKEY = "Control+Super";

// Slots routed through GNOME native gsettings (not globalShortcut).
// Temporary slots like "cancel" stay on globalShortcut.
const GNOME_NATIVE_SLOTS = new Set(["agent", "meeting", "voiceAgent", "translation"]);

// KDE registration failure reasons — reuse existing i18n keys
const KDE_FAILURE_REASONS = {
  conflict: (hotkey) => i18nMain.t("hotkey.errors.alreadyRegistered", { hotkey }),
  "modifier-only": (hotkey) => i18nMain.t("hotkey.errors.osReserved", { hotkey }),
};

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

function isMouseButtonHotkey(hotkey) {
  return /^MouseButton[45]$/i.test(hotkey || "");
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

class HotkeyManager extends EventEmitter {
  constructor() {
    super();
    // Each slot holds a list of hotkeys (#936). `accelerators` mirrors `hotkeys`
    // index-for-index (null for native-listener entries).
    this.slots = new Map();
    const defaultDictation = process.platform === "darwin" ? "GLOBE" : "Control+Super";
    this.slots.set("dictation", { hotkeys: [defaultDictation], callback: null, accelerators: [] });
    this.isInitialized = false;
    this.isListeningMode = false;
    this.gnomeManager = null;
    this.useGnome = false;
    this.hyprlandManager = null;
    this.useHyprland = false;
    this.kdeManager = null;
    this.useKDE = false;
  }

  // Ensure a slot exists and return it (slots always use the list shape).
  _ensureSlot(slotName) {
    let slot = this.slots.get(slotName);
    if (!slot) {
      slot = { hotkeys: [], callback: null, accelerators: [] };
      this.slots.set(slotName, slot);
    }
    if (!Array.isArray(slot.hotkeys)) slot.hotkeys = [];
    if (!Array.isArray(slot.accelerators)) slot.accelerators = [];
    return slot;
  }

  // Primary (first) dictation hotkey; setting it replaces the whole list.
  get currentHotkey() {
    return this.slots.get("dictation")?.hotkeys?.[0] ?? null;
  }

  set currentHotkey(value) {
    const slot = this._ensureSlot("dictation");
    slot.hotkeys = value ? [value] : [];
    this.slots.set("dictation", slot);
  }

  get hotkeyCallback() {
    return this.slots.get("dictation")?.callback ?? null;
  }

  set hotkeyCallback(value) {
    const slot = this._ensureSlot("dictation");
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

  async registerSlot(slotName, hotkeyInput, callback, options) {
    const hotkeys = parseHotkeyList(hotkeyInput);
    if (hotkeys.length === 0) {
      return {
        success: false,
        error: i18nMain.t("hotkey.errors.registrationFailed", {
          hotkey: String(hotkeyInput ?? ""),
        }),
      };
    }
    // GNOME/KDE/Hyprland bind one accelerator per slot, so they use the primary
    // (first) hotkey; the globalShortcut path below registers the whole list.
    const hotkey = hotkeys[0];
    if (
      hotkeys.length > 1 &&
      ((this.useGnome && GNOME_NATIVE_SLOTS.has(slotName)) ||
        (this.useKDE && slotName !== "cancel"))
    ) {
      debugLogger.log(
        `[HotkeyManager] Slot "${slotName}" has ${hotkeys.length} hotkeys but this Linux desktop backend only applies the primary ("${hotkey}")`
      );
    }

    // On GNOME (X11 or Wayland), route named slots through native gsettings
    if (this.useGnome && this.gnomeManager && GNOME_NATIVE_SLOTS.has(slotName)) {
      const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);
      if (!gnomeHotkey) {
        debugLogger.log(
          `[HotkeyManager] Could not convert hotkey "${hotkey}" to GNOME format for slot "${slotName}"`
        );
        return {
          success: false,
          error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
        };
      }

      this.unregisterSlot(slotName);

      if (slotName === "agent") {
        this.gnomeManager.setAgentCallback(callback);
      } else if (slotName === "meeting") {
        this.gnomeManager.setMeetingCallback(callback);
      } else if (slotName === "voiceAgent") {
        this.gnomeManager.setVoiceAgentCallback(callback);
      } else if (slotName === "translation") {
        this.gnomeManager.setTranslationCallback(callback);
      }

      const success = await this.gnomeManager.registerKeybinding(gnomeHotkey, slotName);
      if (!success) {
        debugLogger.log(
          `[HotkeyManager] GNOME keybinding registration failed for slot "${slotName}" ("${hotkey}")`
        );
        return {
          success: false,
          error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
        };
      }

      const slot = this._ensureSlot(slotName);
      slot.hotkeys = [hotkey];
      slot.callback = callback;
      slot.accelerators = [];
      this.slots.set(slotName, slot);

      debugLogger.log(
        `[HotkeyManager] GNOME slot "${slotName}" set to "${hotkey}" (GNOME format: "${gnomeHotkey}")`
      );
      return { success: true, hotkey };
    }

    // On KDE (X11 or Wayland), route persistent slots through KGlobalAccel D-Bus.
    // Temporary slots like "cancel" stay on globalShortcut to avoid stale
    // KGlobalAccel registrations after crash (Escape would stop working system-wide).
    if (this.useKDE && this.kdeManager && slotName !== "cancel") {
      this.unregisterSlot(slotName);

      if (slotName === "agent") {
        this.kdeManager.setAgentCallback(callback);
      }

      const result = await this.kdeManager.registerKeybinding(hotkey, slotName, callback);
      if (result !== true) {
        const reason =
          KDE_FAILURE_REASONS[result]?.(hotkey) ||
          i18nMain.t("hotkey.errors.registrationFailed", { hotkey });
        debugLogger.log(
          `[HotkeyManager] KDE keybinding registration failed for slot "${slotName}" ("${hotkey}")`,
          { reason: result }
        );
        return { success: false, error: reason };
      }

      const slot = this._ensureSlot(slotName);
      slot.hotkeys = [hotkey];
      slot.callback = callback;
      slot.accelerators = [];
      this.slots.set(slotName, slot);

      debugLogger.log(`[HotkeyManager] KDE slot "${slotName}" set to "${hotkey}"`);
      return { success: true, hotkey };
    }

    const result = this.setupShortcuts(hotkeys, callback, slotName, options);
    if (result.success) {
      const slot = this._ensureSlot(slotName);
      slot.callback = callback;
      this.slots.set(slotName, slot);
    }
    return result;
  }

  unregisterSlot(slotName) {
    const slot = this.slots.get(slotName);
    if (!slot || !(slot.hotkeys && slot.hotkeys.length)) return;

    // On KDE (X11 or Wayland), persistent slots are managed via KGlobalAccel
    if (this.useKDE && this.kdeManager && slotName !== "cancel") {
      this.kdeManager.unregisterKeybinding(slotName).catch((err) => {
        debugLogger.warn(
          `[HotkeyManager] Error unregistering KDE keybinding for slot "${slotName}":`,
          err.message
        );
      });
      slot.hotkeys = [];
      slot.accelerators = [];
      return;
    }

    // On GNOME, native slots are managed via gsettings, not globalShortcut
    if (this.useGnome && this.gnomeManager && GNOME_NATIVE_SLOTS.has(slotName)) {
      this.gnomeManager.unregisterKeybinding(slotName).catch((err) => {
        debugLogger.warn(
          `[HotkeyManager] Error unregistering GNOME keybinding for slot "${slotName}":`,
          err.message
        );
      });
      slot.hotkeys = [];
      slot.accelerators = [];
      return;
    }

    for (const hk of slot.hotkeys || []) {
      if (
        !isGlobeLikeHotkey(hk) &&
        !isMouseButtonHotkey(hk) &&
        !isRightSideModifier(hk) &&
        !isModifierOnlyHotkey(hk)
      ) {
        const accel = normalizeToAccelerator(hk);
        try {
          globalShortcut.unregister(accel);
        } catch {
          // already unregistered
        }
      }
    }
    slot.hotkeys = [];
    slot.accelerators = [];
  }

  // Primary (first) hotkey for a slot — back-compat for callers that expect a
  // single value (display, GNOME/KDE native paths).
  getSlotHotkey(slotName) {
    return this.slots.get(slotName)?.hotkeys?.[0] ?? null;
  }

  // Full list of hotkeys bound to a slot.
  getSlotHotkeys(slotName) {
    return [...(this.slots.get(slotName)?.hotkeys ?? [])];
  }

  // True if `key` is one of the hotkeys bound to `slotName`.
  slotHasHotkey(slotName, key) {
    if (!key) return false;
    return (this.slots.get(slotName)?.hotkeys ?? []).includes(key);
  }

  // Name of the slot that owns `key`, or null. First match wins.
  findSlotByHotkey(key) {
    if (!key) return null;
    for (const [slotName, slot] of this.slots) {
      if ((slot.hotkeys ?? []).includes(key)) return slotName;
    }
    return null;
  }

  /**
   * Hotkeys that must be watched by a native low-level listener (Windows/Linux)
   * instead of globalShortcut. Modifier-only and right-side-modifier combos never
   * register through globalShortcut, and in push-to-talk mode dictation also needs
   * raw key-down/key-up events. Only the dictation slot supports push-to-talk;
   * every other slot is tap-to-toggle. Globe/mouse hotkeys are macOS-only.
   * Each slot may bind several hotkeys, so we evaluate every one.
   */
  getNativeListenerKeys(activationMode) {
    const keys = [];
    for (const [slotName, slot] of this.slots) {
      for (const hotkey of slot.hotkeys ?? []) {
        if (!hotkey || isGlobeLikeHotkey(hotkey) || isMouseButtonHotkey(hotkey)) continue;
        const pushToTalk = slotName === "dictation" && activationMode === "push";
        if (pushToTalk || isModifierOnlyHotkey(hotkey) || isRightSideModifier(hotkey)) {
          keys.push(hotkey);
        }
      }
    }
    return keys;
  }

  // Register one hotkey without mutating any slot. `accelerator` is null for
  // hotkeys handled by native listeners.
  _registerSingleHotkey(hotkey, callback) {
    try {
      if (isMouseButtonHotkey(hotkey)) {
        if (process.platform !== "darwin") {
          return { success: false, hotkey, error: i18nMain.t("hotkey.errors.mouseButtonOnlyMac") };
        }
        debugLogger.log(
          `[HotkeyManager] Mouse button "${hotkey}" set - using macOS native listener`
        );
        return { success: true, hotkey, accelerator: null };
      }

      if (isGlobeLikeHotkey(hotkey)) {
        if (process.platform !== "darwin") {
          debugLogger.log("[HotkeyManager] GLOBE key rejected - not on macOS");
          return { success: false, hotkey, error: i18nMain.t("hotkey.errors.globeOnlyMac") };
        }
        debugLogger.log(`[HotkeyManager] GLOBE/Fn key "${hotkey}" set successfully`);
        return { success: true, hotkey, accelerator: null };
      }

      if (isRightSideModifier(hotkey)) {
        debugLogger.log(
          `[HotkeyManager] Right-side modifier "${hotkey}" set - using native listener`
        );
        return { success: true, hotkey, accelerator: null };
      }

      if (isModifierOnlyHotkey(hotkey) && process.platform === "win32") {
        debugLogger.log(
          `[HotkeyManager] Modifier-only "${hotkey}" set - using Windows native listener`
        );
        return { success: true, hotkey, accelerator: null };
      }

      const accelerator = normalizeToAccelerator(hotkey);
      if (process.platform === "linux") {
        globalShortcut.unregister(accelerator);
      }

      // Pass the triggering hotkey so shared callbacks act on the one that fired.
      const success = globalShortcut.register(accelerator, () => callback(hotkey));
      debugLogger.log(`[HotkeyManager] Registration result for "${hotkey}": ${success}`);
      if (success) {
        return { success: true, hotkey, accelerator };
      }

      const failureInfo = this.getFailureReason(accelerator);
      debugLogger.error("Failed to register hotkey", { error: hotkey, ...failureInfo }, "hotkey");
      return {
        success: false,
        hotkey,
        error: failureInfo.message,
        reason: failureInfo.reason,
        suggestions: failureInfo.suggestions,
      };
    } catch (error) {
      debugLogger.error("Error setting up shortcut", { error: error.message }, "hotkey");
      return { success: false, hotkey, error: error.message };
    }
  }

  /**
   * Register a slot's hotkey list (string, comma-separated string, or array).
   * Default is best-effort: succeeds if at least one hotkey registers, with
   * individual failures in `result.failures`. `atomic: true` rolls the whole
   * slot back to its previous bindings on any failure.
   */
  setupShortcuts(
    hotkeyInput = "Control+Super",
    callback,
    slotName = "dictation",
    { atomic = false } = {}
  ) {
    if (!callback) {
      throw new Error(i18nMain.t("hotkey.errors.callbackRequired"));
    }

    const slot = this._ensureSlot(slotName);
    const desired = parseHotkeyList(hotkeyInput);

    debugLogger.log(
      `[HotkeyManager] Setting up hotkeys: "${desired.join(", ")}" for slot "${slotName}"`
    );
    debugLogger.log(`[HotkeyManager] Platform: ${process.platform}, Arch: ${process.arch}`);
    debugLogger.log(
      `[HotkeyManager] Current hotkeys for slot: "${(slot.hotkeys || []).join(", ")}"`
    );

    if (desired.length === 0) {
      return {
        success: false,
        error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: "" }),
      };
    }

    // Reject if any desired hotkey conflicts with another slot before tearing
    // down this slot's current registration.
    for (const hotkey of desired) {
      const conflict = this._findSlotConflict(slotName, hotkey);
      if (conflict) return conflict;
    }

    const previousHotkeys = [...(slot.hotkeys || [])];
    const previousAccelerators = [...(slot.accelerators || [])];

    // Unregister this slot's previous globalShortcut accelerators.
    for (const prevAccel of previousAccelerators) {
      if (!prevAccel) continue;
      try {
        debugLogger.log(`[HotkeyManager] Unregistering previous accelerator: "${prevAccel}"`);
        globalShortcut.unregister(prevAccel);
      } catch (error) {
        debugLogger.warn(
          `[HotkeyManager] Skipping previous unregister for "${prevAccel}": ${error.message}`
        );
      }
    }

    const registeredHotkeys = [];
    const registeredAccelerators = [];
    const failures = [];
    for (const hotkey of desired) {
      const res = this._registerSingleHotkey(hotkey, callback);
      if (res.success) {
        registeredHotkeys.push(res.hotkey);
        registeredAccelerators.push(res.accelerator ?? null);
      } else {
        failures.push(res);
      }
    }

    if (registeredHotkeys.length === 0 || (atomic && failures.length > 0)) {
      // Roll back: unregister anything we just registered, then restore the
      // previous bindings so the slot keeps working.
      registeredAccelerators.forEach((accel) => {
        if (!accel) return;
        try {
          globalShortcut.unregister(accel);
        } catch {
          // already unregistered
        }
      });
      this._restorePreviousHotkeys(previousHotkeys, previousAccelerators, callback);
      slot.hotkeys = previousHotkeys;
      slot.accelerators = previousAccelerators;

      const failureInfo = failures[0] || {};
      let errorMessage =
        failureInfo.error || i18nMain.t("hotkey.errors.registrationFailed", { hotkey: desired[0] });
      const suggestions = failureInfo.suggestions || [];
      if (suggestions.length > 0) {
        errorMessage += ` ${i18nMain.t("hotkey.errors.trySuggestions", {
          suggestions: suggestions.join(", "),
        })}`;
      }
      return { success: false, error: errorMessage, reason: failureInfo.reason, suggestions };
    }

    slot.hotkeys = registeredHotkeys;
    slot.accelerators = registeredAccelerators;
    slot.callback = callback;
    debugLogger.log(
      `[HotkeyManager] Slot "${slotName}" registered: "${registeredHotkeys.join(", ")}"`
    );

    const result = { success: true, hotkey: registeredHotkeys[0], hotkeys: registeredHotkeys };
    if (failures.length > 0) {
      result.failures = failures.map((f) => ({ hotkey: f.hotkey, error: f.error }));
    }
    return result;
  }

  _findSlotConflict(slotName, hotkey) {
    const accelerator =
      isGlobeLikeHotkey(hotkey) ||
      isMouseButtonHotkey(hotkey) ||
      isRightSideModifier(hotkey) ||
      isModifierOnlyHotkey(hotkey)
        ? null
        : normalizeToAccelerator(hotkey);

    for (const [otherSlotName, otherSlot] of this.slots) {
      if (otherSlotName === slotName) continue;
      const otherHotkeys = otherSlot.hotkeys || [];
      const otherAccelerators = otherSlot.accelerators || [];
      const match =
        otherHotkeys.includes(hotkey) || (accelerator && otherAccelerators.includes(accelerator));
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

  _restorePreviousHotkeys(previousHotkeys, previousAccelerators, callback) {
    (previousHotkeys || []).forEach((previousHotkey, i) => {
      // Native-listener entries (null accelerator) are re-armed by
      // reconcileNativeKeyListeners instead.
      const prevAccel = previousAccelerators?.[i];
      if (!prevAccel) return;
      try {
        const restored = globalShortcut.register(prevAccel, () => callback(previousHotkey));
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
    });
  }

  async initializeGnomeShortcuts(callback) {
    if (process.platform !== "linux" || !GnomeShortcutManager.isGnome()) {
      return false;
    }

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

    return false;
  }

  async initializeKDEShortcuts(callback) {
    if (process.platform !== "linux" || !KDEShortcutManager.isKDE()) {
      return false;
    }

    try {
      this.kdeManager = new KDEShortcutManager();
      const ok = await this.kdeManager.init();
      if (ok) {
        this.useKDE = true;
        this.hotkeyCallback = callback;
        debugLogger.log("[HotkeyManager] KDE shortcuts initialized via KGlobalAccel D-Bus");
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

    // Try GNOME native shortcuts on any GNOME session (X11 or Wayland).
    // On Wayland: required (globalShortcut/XGrabKey doesn't work globally).
    // On X11: provides conflict detection via gsettings, visible in GNOME Settings.
    if (process.platform === "linux" && GnomeShortcutManager.isGnome()) {
      const gnomeOk = await this.initializeGnomeShortcuts(callback);

      if (gnomeOk) {
        const registerGnomeHotkey = async () => {
          try {
            // DE backends bind one accelerator per slot — use the primary hotkey.
            const hotkey = parseHotkeyList(await this.getSavedHotkey())[0] || DEFAULT_HOTKEY;
            const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);

            const success = await this.gnomeManager.registerKeybinding(gnomeHotkey);
            if (success) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(`[HotkeyManager] GNOME hotkey "${hotkey}" registered successfully`);
            } else {
              const ok = await this.tryNativeFallbacks(hotkey, "GNOME", async (fb) => {
                const fbGnome = GnomeShortcutManager.convertToGnomeFormat(fb);
                return this.gnomeManager.registerKeybinding(fbGnome);
              });
              if (!ok) {
                this.useGnome = false;
                this.loadSavedHotkeyOrDefault(mainWindow, callback);
              }
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] GNOME keybinding failed, falling back to globalShortcut:",
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

    // Try Hyprland native shortcuts (Wayland only, non-GNOME)
    if (
      process.platform === "linux" &&
      HyprlandShortcutManager.isWayland() &&
      HyprlandShortcutManager.isHyprland()
    ) {
      const hyprlandOk = await this.initializeHyprlandShortcuts(callback);

      if (hyprlandOk) {
        const registerHyprlandHotkey = async () => {
          try {
            // DE backends bind one accelerator per slot — use the primary hotkey.
            const hotkey = parseHotkeyList(await this.getSavedHotkey())[0] || DEFAULT_HOTKEY;

            const success = await this.hyprlandManager.registerKeybinding(hotkey);
            if (success) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(
                `[HotkeyManager] Hyprland hotkey "${hotkey}" registered successfully`
              );
            } else {
              const ok = await this.tryNativeFallbacks(hotkey, "Hyprland", (fb) =>
                this.hyprlandManager.registerKeybinding(fb)
              );
              if (!ok) {
                this.useHyprland = false;
                this.loadSavedHotkeyOrDefault(mainWindow, callback);
              }
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
    // Falls through to KDE or globalShortcut below when GNOME/Hyprland/KDE are not applicable

    // Try KDE native shortcuts on any KDE session (X11 or Wayland)
    if (process.platform === "linux" && KDEShortcutManager.isKDE()) {
      const kdeOk = await this.initializeKDEShortcuts(callback);

      if (kdeOk) {
        const registerKDEHotkey = async () => {
          try {
            // DE backends bind one accelerator per slot — use the primary hotkey.
            const hotkey = parseHotkeyList(await this.getSavedHotkey())[0] || DEFAULT_HOTKEY;
            const result = await this.kdeManager.registerKeybinding(hotkey, "dictation", callback);
            if (result === true) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(`[HotkeyManager] KDE hotkey "${hotkey}" registered successfully`);
            } else if (result === "conflict" || result === "modifier-only") {
              const ok = await this.tryNativeFallbacks(hotkey, "KDE", (fb) =>
                this.kdeManager
                  .registerKeybinding(fb, "dictation", callback)
                  .then((r) => r === true)
              );
              if (!ok) {
                this.currentHotkey = hotkey;
                this.notifyHotkeyFailure(hotkey, {
                  error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
                });
              }
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
    }

    if (process.platform === "linux") {
      globalShortcut.unregisterAll();
    }

    // Register from env var immediately if available, otherwise wait for page load.
    const envHotkey = process.env.DICTATION_KEY || "";
    if (envHotkey) {
      const result = this.setupShortcuts(envHotkey, callback);
      if (result.success) {
        this._notifyStartupRegistration(envHotkey, result);
        debugLogger.log(`[HotkeyManager] Hotkey "${envHotkey}" registered from env`);
      } else {
        debugLogger.log(`[HotkeyManager] Env hotkey "${envHotkey}" failed, waiting for page`);
        this.loadSavedHotkeyOrDefault(mainWindow, callback);
      }
    } else {
      const loadHotkey = () => this.loadSavedHotkeyOrDefault(mainWindow, callback);
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once("did-finish-load", loadHotkey);
      } else {
        loadHotkey();
      }
    }

    this.isInitialized = true;
  }

  async loadSavedHotkeyOrDefault(mainWindow, callback) {
    try {
      // First check file-based storage (environment variable) - more reliable
      let savedHotkey = process.env.DICTATION_KEY || "";

      // Fall back to localStorage if env var is empty
      if (!savedHotkey) {
        try {
          savedHotkey = await mainWindow.webContents.executeJavaScript(`
            localStorage.getItem("dictationKey") || ""
          `);
        } catch (jsErr) {
          debugLogger.log(`[HotkeyManager] executeJavaScript failed: ${jsErr.message}`);
          savedHotkey = "";
        }

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
          this._notifyStartupRegistration(savedHotkey, result);
          debugLogger.log(`[HotkeyManager] Restored saved hotkey: "${savedHotkey}"`);
          return;
        }
        debugLogger.log(`[HotkeyManager] Saved hotkey "${savedHotkey}" failed to register`);
        this.notifyHotkeyFailure(savedHotkey, result);
      }

      const defaultHotkey = this.getEffectiveDefaultHotkey();

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
      for (const fallback of FALLBACK_HOTKEYS) {
        const fallbackResult = this.setupShortcuts(fallback, callback);
        if (fallbackResult.success) {
          debugLogger.log(`[HotkeyManager] Fallback hotkey "${fallback}" registered successfully`);
          // Only persist to .env (for loadSavedHotkeyOrDefault fallback path).
          // Do NOT update localStorage — it holds the user's preferred hotkey so the
          // app retries it on next startup once the conflict is resolved.
          await this._persistHotkeyToEnvFile(fallback);
          this.notifyActiveHotkey(fallback);
          this.notifyHotkeyFallback(defaultHotkey, fallback);
          return;
        }
      }

      debugLogger.log("[HotkeyManager] All hotkey fallbacks failed");
      this.notifyHotkeyFailure(defaultHotkey, result);
    } catch (err) {
      debugLogger.error("Failed to initialize hotkey", { error: err.message }, "hotkey");
    } finally {
      this.emit("hotkey-loaded", this.currentHotkey);
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
    // Save via EnvironmentManager (writes to .env file + process.env).
    // This is the authoritative backend store, read by getSavedHotkey() on next startup.
    try {
      const EnvironmentManager = require("./environment");
      const envManager = new EnvironmentManager();
      envManager.saveDictationKey(hotkey);
      debugLogger.log(`[HotkeyManager] Persisted hotkey "${hotkey}" to .env file`);
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to save dictation key to env:", err.message);
    }

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

  async getSavedHotkey() {
    // Read localStorage first (user's preferred hotkey), .env as backup.
    // localStorage keeps the preference even after a temporary fallback,
    // so the app retries the preferred hotkey on each startup and only
    // falls back again if the conflict still exists.
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        const lsKey = await this.mainWindow.webContents.executeJavaScript(
          `localStorage.getItem("dictationKey") || ""`
        );
        if (lsKey && lsKey.trim() !== "") return lsKey;
      } catch (err) {
        debugLogger.log(
          "[HotkeyManager] Failed to read dictationKey from localStorage:",
          err.message
        );
      }
    }

    try {
      const EnvironmentManager = require("./environment");
      const envManager = new EnvironmentManager();
      const envKey = envManager.getDictationKey();
      if (envKey && envKey.trim() !== "") return envKey;
    } catch (err) {
      debugLogger.log("[HotkeyManager] Failed to read dictationKey from .env:", err.message);
    }

    return DEFAULT_HOTKEY;
  }

  /**
   * Returns the effective default hotkey for the current platform.
   * On platforms where Control+Super doesn't work (X11 modifier-only,
   * GNOME gsettings requires a regular key), returns the first fallback (F8).
   */
  getEffectiveDefaultHotkey() {
    if (process.platform === "darwin") return "GLOBE";
    if (process.platform !== "linux") return DEFAULT_HOTKEY;

    const isX11 = !GnomeShortcutManager.isWayland();

    // Modifier-only combos (e.g. Control+Super) don't work on:
    // - X11: XGrabKey can't capture modifier-only sequences
    // - GNOME (X11/Wayland): gsettings requires a regular key in the combo
    if ((isX11 || GnomeShortcutManager.isGnome()) && isModifierOnlyHotkey(DEFAULT_HOTKEY)) {
      return FALLBACK_HOTKEYS[0];
    }

    return DEFAULT_HOTKEY;
  }

  /**
   * Try fallback hotkeys via a native registration function.
   * @param {string} hotkey - The original hotkey that failed
   * @param {string} backend - Backend name for logging (e.g. "GNOME", "KDE", "Hyprland")
   * @param {(fallback: string) => Promise<boolean>} registerFn - Tries registering a single fallback, returns true on success
   * @returns {Promise<boolean>} true if a fallback was registered
   */
  async tryNativeFallbacks(hotkey, backend, registerFn) {
    debugLogger.log(
      `[HotkeyManager] ${backend} keybinding failed for "${hotkey}", trying fallbacks via ${backend} native...`
    );
    for (const fallback of FALLBACK_HOTKEYS) {
      const success = await registerFn(fallback);
      if (success) {
        this.currentHotkey = fallback;
        debugLogger.log(
          `[HotkeyManager] ${backend} fallback hotkey "${fallback}" registered successfully`
        );
        // Persist to .env only, not localStorage (preserves user's preferred key for retry on next launch).
        await this._persistHotkeyToEnvFile(fallback);
        this.notifyActiveHotkey(fallback);
        this.notifyHotkeyFallback(hotkey, fallback);
        return true;
      }
    }
    debugLogger.log(`[HotkeyManager] All ${backend} fallback hotkeys failed`);
    return false;
  }

  notifyActiveHotkey(hotkey) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("dictation-key-active", hotkey);
      }
    }
  }

  // Tell the renderer which hotkeys actually registered and which failed.
  _notifyStartupRegistration(requestedHotkey, result) {
    this.notifyActiveHotkey(result.hotkeys ? result.hotkeys.join(",") : requestedHotkey);
    for (const failure of result.failures || []) {
      this.notifyHotkeyFailure(failure.hotkey, failure);
    }
  }

  notifyHotkeyFallback(originalHotkey, fallbackHotkey) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-fallback-used", {
        original: originalHotkey,
        fallback: fallbackHotkey,
      });
    }
  }

  notifyHotkeyFailure(hotkey, result) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("hotkey-registration-failed", {
        hotkey,
        error: result?.error || i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
        suggestions: result?.suggestions || ["F8", "F9", "Control+Shift+Space"],
      });
    }
  }

  async updateHotkey(hotkeyInput, callback) {
    if (!callback) {
      throw new Error("Callback function is required for hotkey update");
    }

    try {
      const hotkeys = parseHotkeyList(hotkeyInput);
      if (hotkeys.length === 0) {
        return {
          success: false,
          message: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: "" }),
        };
      }
      const hotkeyStr = hotkeys.join(",");
      // DE backends bind one accelerator per slot; extras stay in storage.
      const primary = hotkeys[0];

      for (const hotkey of hotkeys) {
        const conflict = this._findSlotConflict("dictation", hotkey);
        if (conflict) {
          return { success: false, message: conflict.error, reason: conflict.reason };
        }
      }

      if (this.useGnome && this.gnomeManager) {
        debugLogger.log(`[HotkeyManager] Updating GNOME hotkey to "${primary}"`);
        const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(primary);
        const success = await this.gnomeManager.updateKeybinding(gnomeHotkey);
        if (!success) {
          return {
            success: false,
            message: i18nMain.t("hotkey.errors.updateFailedCheckFormat", { hotkey: primary }),
          };
        }
        this.currentHotkey = primary;
        this.notifyActiveHotkey(primary);
        const saved = await this.saveHotkeyToRenderer(hotkeyStr);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] GNOME hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${primary} (via GNOME native shortcut)`,
        };
      }

      if (this.useHyprland && this.hyprlandManager) {
        debugLogger.log(`[HotkeyManager] Updating Hyprland hotkey to "${primary}"`);
        const success = await this.hyprlandManager.updateKeybinding(primary);
        if (!success) {
          return {
            success: false,
            message: i18nMain.t("hotkey.errors.updateFailedCheckFormat", { hotkey: primary }),
          };
        }
        this.currentHotkey = primary;
        this.notifyActiveHotkey(primary);
        const saved = await this.saveHotkeyToRenderer(hotkeyStr);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hyprland hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${primary} (via Hyprland native shortcut)`,
        };
      }

      if (this.useKDE && this.kdeManager) {
        debugLogger.log(`[HotkeyManager] Updating KDE hotkey to "${primary}"`);
        const previousHotkey = this.currentHotkey;
        await this.kdeManager.unregisterKeybinding("dictation");
        const result = await this.kdeManager.registerKeybinding(primary, "dictation", callback);
        if (result !== true) {
          if (previousHotkey) {
            const restored = await this.kdeManager.registerKeybinding(
              previousHotkey,
              "dictation",
              callback
            );
            if (restored === true) {
              debugLogger.log(`[HotkeyManager] Restored previous KDE hotkey "${previousHotkey}"`);
            }
          }
          const reason =
            KDE_FAILURE_REASONS[result]?.(primary) ||
            i18nMain.t("hotkey.errors.registrationFailed", { hotkey: primary });
          return { success: false, message: reason };
        }
        this.currentHotkey = primary;
        this.notifyActiveHotkey(primary);
        const saved = await this.saveHotkeyToRenderer(hotkeyStr);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] KDE hotkey registered but failed to persist to localStorage"
          );
        }
        return {
          success: true,
          message: `Hotkey updated to: ${primary} (via KDE D-Bus shortcut)`,
        };
      }

      const result = this.setupShortcuts(hotkeys, callback, "dictation", { atomic: true });
      if (result.success) {
        this.notifyActiveHotkey(hotkeyStr);
        const saved = await this.saveHotkeyToRenderer(hotkeyStr);
        if (!saved) {
          debugLogger.warn(
            "[HotkeyManager] Hotkey registered but failed to persist to localStorage"
          );
        }
        return { success: true, message: `Hotkey updated to: ${hotkeyStr}` };
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
        slot.hotkeys = [];
        slot.accelerators = [];
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

  getHyprlandConfigStatus() {
    if (!this.hyprlandManager) return null;
    return HyprlandShortcutManager.getHyprlandConfigStatus();
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
module.exports.isMouseButtonHotkey = isMouseButtonHotkey;
