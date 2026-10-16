const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");
const GnomeGlobalShortcutsPortal = require("./gnomeGlobalShortcutsPortal");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

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

// F13-F24 at the end of a GNOME accelerator ("<Control>F16") or a portal trigger ("CTRL+F16").
const EXTENDED_FUNCTION_KEY = /(?<=^|[>+])F(1[3-9]|2[0-4])$/;
const KEYMAP_QUERY_TIMEOUT_MS = 3000;

// The keysym the active keymap gives an xkb key name ("FK16"), null when the key has none,
// or undefined when the keymap can't be read. xkbcomp ships with XWayland (x11-xkb-utils).
function readKeymapKeysym(keyName) {
  const display = process.env.DISPLAY;
  if (!display) return undefined;
  let keymap;
  try {
    keymap = execFileSync("xkbcomp", ["-xkb", display, "-"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: KEYMAP_QUERY_TIMEOUT_MS,
    });
  } catch (err) {
    debugLogger.log("[GnomeShortcut] Could not read the keymap with xkbcomp:", err.message);
    return undefined;
  }
  if (!keymap.includes("xkb_symbols")) return undefined;
  // "key <FK16> { [ XF86Launch7 ] };" or "symbols[Group1]= [ XF86TouchpadOff, ... ]" inside a
  // multi-line entry, never another field's list such as actions[Group1]; a key with no
  // keysym has no entry at all.
  const entry = new RegExp(
    `key <${keyName}>\\s*\\{(?:[^}]*?symbols\\[[^\\]]*\\]\\s*=)?\\s*\\[\\s*([^\\s,\\]]+)`
  ).exec(keymap);
  return entry && entry[1] !== "NoSymbol" ? entry[1] : null;
}

