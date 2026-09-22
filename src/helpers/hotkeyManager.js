const EventEmitter = require("events");
const { globalShortcut, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");
const GnomeShortcutManager = require("./gnomeShortcut");
const HyprlandShortcutManager = require("./hyprlandShortcut");
const KDEShortcutManager = require("./kdeShortcut");
const { i18nMain } = require("./i18nMain");
const { parseHotkeyList } = require("./hotkeyList");
const { supportsMacKeyWatch } = require("./macKeyNames");

// Delay to ensure localStorage is accessible after window load
const HOTKEY_REGISTRATION_DELAY_MS = 1000;

// Fallback hotkeys tried when primary hotkey registration fails on startup
const FALLBACK_HOTKEYS = ["F8", "F9", "Control+Shift+Space"];

// Default hotkey for dictation if no saved value exists.
// Linux gets a regular key in the combo: GNOME's portal, KDE's KGlobalAccel and
// Hyprland all need one to report a key release, and without a release there is
// no Hold and no double-press latch. Windows keeps Control+Super, where the
// low-level keyboard hook sees both edges of a modifier-only combo.
const DEFAULT_HOTKEY = process.platform === "linux" ? "Control+Super+Space" : "Control+Super";

// Dictation has a dedicated native path because it also supports push-to-talk.
const LINUX_NATIVE_TAP_SLOTS = new Set(["meeting", "voiceAgent", "translation"]);

// Slots whose activation mode is configurable per slot. Dictation keeps the
// legacy activationMode value; meeting and cancel are always tap-to-toggle.
const SLOT_MODE_PUSH_SLOTS = new Set(["voiceAgent", "translation"]);

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
  return hotkey
    .replace(/\bRight(Command|Cmd)\b/g, "Command")
    .replace(/\bRight(Control|Ctrl)\b/g, "Control")
    .replace(/\bRight(Alt|Option)\b/g, "Alt")
    .replace(/\bRightShift\b/g, "Shift");
}

