const shortcutCommand = require("./shortcutCommand");
const debugLogger = require("./debugLogger");
const GnomeGlobalShortcutsPortal = require("./gnomeGlobalShortcutsPortal");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";
const DBUS_NAME_REQUEST_TIMEOUT_MS = 5000;

// Per-slot gsettings paths and display names
const SLOT_CONFIG = {
  dictation: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/",
    name: "OpenWhispr Toggle",
  },
  meeting: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-meeting/",
    name: "OpenWhispr Meeting",
  },
  voiceAgent: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-voice-agent/",
    name: "OpenWhispr Voice Assistant",
  },
  translation: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-translation/",
    name: "OpenWhispr Translation",
  },
};

const KEYBINDING_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const PORTAL_MODIFIER_NAMES = new Set([
  "commandorcontrol",
  "control",
  "ctrl",
  "alt",
  "shift",
  "super",
  "meta",
]);

// Valid pattern for GNOME shortcut format using X11 keysym names (case-sensitive).
// Modifiers are case-insensitive (GTK normalizes them), keysyms are exact.
const VALID_SHORTCUT_PATTERN =
  /^(<(Control|Alt|Shift|Super)>)*(F([1-9]|1[0-9]|2[0-4])|comma|period|slash|plus|minus|equal|semicolon|apostrophe|backslash|bracketleft|bracketright|asciitilde|exclam|at|numbersign|dollar|percent|asciicircum|ampersand|asterisk|parenleft|parenright|underscore|braceleft|braceright|bar|colon|quotedbl|less|greater|question|[a-z0-9]|space|Escape|Tab|BackSpace|grave|Pause|Scroll_Lock|Insert|Delete|Home|End|Page_Up|Page_Down|Up|Down|Left|Right|Return|Print)$/;

// Map Electron key names (lowercased) to X11 keysym names (case-sensitive).
// Source: X11/keysymdef.h, lookup via XStringToKeysym(3).
const ELECTRON_TO_GNOME_KEY_MAP = {
  space: "space",
  tab: "Tab",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  return: "Return",
  enter: "Return",
  home: "Home",
  end: "End",
  insert: "Insert",
  pause: "Pause",
  print: "Print",
  printscreen: "Print",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  scrolllock: "Scroll_Lock",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  // Punctuation must be X11 keysyms; a literal "," fails VALID_SHORTCUT_PATTERN.
  ",": "comma",
  ".": "period",
  "/": "slash",
  "-": "minus",
  "=": "equal",
  ";": "semicolon",
  "'": "apostrophe",
  "[": "bracketleft",
  "]": "bracketright",
  "\\": "backslash",
  plus: "plus",
  "+": "plus",
};

// HotkeyInput stores physical US-QWERTY keys, so Shift must be folded into
// the keysym GNOME matches rather than retained as a separate modifier.
const SHIFTED_PUNCTUATION_TO_GNOME_KEY_MAP = {
  "`": "asciitilde",
  1: "exclam",
  2: "at",
  3: "numbersign",
  4: "dollar",
  5: "percent",
  6: "asciicircum",
  7: "ampersand",
  8: "asterisk",
  9: "parenleft",
  0: "parenright",
  "-": "underscore",
  "=": "plus",
  "[": "braceleft",
  "]": "braceright",
  "\\": "bar",
  ";": "colon",
  "'": "quotedbl",
  ",": "less",
  ".": "greater",
  "/": "question",
};

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("@homebridge/dbus-native");
    return dbus;
  } catch (err) {
    debugLogger.log("[GnomeShortcut] Failed to load dbus-native:", err.message);
    return null;
  }
}

function getSlotConfig(slotName) {
  const config = SLOT_CONFIG[slotName];
  if (!config) {
    throw new Error(`[GnomeShortcut] Unknown slot: "${slotName}"`);
  }
  return config;
}

class GnomeShortcutManager {
  constructor() {
    this.bus = null;
    this.closed = false;
    this.dictationCallback = null;
    this.meetingCallback = null;
    this.voiceAgentCallback = null;
    this.translationCallback = null;
    this.globalShortcutsPortal = new GnomeGlobalShortcutsPortal();
    // Track which slots have been registered in gsettings
    this.registeredSlots = new Set();
    this.commandController = new AbortController();
    this.mutationQueue = Promise.resolve();
    this.closeTask = null;
    this.registrationUncertain = false;
  }