// For comparison: <Primary> and <Ctrl> mean <Control>, modifier order and case don't matter.
function normalizeAccelerator(accelerator) {
  const mods = [];
  const key = accelerator.replace(/<(\w+)>/gi, (_, mod) => {
    const name = mod.toLowerCase();
    mods.push(name === "primary" || name === "ctrl" ? "control" : name);
    return "";
  });
  mods.sort();
  return mods.map((m) => `<${m}>`).join("") + key.toLowerCase();
}

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
    this.dictationCallback = null;
    this.meetingCallback = null;
    this.voiceAgentCallback = null;
    this.translationCallback = null;
    this.globalShortcutsPortal = new GnomeGlobalShortcutsPortal();
    // Track which slots have been registered in gsettings
    this.registeredSlots = new Set();
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
    const retiredPath =
      "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-agent/";
    try {
      const existing = this.getExistingKeybindings();
      if (!existing.includes(retiredPath)) return;
      const remaining = existing.filter((p) => p !== retiredPath);
      const bindingsStr = remaining.length ? "['" + remaining.join("', '") + "']" : "[]";
      execFileSync(
        "gsettings",
        ["set", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings", bindingsStr],
        { stdio: "pipe" }
      );
      execFileSync("gsettings", ["reset-recursively", `${KEYBINDING_SCHEMA}:${retiredPath}`], {
        stdio: "pipe",
      });
      debugLogger.log("[GnomeShortcut] Removed retired chat-agent keybinding");
    } catch (err) {
      debugLogger.log(
        "[GnomeShortcut] Failed to remove retired chat-agent keybinding:",
        err.message
      );
    }
  }

  async initDBusService(dictationCallback) {
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
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[GnomeShortcut] D-Bus connection error:", err.message);
      });
      this.bus.requestName(DBUS_SERVICE_NAME, 0);
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
      this.removeRetiredAgentKeybinding();
      return true;
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
    return this.globalShortcutsPortal.init();
  }

  supportsPushToTalk() {
    return this.globalShortcutsPortal.isAvailable();
  }

  async registerPushToTalk(hotkey, callback) {
    const preferredTrigger = GnomeShortcutManager.convertToPortalFormat(hotkey);
    if (!preferredTrigger) return false;
    const tapShortcut = GnomeShortcutManager.convertToGnomeFormat(hotkey);
    const resolved = this.resolveFunctionKey(tapShortcut);
    const { keysym, reason } = resolved;
    if (reason) {
      debugLogger.log(
        `[GnomeShortcut] GNOME can't grab "${tapShortcut}" for Hold with this keymap: ${reason}`
      );
      return reason;
    }

    await this.unregisterKeybinding("dictation");
    const registered = await this.globalShortcutsPortal.registerKeybinding(
      keysym ? preferredTrigger.replace(EXTENDED_FUNCTION_KEY, keysym) : preferredTrigger,
      callback
    );
    if (!registered) {
      await this.registerKeybinding(tapShortcut, "dictation", resolved);
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

  // resolved: resolveFunctionKey(shortcut) when the caller already has it.
  async registerKeybinding(shortcut = "<Alt>r", slotName = "dictation", resolved) {
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

    const { keysym, reason } = resolved ?? this.resolveFunctionKey(shortcut);
    if (reason) {
      debugLogger.log(
        `[GnomeShortcut] GNOME can't grab "${shortcut}" for slot "${slotName}" with this keymap: ${reason}`
      );
      return reason;
    }
    const binding = keysym ? shortcut.replace(EXTENDED_FUNCTION_KEY, keysym) : shortcut;

    const { path: keybindingPath, name: keybindingName } = getSlotConfig(slotName);

    const SLOT_DBUS_METHOD = {
      dictation: "Toggle",
      meeting: "ToggleMeeting",
      voiceAgent: "ToggleVoiceAgent",
      translation: "ToggleTranslation",
    };
    const dbusMethod = SLOT_DBUS_METHOD[slotName] || "Toggle";
    const command = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${dbusMethod}`;

    try {
      const existing = this.getExistingKeybindings();
      const alreadyRegistered = existing.includes(keybindingPath);

      // Check if another custom shortcut already uses this binding
      debugLogger.log("[GnomeShortcut] Checking for conflicts", {
        shortcut: binding,
        existingPaths: existing,
        ownPath: keybindingPath,
      });
      const conflict = this.findConflictingBinding(binding, existing, keybindingPath);
      if (conflict) {
        debugLogger.log(
          `[GnomeShortcut] Shortcut conflict — "${binding}" already used by "${conflict}"`,
          {
            slot: slotName,
            conflictPath: conflict,
          }
        );
        return false;
      }

      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "name", keybindingName],
        { stdio: "pipe" }
      );
      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "binding", binding],
        { stdio: "pipe" }
      );
      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "command", command],
        { stdio: "pipe" }
      );

      if (!alreadyRegistered) {
        const newBindings = [...existing, keybindingPath];
        const bindingsStr = "['" + newBindings.join("', '") + "']";
        execFileSync(
          "gsettings",
          [
            "set",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
            bindingsStr,
          ],
          { stdio: "pipe" }
        );
      }

      this.registeredSlots.add(slotName);
      debugLogger.log(
        `[GnomeShortcut] Keybinding "${binding}" registered for slot "${slotName}" successfully`
      );
      return true;
    } catch (err) {
      debugLogger.log(
        `[GnomeShortcut] Failed to register keybinding for slot "${slotName}":`,
        err.message
      );
      return false;
    }
  }

  async unregisterKeybinding(slotName = "dictation") {
    const { path: keybindingPath } = getSlotConfig(slotName);

    try {
      const existing = this.getExistingKeybindings();
      const filtered = existing.filter((p) => p !== keybindingPath);

      if (filtered.length === 0) {
        execFileSync(
          "gsettings",
          ["set", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings", "[]"],
          { stdio: "pipe" }
        );
      } else {
        const bindingsStr = "['" + filtered.join("', '") + "']";
        execFileSync(
          "gsettings",
          [
            "set",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
            bindingsStr,
          ],
          { stdio: "pipe" }
        );
      }

      execFileSync("gsettings", ["reset", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "name"], {
        stdio: "pipe",
      });
      execFileSync("gsettings", ["reset", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "binding"], {
        stdio: "pipe",
      });
      execFileSync("gsettings", ["reset", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "command"], {
        stdio: "pipe",
      });

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

  // Stock xkeyboard-config gives the F13-F24 keys XF86 keysyms (F16 sends XF86Launch7) and
  // no F13-F24 keysym at all, and GNOME can only grab a keysym the keymap carries. Returns
  // the keysym to bind instead, the reason GNOME can't grab the key, or {} to keep it.
  resolveFunctionKey(accelerator) {
    const match = EXTENDED_FUNCTION_KEY.exec(accelerator);
    if (!match) return {};
    const keysym = readKeymapKeysym(`FK${match[1]}`);
    if (keysym === undefined || keysym === match[0]) return {};
    if (keysym === null) return { reason: "keysym_missing" };
    if (this.isMediaKeyBinding(accelerator.replace(EXTENDED_FUNCTION_KEY, keysym))) {
      return { reason: "keysym_reserved" };
    }
    return { keysym };
  }

  // gsd-media-keys already grabs the hardware keys GNOME handles itself (XF86Tools opens
  // Settings, XF86AudioMicMute mutes the mic), so a custom shortcut on one never fires.
  isMediaKeyBinding(accelerator) {
    let settings;
    try {
      settings = execFileSync(
        "gsettings",
        ["list-recursively", "org.gnome.settings-daemon.plugins.media-keys"],
        { encoding: "utf-8" }
      );
    } catch (err) {
      debugLogger.log("[GnomeShortcut] Failed to read GNOME media key bindings:", err.message);
      return false;
    }
    const target = normalizeAccelerator(accelerator);
    return [...settings.matchAll(/'([^']*)'/g)].some(
      ([, binding]) => normalizeAccelerator(binding) === target
    );
  }

  findConflictingBinding(shortcut, existingPaths, ownPath) {
    const normalizedShortcut = normalizeAccelerator(shortcut);

    for (const path of existingPaths) {
      if (path === ownPath) continue;
      try {
        const binding = execFileSync(
          "gsettings",
          ["get", `${KEYBINDING_SCHEMA}:${path}`, "binding"],
          { encoding: "utf-8" }
        )
          .trim()
          .replace(/^'|'$/g, "");
        if (normalizeAccelerator(binding) === normalizedShortcut) return path;
      } catch {}
    }
    return null;
  }

  getExistingKeybindings() {
    try {
      const output = execFileSync(
        "gsettings",
        ["get", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings"],
        { encoding: "utf-8" }
      );
      const match = output.match(/\[([^\]]*)\]/);
      if (!match) return [];

      const content = match[1];
      if (!content.trim()) return [];

      return content
        .split(",")
        .map((s) => s.trim().replace(/'/g, ""))
        .filter(Boolean);
    } catch (err) {
      debugLogger.log("[GnomeShortcut] Failed to read existing keybindings:", err.message);
      return [];
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

  async close() {
    await this.globalShortcutsPortal.close();
    if (this.bus) {
      this.bus.connection.end();
      this.bus = null;
    }
  }
}

module.exports = GnomeShortcutManager;