function isUnsupportedFnCombination(hotkey) {
  return /^Fn\+/i.test(hotkey || "");
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
    const defaultDictation = process.platform === "darwin" ? "GLOBE" : DEFAULT_HOTKEY;
    this.slots.set("dictation", { hotkeys: [defaultDictation], callback: null, accelerators: [] });
    this.isInitialized = false;
    this.isListeningMode = false;
    this.gnomeManager = null;
    this.useGnome = false;
    this.hyprlandManager = null;
    this.useHyprland = false;
    this.hyprlandInitializationAttempted = false;
    this.hyprlandRegistrationReady = Promise.resolve();
    this.kdeManager = null;
    this.useKDE = false;
    this.nativeKeyManager = null;
    // Per-slot activation modes for the slots that can Hold besides
    // dictation (which keeps the legacy activationMode).
    this.slotActivationModes = { voiceAgent: "tap", translation: "tap" };
  }

  getSlotActivationMode(slotName) {
    if (slotName === "dictation") return this.activationMode === "push" ? "push" : "tap";
    return this.slotActivationModes[slotName] === "push" ? "push" : "tap";
  }

  _slotWantsPushToTalk(slotName) {
    return this.getSlotActivationMode(slotName) === "push";
  }

  // Switch a voiceAgent/translation slot between Tap and Hold. Verifies the
  // slot's hotkey can Hold on this backend (fail closed with no hotkey), and
  // on GNOME rebinds the slot through the matching mechanism — the portal for
  // Hold, gsettings for Tap — rolling back to the previous binding if the
  // portal refuses. Mirrors setActivationMode for dictation.
  async setSlotActivationMode(slotName, mode, { notifyFailure = true } = {}) {
    if (!SLOT_MODE_PUSH_SLOTS.has(slotName)) return false;
    const nextMode = mode === "push" ? "push" : "tap";
    const previousMode = this.getSlotActivationMode(slotName);
    if (previousMode === nextMode) return true;

    const hotkey = this.getSlotHotkey(slotName);
    const callback = this.slots.get(slotName)?.callback;
    if (nextMode === "push" && (!hotkey || !this.supportsPushToTalk(hotkey, slotName))) {
      if (notifyFailure && hotkey) {
        this.notifyHotkeyFailure(hotkey, {
          error: this.getPushToTalkUnavailableReason(hotkey, slotName),
        });
      }
      return false;
    }

    if (hotkey && callback && (this.useGnome || this._macSlotNeedsReregister(slotName))) {
      const result = await this.registerSlot(slotName, this.getSlotHotkeys(slotName), callback, {
        atomic: true,
        activationMode: nextMode,
      });
      if (!result.success) {
        if (notifyFailure) this.notifyHotkeyFailure(hotkey, { error: result.error });
        return false;
      }
    } else {
      this.slotActivationModes[slotName] = nextMode;
    }
    return true;
  }

  // macOS only: a plain key on a Hold slot has no release source through
  // globalShortcut (a Carbon hot key hides both edges from every monitor), so
  // the listener's event tap owns it — as the low-level hooks do on Windows
  // and Linux. Combos keep the hot key: modifier-up is their release source.
  isMacListenerOwnedKey(hotkey, slotName = "dictation") {
    return (
      this._isMacPlainKey(hotkey) &&
      supportsMacKeyWatch(hotkey) &&
      this._slotWantsPushToTalk(slotName)
    );
  }

  _macSlotNeedsReregister(slotName) {
    return (
      process.platform === "darwin" &&
      this.getSlotHotkeys(slotName).some((hotkey) => this._isMacPlainKey(hotkey))
    );
  }

  // Re-run a slot's registration under its current mode (the owner of each
  // plain key follows the mode). True when the slot is empty or re-registered.
  _reregisterSlotShortcuts(slotName) {
    const slot = this.slots.get(slotName);
    if (!slot?.hotkeys?.length || !slot.callback) return true;
    return this.setupShortcuts(slot.hotkeys, slot.callback, slotName, { atomic: true }).success;
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
      suggestions = ["Control+Super+Space", "Control+Shift+K", "Super+Shift+R"];
    }

    return suggestions.filter((s) => s !== failedHotkey).slice(0, 3);
  }

  _queueSlotUpdate(slotName, update) {
    this._slotUpdates ??= new Map();
    const previous = this._slotUpdates.get(slotName);
    // An idle slot starts its update synchronously so native backends see the
    // call in the same tick; later updates for the slot chain behind it.
    const pending = previous
      ? previous.then(update, update)
      : new Promise((resolve) => resolve(update()));
    this._slotUpdates.set(slotName, pending);
    return pending.finally(() => {
      if (this._slotUpdates.get(slotName) === pending) this._slotUpdates.delete(slotName);
    });
  }

  registerSlot(slotName, hotkeyInput, callback, options = {}) {
    return this._queueSlotUpdate(slotName, () =>
      this._registerSlot(slotName, hotkeyInput, callback, options)
    );
  }

  async _registerSlot(slotName, hotkeyInput, callback, options = {}) {
    const hotkeys = parseHotkeyList(hotkeyInput);
    const hotkey = hotkeys[0];
    const failure = {
      success: false,
      error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: hotkey || "" }),
    };
    if (!hotkey || !callback) return failure;
    const nativeGnome = this.useGnome && this.gnomeManager && LINUX_NATIVE_TAP_SLOTS.has(slotName);
    const nativeKde = this.useKDE && this.kdeManager && slotName !== "cancel";
    const nativeHyprland =
      this.useHyprland && this.hyprlandManager && LINUX_NATIVE_TAP_SLOTS.has(slotName);
    const nativeSlot = nativeGnome || nativeKde || nativeHyprland;
    // A Hyprland session whose backend never came up must not fall back to
    // globalShortcut for these slots: it cannot bind under Hyprland Wayland.
    if (
      !nativeSlot &&
      LINUX_NATIVE_TAP_SLOTS.has(slotName) &&
      this.hyprlandInitializationAttempted
    ) {
      return failure;
    }
    // Native Linux backends bind only the primary hotkey.
    if (hotkeys.length > 1 && nativeSlot) {
      debugLogger.log(
        `[HotkeyManager] Slot "${slotName}" has ${hotkeys.length} hotkeys but this Linux desktop backend only applies the primary ("${hotkey}")`
      );
    }
    const previous = this.slots.get(slotName);
    const previousHotkeys = [...(previous?.hotkeys || [])];
    const previousCallback = previous?.callback;
    const previousMode = this.getSlotActivationMode(slotName);
    const nextMode =
      SLOT_MODE_PUSH_SLOTS.has(slotName) && options.activationMode
        ? options.activationMode === "push"
          ? "push"
          : "tap"
        : previousMode;
    const appliedKeys = nativeSlot ? [hotkey] : hotkeys;
    if (options.atomic || nativeSlot) {
      for (const key of appliedKeys) {
        const conflict = this._findSlotConflict(slotName, key);
        if (conflict) return conflict;
      }
    }
    const nativeOnlyKeys = appliedKeys.filter(
      (key) => this.requiresNativeKeyListener(key, slotName) && this.isNativeOnlyHotkey(key)
    );
    if (nativeOnlyKeys.length && this.nativeKeyManager) {
      try {
        const ready = await this.nativeKeyManager.ensureReady(nativeOnlyKeys);
        if (!ready && options.atomic) return failure;
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
    if (nextMode === "push" && appliedKeys.some((key) => !this.supportsPushToTalk(key, slotName))) {
      return { ...failure, error: this.getPushToTalkUnavailableReason(hotkey, slotName) };
    }
    if (SLOT_MODE_PUSH_SLOTS.has(slotName)) this.slotActivationModes[slotName] = nextMode;

    let mutated = false;
    const registerNative = async (key, handler, mode) => {
      if (nativeKde) {
        const result = await this.kdeManager.registerKeybinding(
          key,
          slotName,
          handler,
          mode === "push",
          {
            onMutation: () => {
              mutated = true;
            },
          }
        );
        return result === true
          ? { success: true }
          : {
              success: false,
              error: KDE_FAILURE_REASONS[result]?.(key) || failure.error,
            };
      }
      if (nativeHyprland) {
        // Hyprland slots are tap-only (the mode gate above already refused
        // "push"); the manager restores the prior bind itself on failure, so
        // nothing here needs rolling back.
        const success = await this.hyprlandManager.registerSlotKeybinding(key, slotName, handler);
        return success ? { success: true } : failure;
      }
      const shortcut = GnomeShortcutManager.convertToGnomeFormat(key);
      if (mode === "tap" && !shortcut) return failure;
      mutated = true;
      let success;
      if (mode === "push") {
        success = await this.gnomeManager.registerPushToTalk(key, handler, slotName);
      } else {
        if ((await this.gnomeManager.unregisterPushToTalk?.(slotName)) === false) return failure;
        success = await this.gnomeManager.registerKeybinding(shortcut, slotName);
      }
      if (success) {
        if (slotName === "meeting") this.gnomeManager.setMeetingCallback(handler);
        else if (slotName === "voiceAgent") this.gnomeManager.setVoiceAgentCallback(handler);
        else if (slotName === "translation") this.gnomeManager.setTranslationCallback(handler);
      }
      return success ? { success: true } : failure;
    };

    let result;
    try {
      result = nativeSlot
        ? await registerNative(hotkey, callback, nextMode)
        : this.setupShortcuts(hotkeys, callback, slotName, options);
    } catch (error) {
      result = { success: false, error: error.message, failedShortcutIds: error.failedShortcutIds };
    }
    if (result.success) {
      if (nativeSlot) {
        this.slots.set(slotName, { hotkeys: [hotkey], callback, accelerators: [] });
        if (nativeHyprland) {
          debugLogger.log(`[HotkeyManager] Hyprland slot "${slotName}" set to "${hotkey}"`);
        }
      }
      return { ...result, hotkey: result.hotkey || hotkey, activationMode: nextMode };
    }

    if (SLOT_MODE_PUSH_SLOTS.has(slotName)) this.slotActivationModes[slotName] = previousMode;
    if (result.failedShortcutIds?.length) {
      this._forgetFailedPortalSlots(result.failedShortcutIds, result.error);
      if (previousMode === "push") return { ...result, rollbackFailed: true };
    }
    if (mutated) {
      let restored = previousHotkeys.length === 0;
      try {
        if (previousHotkeys.length) {
          restored = (await registerNative(previousHotkeys[0], previousCallback, previousMode))
            .success;
        } else if (nativeKde) {
          restored = (await this.kdeManager.unregisterKeybinding(slotName)) !== false;
        } else if (nativeHyprland) {
          restored = (await this.hyprlandManager.unregisterKeybinding(slotName)) !== false;
        } else {
          const tapRemoved = await this.gnomeManager.unregisterKeybinding(slotName);
          const pushRemoved = await this.gnomeManager.unregisterPushToTalk?.(slotName);
          restored = tapRemoved !== false && pushRemoved !== false;
        }
      } catch (error) {
        restored = false;
        this._forgetFailedPortalSlots(error.failedShortcutIds || [], error.message);
      }
      if (!restored) {
        this.slots.set(slotName, { hotkeys: [], callback: null, accelerators: [] });
        this.notifyHotkeyFailure(previousHotkeys[0] || hotkey, { error: result.error });
        return { ...result, rollbackFailed: true };
      }
    }
    return result;
  }

  _forgetFailedPortalSlots(slotNames, error) {
    for (const slotName of slotNames) {
      if (this.getSlotActivationMode(slotName) !== "push") continue;
      const hotkey = this.getSlotHotkey(slotName);
      this.slots.set(slotName, { hotkeys: [], callback: null, accelerators: [] });
      if (hotkey) this.notifyHotkeyFailure(hotkey, { error });
    }
  }

  unregisterSlot(slotName) {
    const nativeKde = this.useKDE && this.kdeManager && slotName !== "cancel";
    const nativeGnome = this.useGnome && this.gnomeManager && LINUX_NATIVE_TAP_SLOTS.has(slotName);
    const nativeHyprland =
      this.useHyprland && this.hyprlandManager && LINUX_NATIVE_TAP_SLOTS.has(slotName);
    if (nativeKde || nativeGnome || nativeHyprland) {
      return this._queueSlotUpdate(slotName, async () => {
        const slot = this.slots.get(slotName);
        if (!slot?.hotkeys?.length) return true;
        let removalError;
        try {
          if (nativeKde) {
            if ((await this.kdeManager.unregisterKeybinding(slotName)) === false) return false;
          } else if (nativeHyprland) {
            if (!(await this.hyprlandManager.unregisterKeybinding(slotName))) return false;
          } else {
            const tapRemoved = await this.gnomeManager.unregisterKeybinding(slotName);
            const pushRemoved = await this.gnomeManager.unregisterPushToTalk?.(slotName);
            if (tapRemoved === false || pushRemoved === false) {
              removalError = new Error("Native shortcut removal failed");
            }
          }
        } catch (error) {
          removalError = error;
        }
        if (removalError) {
          debugLogger.warn(
            `[HotkeyManager] Could not unregister slot "${slotName}":`,
            removalError.message
          );
          this._forgetFailedPortalSlots(removalError.failedShortcutIds || [], removalError.message);
          if (removalError.failedShortcutIds?.includes(slotName)) return false;
          const restored = await this._registerSlot(slotName, slot.hotkeys, slot.callback, {
            atomic: true,
          });
          if (!restored.success) {
            this.slots.set(slotName, { hotkeys: [], callback: null, accelerators: [] });
            this.notifyHotkeyFailure(slot.hotkeys[0], { error: restored.error });
          }
          return false;
        }
        slot.hotkeys = [];
        slot.accelerators = [];
        return true;
      });
    }
    const slot = this.slots.get(slotName);
    if (!slot) return true;
    for (const accelerator of slot.accelerators || []) {
      if (!accelerator) continue;
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        // Already unregistered during cleanup.
      }
    }
    slot.hotkeys = [];
    slot.accelerators = [];
    return true;
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
   * register through globalShortcut, and in push-to-talk mode a slot also needs
   * raw key-down/key-up events. Dictation follows the legacy activationMode;
   * voiceAgent/translation follow their own per-slot mode in slotModes; meeting
   * and cancel are always tap-to-toggle. Globe/mouse hotkeys are macOS-only.
   * Each slot may bind several hotkeys, so we evaluate every one.
   */
  getNativeListenerKeys(activationMode, slotModes = {}) {
    const keys = [];
    for (const [slotName, slot] of this.slots) {
      for (const hotkey of slot.hotkeys ?? []) {
        if (!hotkey || !this.requiresNativeKeyListener(hotkey, slotName)) continue;
        const pushToTalk =
          slotName === "dictation"
            ? activationMode === "push"
            : SLOT_MODE_PUSH_SLOTS.has(slotName) && slotModes[slotName] === "push";
        if (pushToTalk || isModifierOnlyHotkey(hotkey) || isRightSideModifier(hotkey)) {
          keys.push(hotkey);
        }
      }
    }
    return keys;
  }

  // A plain single key on macOS: not Globe/Fn, a mouse button, a right-side
  // modifier or a combo. globalShortcut can only report its press, so on Hold
  // the native listener's event tap owns it (isMacListenerOwnedKey).
  _isMacPlainKey(hotkey) {
    return (
      process.platform === "darwin" &&
      Boolean(hotkey) &&
      !isGlobeLikeHotkey(hotkey) &&
      !isMouseButtonHotkey(hotkey) &&
      !isRightSideModifier(hotkey) &&
      !hotkey.includes("+")
    );
  }

  // Desktop backends own both key phases independently of the optional evdev
  // reader. Hyprland only owns dictation at this version of the integration.
  hasNativeShortcutPhases(slotName = "dictation") {
    const recordingSlot = slotName === "dictation" || SLOT_MODE_PUSH_SLOTS.has(slotName);
    if (!recordingSlot) return false;
    if (this.useKDE) return true;
    if (this.useGnome) return Boolean(this.gnomeManager?.supportsPushToTalk?.());
    return this.useHyprland && slotName === "dictation";
  }

  requiresNativeKeyListener(hotkey, slotName = "dictation") {
    return (
      (process.platform === "win32" || process.platform === "linux") &&
      !this.hasNativeShortcutPhases(slotName) &&
      !this.isUsingNativeShortcut() &&
      !isGlobeLikeHotkey(hotkey) &&
      !isMouseButtonHotkey(hotkey)
    );
  }

  isNativeOnlyHotkey(hotkey) {
    return isModifierOnlyHotkey(hotkey) || isRightSideModifier(hotkey);
  }

  // Probe candidate readers without removing the currently active readers.
  // A new edit deliberately retries a previous failure; ordinary capability
  // reads and renderer synchronization never restart a failed reader.
  async resolveActivationMode(hotkeyInput, slotName = "dictation") {
    let hotkeys = parseHotkeyList(hotkeyInput);
    if (this.isUsingNativeShortcut()) hotkeys = hotkeys.slice(0, 1);
    if (!hotkeys.length) return "tap";
    const readerKeys = hotkeys.filter((hotkey) => this.requiresNativeKeyListener(hotkey, slotName));
    if (readerKeys.length && this.nativeKeyManager) {
      if (!(await this.nativeKeyManager.ensureReady(readerKeys))) return "tap";
    }
    return hotkeys.every((hotkey) => this.supportsPushToTalk(hotkey, slotName)) ? "push" : "tap";
  }

  // Hold needs a press/release source for the slot's hotkey: the low-level
  // listener on Windows/Linux, the GlobalShortcuts portal on GNOME,
  // KGlobalAccel on KDE, and on macOS the native listener (Globe, right
  // modifiers, mouse buttons, plain keys) or modifier-up for combos.
  // Hyprland binds only the dictation slot, so the others have no source there.
  supportsPushToTalk(hotkey = this.currentHotkey, slotName = "dictation") {
    if (this._isMacPlainKey(hotkey)) return supportsMacKeyWatch(hotkey);
    if (this.isUsingNativeShortcut() && isModifierOnlyHotkey(hotkey)) {
      return false;
    }
    if (slotName !== "dictation" && this.useHyprland) {
      return false;
    }
    if (this.useGnome && this.gnomeManager?.supportsPushToTalk) {
      return this.gnomeManager.supportsPushToTalk();
    }
    if (this.requiresNativeKeyListener(hotkey, slotName) && this.nativeKeyManager) {
      return this.nativeKeyManager.canWatch(hotkey);
    }
    return true;
  }

  // Settle the startup request only after the saved key and backend are known.
  // Keep the request across fallback candidates, so an unsupported first key
  // cannot force a later working fallback to Tap. Stored Tap stays Tap until
  // a real edit asks the candidate resolver to retry Hold.
  async _settleDictationActivationMode(hotkey) {
    const requestedMode = this._startupActivationMode ?? this.getSlotActivationMode("dictation");
    const preferredMode =
      requestedMode === "push" ? await this.resolveActivationMode(hotkey) : "tap";
    if (this.getSlotActivationMode("dictation") === preferredMode) return;
    this.activationMode = preferredMode;
    this.emit("dictation-activation-mode-settled", preferredMode);
  }

  // Two different causes read the same way to a user whose Hold just vanished,
  // so keep them apart: a hotkey they can fix themselves, versus a desktop that
  // cannot report a key release at all (GNOME before 48 has no GlobalShortcuts
  // portal, and no hotkey helps there).
  getPushToTalkUnavailableReason(
    hotkey = this.currentHotkey,
    slotName = "dictation",
    language = i18nMain.language
  ) {
    const t = i18nMain.getFixedT(language);
    if (this.isUsingNativeShortcut() && isModifierOnlyHotkey(hotkey)) {
      return t("hotkey.errors.holdNeedsRegularKey", {
        hotkey,
        suggestion: DEFAULT_HOTKEY,
      });
    }
    if (slotName !== "dictation" && this.useHyprland) {
      return t("hotkey.errors.holdUnsupportedOnHyprland");
    }
    if (this.useGnome && !this.gnomeManager?.supportsPushToTalk?.()) {
      return t("hotkey.errors.holdUnsupportedOnDesktop");
    }
    return t("windows.pttUnavailable");
  }

  async setActivationMode(mode) {
    const nextMode = mode === "push" ? "push" : "tap";
    const previousMode = this.activationMode === "push" ? "push" : "tap";
    if (this.activationMode === nextMode) return true;

    const hotkey = this.currentHotkey;
    const callback = this.hotkeyCallback;
    if (nextMode === "push" && !this.supportsPushToTalk(hotkey)) {
      if (hotkey) {
        this.notifyHotkeyFailure(hotkey, {
          error: this.getPushToTalkUnavailableReason(hotkey),
        });
      }
      return false;
    }

    let success = true;
    try {
      if (this.useGnome && this.gnomeManager && hotkey && callback) {
        success = await this.registerGnomeDictationHotkey(hotkey, callback, nextMode);
      } else if (this.useHyprland && this.hyprlandManager && hotkey) {
        success = await this.hyprlandManager.updateKeybinding(hotkey, nextMode === "push");
        if (!success) {
          await this.hyprlandManager.updateKeybinding(hotkey, previousMode === "push");
        }
      } else if (this._macSlotNeedsReregister("dictation")) {
        // The registration reads the mode, so it flips first and rolls back
        // with its bindings if the re-registration fails.
        this.activationMode = nextMode;
        success = this._reregisterSlotShortcuts("dictation");
        if (!success) {
          this.activationMode = previousMode;
          this._reregisterSlotShortcuts("dictation");
        }
      }
    } catch (err) {
      debugLogger.warn("[HotkeyManager] Failed to change activation mode:", err.message);
      success = false;
    }

    if (
      !success &&
      previousMode === "push" &&
      nextMode === "tap" &&
      this.useGnome &&
      this.gnomeManager &&
      hotkey &&
      callback
    ) {
      try {
        const restored = await this.registerGnomeDictationHotkey(hotkey, callback, "push");
        if (!restored) {
          debugLogger.warn("[HotkeyManager] Could not restore GNOME push-to-talk binding");
        }
      } catch (err) {
        debugLogger.warn(
          "[HotkeyManager] Error restoring GNOME push-to-talk binding:",
          err.message
        );
      }
    }

    if (!success) {
      if (hotkey) {
        this.notifyHotkeyFailure(hotkey, {
          error: i18nMain.t("hotkey.errors.registrationFailed", { hotkey }),
        });
      }
      return false;
    }

    this.activationMode = nextMode;
    return true;
  }

  // Which mouse buttons the macOS listener must swallow for these slots, and
  // whether OpenWhispr owns Globe — if it does, macOS's own standalone Globe
  // action has to stand down.
  getMacNativeListenerConfig(slotNames) {
    const mouseButtons = new Set();
    const watchKeys = new Set();
    let suppressGlobeAction = false;

    for (const slotName of slotNames) {
      for (const hotkey of this.getSlotHotkeys(slotName)) {
        if (isMouseButtonHotkey(hotkey)) {
          mouseButtons.add(hotkey);
        } else if (isGlobeLikeHotkey(hotkey)) {
          suppressGlobeAction = true;
        } else if (!this.isListeningMode && this.isMacListenerOwnedKey(hotkey, slotName)) {
          // Hotkey capture must see every key, so nothing is watched then.
          watchKeys.add(hotkey);
        }
      }
    }

    return {
      mouseButtons: [...mouseButtons],
      suppressGlobeAction,
      watchKeys: [...watchKeys].sort(),
    };
  }

  // Register one hotkey without mutating any slot. `accelerator` is null for
  // hotkeys handled by native listeners.
  _registerSingleHotkey(hotkey, callback, slotName = "dictation") {
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

      // Electron cannot represent Fn as part of an accelerator. Registering
      // Fn+A as A claims an ordinary typing key globally, so only standalone
      // Globe/Fn (handled by the native listener above) is supported.
      if (isUnsupportedFnCombination(hotkey)) {
        return {
          success: false,
          hotkey,
          error: i18nMain.t("hotkey.errors.fnCombinationUnsupported", {
            defaultValue: "The Globe/Fn key can only be used by itself.",
          }),
          reason: "fn_combination_unsupported",
        };
      }

      if (
        this.requiresNativeKeyListener(hotkey, slotName) &&
        this.isNativeOnlyHotkey(hotkey) &&
        this.nativeKeyManager &&
        !this.nativeKeyManager.canWatch(hotkey)
      ) {
        return {
          success: false,
          hotkey,
          error: this.getPushToTalkUnavailableReason(hotkey, slotName),
        };
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

      if (
        this._isMacPlainKey(hotkey) &&
        this._slotWantsPushToTalk(slotName) &&
        !supportsMacKeyWatch(hotkey)
      ) {
        return {
          success: false,
          hotkey,
          error: this.getPushToTalkUnavailableReason(hotkey, slotName),
        };
      }

      if (this.isMacListenerOwnedKey(hotkey, slotName)) {
        debugLogger.log(
          `[HotkeyManager] Plain key "${hotkey}" on Hold - using the macOS native listener`
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
      const res = this._registerSingleHotkey(hotkey, callback, slotName);
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
      this._restorePreviousHotkeys(
        previousHotkeys,
        previousAccelerators,
        slot.callback || callback
      );
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
    const hyprlandBinding = this.useHyprland
      ? HyprlandShortcutManager.getCanonicalBinding(hotkey)
      : null;

    for (const [otherSlotName, otherSlot] of this.slots) {
      if (otherSlotName === slotName) continue;
      const otherHotkeys = otherSlot.hotkeys || [];
      const otherAccelerators = otherSlot.accelerators || [];
      const hasEquivalentHyprlandBinding =
        hyprlandBinding &&
        otherHotkeys.some(
          (otherHotkey) =>
            HyprlandShortcutManager.getCanonicalBinding(otherHotkey) === hyprlandBinding
        );
      const match =
        otherHotkeys.includes(hotkey) ||
        (accelerator && otherAccelerators.includes(accelerator)) ||
        hasEquivalentHyprlandBinding;
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
        const portalOk = await this.gnomeManager.initGlobalShortcutsPortal();
        this.useGnome = true;
        this.hotkeyCallback = callback;
        debugLogger.log("[HotkeyManager] GNOME Global Shortcuts portal:", portalOk);
        return true;
      }
    } catch (err) {
      debugLogger.log("[HotkeyManager] GNOME shortcut init failed:", err.message);
      this.gnomeManager = null;
      this.useGnome = false;
    }

    return false;
  }

  async registerGnomeDictationHotkey(hotkey, callback, mode = this.activationMode) {
    if (mode === "push") {
      if (isModifierOnlyHotkey(hotkey)) return false;
      return this.gnomeManager.registerPushToTalk(hotkey, callback);
    }

    await this.gnomeManager.unregisterPushToTalk();
    const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(hotkey);
    return this.gnomeManager.registerKeybinding(gnomeHotkey);
  }

  async initializeKDEShortcuts(callback) {
    if (process.platform !== "linux" || !KDEShortcutManager.isKDE()) {
      return false;
    }

    try {
      this.kdeManager = new KDEShortcutManager();
      const ok = await this.kdeManager.init();
      if (ok) {
        await this.kdeManager.removeRetiredAgentKeybinding();
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
      this.hyprlandInitializationAttempted = true;
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
    this._startupActivationMode = this.getSlotActivationMode("dictation");

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
            // The GNOME backend is settled now, so the hotkey can finally be
            // judged for Hold. Any fallback below then binds under the mode
            // this settles on.
            await this._settleDictationActivationMode(hotkey);
            const success = await this.registerGnomeDictationHotkey(hotkey, callback);
            if (success) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(`[HotkeyManager] GNOME hotkey "${hotkey}" registered successfully`);
            } else {
              const ok = await this.tryNativeFallbacks(hotkey, "GNOME", (fb) =>
                this.registerGnomeDictationHotkey(fb, callback)
              );
              if (!ok) {
                this.useGnome = false;
                await this.loadSavedHotkeyOrDefault(mainWindow, callback);
              }
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] GNOME keybinding failed, falling back to globalShortcut:",
              err.message
            );
            this.useGnome = false;
            await this.loadSavedHotkeyOrDefault(mainWindow, callback);
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
            // The Hyprland backend is settled now, so the hotkey can finally
            // be judged for Hold.
            await this._settleDictationActivationMode(hotkey);

            const success = await this.hyprlandManager.registerKeybinding(
              hotkey,
              this.activationMode === "push"
            );
            if (success) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(
                `[HotkeyManager] Hyprland hotkey "${hotkey}" registered successfully`
              );
            } else {
              const ok = await this.tryNativeFallbacks(hotkey, "Hyprland", (fb) =>
                this.hyprlandManager.registerKeybinding(fb, this.activationMode === "push")
              );
              if (!ok) {
                this.useHyprland = false;
                await this.loadSavedHotkeyOrDefault(mainWindow, callback);
              }
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] Hyprland keybinding failed, falling back to globalShortcut:",
              err.message
            );
            this.useHyprland = false;
            await this.loadSavedHotkeyOrDefault(mainWindow, callback);
          }
        };

        this.hyprlandRegistrationReady = new Promise((resolve) =>
          setTimeout(resolve, HOTKEY_REGISTRATION_DELAY_MS)
        ).then(registerHyprlandHotkey);
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
            // The KDE backend is settled now, so the hotkey can finally be
            // judged for Hold.
            await this._settleDictationActivationMode(hotkey);
            const result = await this.kdeManager.registerKeybinding(
              hotkey,
              "dictation",
              callback,
              this.activationMode === "push"
            );
            if (result === true) {
              this.currentHotkey = hotkey;
              this.notifyActiveHotkey(hotkey);
              debugLogger.log(`[HotkeyManager] KDE hotkey "${hotkey}" registered successfully`);
            } else if (result === "conflict" || result === "modifier-only") {
              const ok = await this.tryNativeFallbacks(hotkey, "KDE", (fb) =>
                this.kdeManager
                  .registerKeybinding(fb, "dictation", callback, this.activationMode === "push")
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
              await this.loadSavedHotkeyOrDefault(mainWindow, callback);
            }
          } catch (err) {
            debugLogger.log(
              "[HotkeyManager] KDE keybinding failed, falling back to globalShortcut:",
              err.message
            );
            this.kdeManager?.close();
            this.kdeManager = null;
            this.useKDE = false;
            await this.loadSavedHotkeyOrDefault(mainWindow, callback);
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
      const result = await this._registerStartupHotkeys(envHotkey, callback);
      if (result.success) {
        this._notifyStartupRegistration(envHotkey, result);
        debugLogger.log(`[HotkeyManager] Hotkey "${envHotkey}" registered from env`);
      } else {
        debugLogger.log(`[HotkeyManager] Env hotkey "${envHotkey}" failed, waiting for page`);
        await this.loadSavedHotkeyOrDefault(mainWindow, callback);
      }
    } else {
      const loadHotkey = () => this.loadSavedHotkeyOrDefault(mainWindow, callback);
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once("did-finish-load", loadHotkey);
      } else {
        await loadHotkey();
      }
    }

    this.isInitialized = true;
  }

  async _registerStartupHotkeys(hotkeyInput, callback) {
    await this._settleDictationActivationMode(hotkeyInput);
    const nativeOnlyKeys = parseHotkeyList(hotkeyInput).filter(
      (key) => this.requiresNativeKeyListener(key) && this.isNativeOnlyHotkey(key)
    );
    // Native-only Tap still needs a working reader even when stored Tap was
    // intentionally preserved rather than promoted to Hold.
    if (
      nativeOnlyKeys.length &&
      this.nativeKeyManager &&
      (this._startupActivationMode ?? this.getSlotActivationMode("dictation")) === "tap"
    ) {
      await this.nativeKeyManager.ensureReady(nativeOnlyKeys);
    }
    const result = this.setupShortcuts(hotkeyInput, callback);
    this.emit("native-listeners-reconcile");
    return result;
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
        const result = await this._registerStartupHotkeys(savedHotkey, callback);
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

      const result = await this._registerStartupHotkeys(defaultHotkey, callback);
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
        const fallbackResult = await this._registerStartupHotkeys(fallback, callback);
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
   * Returns the effective default hotkey for the current platform. Every
   * default now carries a regular key on the platforms that need one, so this
   * is the platform default with no Linux escape hatch.
   */
  getEffectiveDefaultHotkey() {
    return process.platform === "darwin" ? "GLOBE" : DEFAULT_HOTKEY;
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

    const hotkeys = parseHotkeyList(hotkeyInput);
    if (hotkeys.length === 0) {
      return {
        success: false,
        message: i18nMain.t("hotkey.errors.registrationFailed", { hotkey: "" }),
      };
    }
    // DE backends bind one accelerator per slot; extras stay in storage.
    const primary = hotkeys[0];

    // Hold is the only model, so the stored mode is a verdict about the
    // hotkey, re-judged at every registration: a Hold this hotkey cannot
    // deliver (a macOS plain key with no release source, a modifier-only
    // combo on a DE-native backend) converges to Tap, and a Tap left behind
    // by an earlier demotion comes back to Hold once the hotkey can deliver
    // a release. The caller is told either way; a failed registration
    // restores the previous mode because nothing changed hands.
    const previousMode = this.activationMode === "push" ? "push" : "tap";
    for (const hotkey of hotkeys) {
      const conflict = this._findSlotConflict("dictation", hotkey);
      if (conflict) return { success: false, message: conflict.error, reason: conflict.reason };
    }
    const preferredMode = await this.resolveActivationMode(hotkeys);
    const converged = preferredMode !== previousMode;
    if (converged) this.activationMode = preferredMode;
    // previousMode goes with it: the backend that has to put the OLD hotkey
    // back on failure must put it back under the mode it was registered
    // with, not the one we were converging to.
    const result = await this._applyHotkeyUpdate(hotkeys, primary, callback, previousMode);
    if (converged) {
      if (result.success) result.activationMode = preferredMode;
      else this.activationMode = previousMode;
    }
    return result;
  }

  // `previousMode` is the mode the CURRENT hotkey is registered under, which
  // is not this.activationMode any more: updateHotkey converges that to the
  // new hotkey's verdict before calling in. Only the rollback path needs it.
  async _applyHotkeyUpdate(
    hotkeys,
    primary,
    callback,
    previousMode = this.activationMode === "push" ? "push" : "tap"
  ) {
    try {
      const hotkeyStr = hotkeys.join(",");

      for (const hotkey of hotkeys) {
        const conflict = this._findSlotConflict("dictation", hotkey);
        if (conflict) {
          return { success: false, message: conflict.error, reason: conflict.reason };
        }
      }

      if (this.useGnome && this.gnomeManager) {
        debugLogger.log(`[HotkeyManager] Updating GNOME hotkey to "${primary}"`);
        const success = await this.registerGnomeDictationHotkey(primary, callback);
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
        const success = await this.hyprlandManager.updateKeybinding(
          primary,
          this.activationMode === "push"
        );
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
        const result = await this.kdeManager.registerKeybinding(
          primary,
          "dictation",
          callback,
          this.activationMode === "push"
        );
        if (result !== true) {
          if (previousHotkey) {
            // Under previousMode, not the mode we were converging to:
            // KGlobalAccel refuses a modifier-only shortcut on Hold, so
            // restoring one under the NEW Hold would silently leave dictation
            // with no binding at all until the next restart.
            const restored = await this.kdeManager.registerKeybinding(
              previousHotkey,
              "dictation",
              callback,
              previousMode === "push"
            );
            if (restored === true) {
              debugLogger.log(`[HotkeyManager] Restored previous KDE hotkey "${previousHotkey}"`);
            } else {
              debugLogger.warn(
                `[HotkeyManager] Could not restore previous KDE hotkey "${previousHotkey}": ${restored}`
              );
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
      void this.gnomeManager.close().catch((err) => {
        debugLogger.warn("[HotkeyManager] Error closing GNOME shortcut manager:", err.message);
      });
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