  static isGnome() {
    const desktop = process.env.XDG_CURRENT_DESKTOP || "";
    return (
      desktop.toLowerCase().includes("gnome") ||
      desktop.toLowerCase().includes("ubuntu") ||
      desktop.toLowerCase().includes("unity")
    );
  }

  static isWayland() {
    return process.env.XDG_SESSION_TYPE === "wayland";
  }

  setMeetingCallback(callback) {
    this.meetingCallback = callback;
    debugLogger.log("[GnomeShortcut] Meeting callback registered");
  }

  setVoiceAgentCallback(callback) {
    this.voiceAgentCallback = callback;
    debugLogger.log("[GnomeShortcut] Voice agent callback registered");
  }

  setTranslationCallback(callback) {
    this.translationCallback = callback;
    debugLogger.log("[GnomeShortcut] Translation callback registered");
  }

  // Older builds persisted a gsettings keybinding for the removed chat-agent
  // slot; its dbus-send command targets a method this app no longer exports,
  // so the entry errors silently forever and squats its key. Prune it once.
  removeRetiredAgentKeybinding() {
    return this._queueMutation(() => this._removeRetiredAgentKeybinding());
  }

  _queueMutation(operation) {
    const task = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = task;
    return task;
  }

  _gsettings(args, cleanup = false) {
    return shortcutCommand("gsettings", args, {
      timeout: 5000,
      signal: cleanup ? undefined : this.commandController.signal,
    });
  }

  async _removeRetiredAgentKeybinding() {
    const retiredPath =
      "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-agent/";
    try {
      const existing = await this.getExistingKeybindings();
      if (this.closed || !existing.includes(retiredPath)) return;
      const remaining = existing.filter((p) => p !== retiredPath);
      const bindingsStr = remaining.length ? "['" + remaining.join("', '") + "']" : "[]";
      await this._gsettings([
        "set",
        "org.gnome.settings-daemon.plugins.media-keys",
        "custom-keybindings",
        bindingsStr,
      ]);
      await this._gsettings(["reset-recursively", `${KEYBINDING_SCHEMA}:${retiredPath}`]);
      debugLogger.log("[GnomeShortcut] Removed retired chat-agent keybinding");
    } catch (err) {
      debugLogger.log(
        "[GnomeShortcut] Failed to remove retired chat-agent keybinding:",
        err.message
      );
    }
  }

  async initDBusService(dictationCallback) {
    if (this.closed) return false;
    this.dictationCallback = dictationCallback;

    const dbusModule = getDBus();
    if (!dbusModule) {
      return false;
    }

    try {
      this.bus = dbusModule.sessionBus();
      // Without a listener, async socket errors (e.g. a stale
      // DBUS_SESSION_BUS_ADDRESS) crash the process as an unhandled
      // "error" event — sessionBus() returns before connecting.
      let rejectNameRequest;
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[GnomeShortcut] D-Bus connection error:", err.message);
        rejectNameRequest?.(err);
      });
      const bus = this.bus;
      const nameReply = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          rejectNameRequest = null;
          this.cancelNameRequest = null;
          if (err) reject(err);
          else resolve(reply);
        };
        rejectNameRequest = (err) => finish(err);
        this.cancelNameRequest = () => finish(new Error("D-Bus name request cancelled"));
        const timeoutId = setTimeout(
          () => finish(new Error("D-Bus name request timed out")),
          DBUS_NAME_REQUEST_TIMEOUT_MS
        );
        // DO_NOT_QUEUE: another app instance must not leave us waiting for its name.
        bus.requestName(DBUS_SERVICE_NAME, 4, finish);
      });
      if (this.closed || this.bus !== bus || (nameReply !== 1 && nameReply !== 4)) {
        throw new Error(`D-Bus name request returned ${nameReply}`);
      }
      this.bus.exportInterface(
        {
          Toggle: () => {
            if (this.dictationCallback) {
              this.dictationCallback();
            }
          },
          ToggleMeeting: () => {
            if (this.meetingCallback) {
              this.meetingCallback();
            }
          },
          ToggleVoiceAgent: () => {
            if (this.voiceAgentCallback) {
              this.voiceAgentCallback();
            }
          },
          ToggleTranslation: () => {
            if (this.translationCallback) {
              this.translationCallback();
            }
          },
        },
        DBUS_OBJECT_PATH,
        {
          name: DBUS_INTERFACE,
          methods: {
            Toggle: ["", ""],
            ToggleMeeting: ["", ""],
            ToggleVoiceAgent: ["", ""],
            ToggleTranslation: ["", ""],
          },
        }
      );

      debugLogger.log("[GnomeShortcut] D-Bus service initialized successfully");
      await this.removeRetiredAgentKeybinding();
      return !this.closed;
    } catch (err) {
      debugLogger.log("[GnomeShortcut] Failed to initialize D-Bus service:", err.message);
      if (this.bus) {
        this.bus.connection.end();
        this.bus = null;
      }
      return false;
    }
  }

  async initGlobalShortcutsPortal() {
    if (this.closed) return false;
    return this.globalShortcutsPortal.init();
  }

  supportsPushToTalk() {
    // Unknown transport readiness is not evidence that Hold is unsupported.
    return (
      !this.globalShortcutsPortal.availabilityKnown || this.globalShortcutsPortal.isAvailable()
    );
  }

  async registerPushToTalk(hotkey, callback) {
    if (this.closed) return false;
    const preferredTrigger = GnomeShortcutManager.convertToPortalFormat(hotkey);
    if (!preferredTrigger) return false;

    if (!(await this.unregisterKeybinding("dictation")) || this.closed) return false;
    const registered = await this.globalShortcutsPortal.registerKeybinding(
      preferredTrigger,
      callback
    );
    if (!registered && !this.closed) {
      const tapShortcut = GnomeShortcutManager.convertToGnomeFormat(hotkey);
      await this.registerKeybinding(tapShortcut, "dictation");
    }
    return registered;
  }

  async unregisterPushToTalk() {
    await this.globalShortcutsPortal.unregisterKeybinding();
  }

  static isValidShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== "string") {
      return false;
    }
    return VALID_SHORTCUT_PATTERN.test(shortcut);
  }

  registerKeybinding(shortcut = "<Alt>r", slotName = "dictation") {
    return this._queueMutation(() => this._registerKeybinding(shortcut, slotName));
  }

  async _registerKeybinding(shortcut, slotName) {
    if (this.closed || this.registrationUncertain) return false;
    if (!GnomeShortcutManager.isGnome()) {
      debugLogger.log("[GnomeShortcut] Not running on GNOME, skipping registration");
      return false;
    }

    if (!GnomeShortcutManager.isValidShortcut(shortcut)) {
      debugLogger.log(
        `[GnomeShortcut] Invalid shortcut format: "${shortcut}" for slot "${slotName}"`
      );
      return false;
    }

    const { path: keybindingPath, name: keybindingName } = getSlotConfig(slotName);

    const SLOT_DBUS_METHOD = {
      dictation: "Toggle",
      meeting: "ToggleMeeting",
      voiceAgent: "ToggleVoiceAgent",
      translation: "ToggleTranslation",
    };
    const dbusMethod = SLOT_DBUS_METHOD[slotName] || "Toggle";
    const command = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${dbusMethod}`;

    let previousFields;
    let alreadyRegistered = false;
    let fieldsTouched = false;
    try {
      const existing = await this.getExistingKeybindings();
      alreadyRegistered = existing.includes(keybindingPath);

      // Check if another custom shortcut already uses this binding
      debugLogger.log("[GnomeShortcut] Checking for conflicts", {
        shortcut,
        existingPaths: existing,
        ownPath: keybindingPath,
      });
      const conflict = await this.findConflictingBinding(shortcut, existing, keybindingPath);
      if (conflict) {
        debugLogger.log(
          `[GnomeShortcut] Shortcut conflict — "${shortcut}" already used by "${conflict}"`,
          {
            slot: slotName,
            conflictPath: conflict,
          }
        );
        return false;
      }

      // Preserve raw GVariant values for rollback of an existing slot.
      previousFields = {};
      for (const field of ["name", "binding", "command"]) {
        previousFields[field] = (
          await this._gsettings(["get", `${KEYBINDING_SCHEMA}:${keybindingPath}`, field])
        ).trim();
      }
      if (this.closed) return false;
      fieldsTouched = true;
      this.registeredSlots.add(slotName); // teardown also owns partial writes
      for (const [field, value] of [
        ["name", keybindingName],
        ["binding", shortcut],
        ["command", command],
      ]) {
        await this._gsettings(["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, field, value]);
      }

      if (!alreadyRegistered) {
        const newBindings = [...existing, keybindingPath];
        const bindingsStr = "['" + newBindings.join("', '") + "']";
        await this._gsettings([
          "set",
          "org.gnome.settings-daemon.plugins.media-keys",
          "custom-keybindings",
          bindingsStr,
        ]);
      }

      if (this.closed) return false;
      this.registeredSlots.add(slotName);
      debugLogger.log(
        `[GnomeShortcut] Keybinding "${shortcut}" registered for slot "${slotName}" successfully`
      );
      return true;
    } catch (err) {
      if (fieldsTouched && !this.closed) {
        try {
          if (!alreadyRegistered) {
            // A timed-out list write might have applied. Read it again rather
            // than replacing unrelated paths from an old snapshot.
            const current = await this.getExistingKeybindings();
            const remaining = current.filter((entry) => entry !== keybindingPath);
            await this._gsettings([
              "set",
              "org.gnome.settings-daemon.plugins.media-keys",
              "custom-keybindings",
              remaining.length ? "['" + remaining.join("', '") + "']" : "[]",
            ]);
          }
          for (const [field, value] of Object.entries(previousFields)) {
            await this._gsettings(["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, field, value]);
          }
          if (!alreadyRegistered) this.registeredSlots.delete(slotName);
        } catch (rollbackErr) {
          this.registrationUncertain = true;
          debugLogger.log(
            "[GnomeShortcut] Failed to restore previous slot fields:",
            rollbackErr.message
          );
        }
      }
      debugLogger.log(
        `[GnomeShortcut] Failed to register keybinding for slot "${slotName}":`,
        err.message
      );
      return false;
    }
  }

  unregisterKeybinding(slotName = "dictation") {
    return this._queueMutation(() => this._unregisterKeybinding(slotName));
  }

  async _unregisterKeybinding(slotName) {
    const { path: keybindingPath } = getSlotConfig(slotName);

    try {
      const existing = await this.getExistingKeybindings(this.closed);
      const filtered = existing.filter((p) => p !== keybindingPath);

      if (filtered.length === 0) {
        await this._gsettings(
          ["set", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings", "[]"],
          this.closed
        );
      } else {
        const bindingsStr = "['" + filtered.join("', '") + "']";
        await this._gsettings(
          [
            "set",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
            bindingsStr,
          ],
          this.closed
        );
      }

      for (const field of ["name", "binding", "command"]) {
        await this._gsettings(
          ["reset", `${KEYBINDING_SCHEMA}:${keybindingPath}`, field],
          this.closed
        );
      }

      this.registeredSlots.delete(slotName);
      debugLogger.log(
        `[GnomeShortcut] Keybinding unregistered for slot "${slotName}" successfully`
      );
      return true;
    } catch (err) {
      debugLogger.log(
        `[GnomeShortcut] Failed to unregister keybinding for slot "${slotName}":`,
        err.message
      );
      return false;
    }
  }

  async findConflictingBinding(shortcut, existingPaths, ownPath) {
    // Normalize for comparison: <Primary> = <Control>, sort modifiers, case-insensitive
    const normalize = (s) => {
      const mods = [];
      const stripped = s.replace(/<(\w+)>/gi, (_, m) => {
        mods.push(m.toLowerCase() === "primary" ? "control" : m.toLowerCase());
        return "";
      });
      mods.sort();
      return mods.map((m) => `<${m}>`).join("") + stripped.toLowerCase();
    };
    const normalizedShortcut = normalize(shortcut);

    for (const path of existingPaths) {
      if (path === ownPath) continue;
      const binding = (await this._gsettings(["get", `${KEYBINDING_SCHEMA}:${path}`, "binding"]))
        .trim()
        .replace(/^'|'$/g, "");
      if (normalize(binding) === normalizedShortcut) return path;
    }
    return null;
  }

  async getExistingKeybindings(cleanup = false) {
    try {
      const output = await this._gsettings(
        ["get", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings"],
        cleanup
      );
      const match = output.match(/\[([^\]]*)\]/);
      if (!match) throw new Error("Malformed GNOME custom-keybindings list");

      const content = match[1];
      if (!content.trim()) return [];

      return content
        .split(",")
        .map((s) => s.trim().replace(/'/g, ""))
        .filter(Boolean);
    } catch (err) {
      debugLogger.log("[GnomeShortcut] Failed to read existing keybindings:", err.message);
      // Never overwrite the shared desktop list on a failed/timed-out read.
      throw err;
    }
  }

  static convertToGnomeFormat(hotkey) {
    if (!hotkey || typeof hotkey !== "string") {
      return "";
    }

    const parts = hotkey
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      return "";
    }

    const key = parts.pop();
    const keyLower = key.toLowerCase();
    const shiftedPunctuationKey = parts.some((mod) => mod.toLowerCase() === "shift")
      ? SHIFTED_PUNCTUATION_TO_GNOME_KEY_MAP[keyLower]
      : undefined;
    const modifiers = parts
      .map((mod) => {
        const m = mod.toLowerCase();
        if (m === "commandorcontrol" || m === "control" || m === "ctrl") return "<Control>";
        if (m === "alt") return "<Alt>";
        if (m === "shift" && shiftedPunctuationKey) return "";
        if (m === "shift") return "<Shift>";
        if (m === "super" || m === "meta") return "<Super>";
        return "";
      })
      .filter(Boolean)
      .join("");

    let gnomeKey;
    if (shiftedPunctuationKey) {
      gnomeKey = shiftedPunctuationKey;
    } else if (key === "`" || keyLower === "backquote") {
      gnomeKey = "grave";
    } else if (key === " ") {
      gnomeKey = "space";
    } else if (ELECTRON_TO_GNOME_KEY_MAP[keyLower]) {
      gnomeKey = ELECTRON_TO_GNOME_KEY_MAP[keyLower];
    } else if (/^F\d+$/i.test(key)) {
      gnomeKey = key.toUpperCase();
    } else {
      gnomeKey = keyLower;
    }

    return modifiers + gnomeKey;
  }

  static convertToPortalFormat(hotkey) {
    if (!hotkey || typeof hotkey !== "string") return "";

    const parts = hotkey
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    // The side is stripped because a lone "RightControl" is modifier-only too, and
    // the portal cannot bind a trigger that has no base key.
    if (
      parts.length === 0 ||
      parts.every((part) => PORTAL_MODIFIER_NAMES.has(part.toLowerCase().replace(/^right/, "")))
    ) {
      return "";
    }

    const key = parts.pop();
    const keyLower = key.toLowerCase();
    const modifiers = parts
      .map((modifier) => {
        const name = modifier.toLowerCase();
        if (name === "commandorcontrol" || name === "control" || name === "ctrl") return "CTRL";
        if (name === "alt") return "ALT";
        if (name === "shift") return "SHIFT";
        if (name === "super" || name === "meta") return "LOGO";
        return "";
      })
      .filter(Boolean);

    let portalKey;
    if (key === "`" || keyLower === "backquote") {
      portalKey = "grave";
    } else if (key === " ") {
      portalKey = "space";
    } else if (ELECTRON_TO_GNOME_KEY_MAP[keyLower]) {
      portalKey = ELECTRON_TO_GNOME_KEY_MAP[keyLower];
    } else if (/^F\d+$/i.test(key)) {
      portalKey = key.toUpperCase();
    } else {
      portalKey = keyLower;
    }

    return [...modifiers, portalKey].join("+");
  }

  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.commandController.abort(new Error("GNOME shortcut manager closed"));
    this.cancelNameRequest?.();
    const portalClose = this.globalShortcutsPortal.close();
    if (this.bus) {
      this.bus.connection.end();
      this.bus = null;
    }
    this.closeTask = this._queueMutation(async () => {
      let success = true;
      for (const slot of [...this.registeredSlots]) {
        if (!(await this._unregisterKeybinding(slot))) success = false;
      }
      await portalClose;
      return success;
    });
    return this.closeTask;
  }
}

module.exports = GnomeShortcutManager;
