const { execFileSync } = require("child_process");
const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

// Per-slot gsettings paths and display names
const SLOT_CONFIG = {
  dictation: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr/",
    name: "OpenWhispr Toggle",
  },
  agent: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-agent/",
    name: "OpenWhispr Agent",
  },
  meeting: {
    path: "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhispr-meeting/",
    name: "OpenWhispr Meeting",
  },
};

const KEYBINDING_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";

// Valid pattern for GNOME shortcut format using X11 keysym names (case-sensitive).
// Modifiers are case-insensitive (GTK normalizes them), keysyms are exact.
const VALID_SHORTCUT_PATTERN =
  /^(<(Control|Alt|Shift|Super)>)*(F([1-9]|1[0-9]|2[0-4])|[a-z0-9]|space|Escape|Tab|BackSpace|grave|Pause|Scroll_Lock|Insert|Delete|Home|End|Page_Up|Page_Down|Up|Down|Left|Right|Return|Print)$/;

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
};

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[GnomeShortcut] Failed to load dbus-next:", err.message);
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
    this.agentCallback = null;
    this.meetingCallback = null;
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

  /**
   * Set or update the agent callback after initial D-Bus service initialisation.
   * This supports the case where the dictation hotkey is set up first and the
   * agent callback is only available later (after agent window creation).
   */
  setAgentCallback(callback) {
    this.agentCallback = callback;
    if (this._ifaceRef) {
      this._ifaceRef._agentCallback = callback;
    }
    debugLogger.log("[GnomeShortcut] Agent callback registered");
  }

  setMeetingCallback(callback) {
    this.meetingCallback = callback;
    if (this._ifaceRef) {
      this._ifaceRef._meetingCallback = callback;
    }
    debugLogger.log("[GnomeShortcut] Meeting callback registered");
  }

  async initDBusService(dictationCallback) {
    this.dictationCallback = dictationCallback;

    const dbusModule = getDBus();
    if (!dbusModule) {
      return false;
    }

    try {
      this.bus = dbusModule.sessionBus();
      await this.bus.requestName(DBUS_SERVICE_NAME, 0);

      const InterfaceClass = this._createInterfaceClass(dbusModule);
      const iface = new InterfaceClass(dictationCallback, this.agentCallback, this.meetingCallback);
      // Keep a reference so setAgentCallback() can update it later
      this._ifaceRef = iface;
      this.bus.export(DBUS_OBJECT_PATH, iface);

      debugLogger.log("[GnomeShortcut] D-Bus service initialized successfully");
      return true;
    } catch (err) {
      debugLogger.log("[GnomeShortcut] Failed to initialize D-Bus service:", err.message);
      if (this.bus) {
        this.bus.disconnect();
        this.bus = null;
      }
      return false;
    }
  }

  _createInterfaceClass(dbusModule) {
    class OpenWhisprInterface extends dbusModule.interface.Interface {
      constructor(dictationCallback, agentCallback, meetingCallback) {
        super(DBUS_INTERFACE);
        this._dictationCallback = dictationCallback;
        this._agentCallback = agentCallback || null;
        this._meetingCallback = meetingCallback || null;
      }

      Toggle() {
        if (this._dictationCallback) {
          this._dictationCallback();
        }
      }

      ToggleAgent() {
        if (this._agentCallback) {
          this._agentCallback();
        }
      }

      ToggleMeeting() {
        if (this._meetingCallback) {
          this._meetingCallback();
        }
      }
    }

    OpenWhisprInterface.configureMembers({
      methods: {
        Toggle: { inSignature: "", outSignature: "" },
        ToggleAgent: { inSignature: "", outSignature: "" },
        ToggleMeeting: { inSignature: "", outSignature: "" },
      },
    });

    return OpenWhisprInterface;
  }

  static isValidShortcut(shortcut) {
    if (!shortcut || typeof shortcut !== "string") {
      return false;
    }
    return VALID_SHORTCUT_PATTERN.test(shortcut);
  }

  async registerKeybinding(shortcut = "<Alt>r", slotName = "dictation") {
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

    const SLOT_DBUS_METHOD = { dictation: "Toggle", agent: "ToggleAgent", meeting: "ToggleMeeting" };
    const dbusMethod = SLOT_DBUS_METHOD[slotName] || "Toggle";
    const command = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${dbusMethod}`;

    try {
      const existing = this.getExistingKeybindings();
      const alreadyRegistered = existing.includes(keybindingPath);

      // Check if another custom shortcut already uses this binding
      debugLogger.log("[GnomeShortcut] Checking for conflicts", {
        shortcut,
        existingPaths: existing,
        ownPath: keybindingPath,
      });
      const conflict = this.findConflictingBinding(shortcut, existing, keybindingPath);
      if (conflict) {
        debugLogger.log(`[GnomeShortcut] Shortcut conflict — "${shortcut}" already used by "${conflict}"`, {
          slot: slotName,
          conflictPath: conflict,
        });
        return false;
      }

      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "name", keybindingName],
        { stdio: "pipe" }
      );
      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "binding", shortcut],
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
        `[GnomeShortcut] Keybinding "${shortcut}" registered for slot "${slotName}" successfully`
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

  async updateKeybinding(shortcut, slotName = "dictation") {
    if (!this.registeredSlots.has(slotName)) {
      return this.registerKeybinding(shortcut, slotName);
    }

    if (!GnomeShortcutManager.isValidShortcut(shortcut)) {
      debugLogger.log(
        `[GnomeShortcut] Invalid shortcut format for update: "${shortcut}" (slot "${slotName}")`
      );
      return false;
    }

    const { path: keybindingPath } = getSlotConfig(slotName);

    try {
      const existing = this.getExistingKeybindings();
      const conflict = this.findConflictingBinding(shortcut, existing, keybindingPath);
      if (conflict) {
        debugLogger.log(`[GnomeShortcut] Shortcut conflict on update — "${shortcut}" already used by "${conflict}"`);
        return false;
      }

      execFileSync(
        "gsettings",
        ["set", `${KEYBINDING_SCHEMA}:${keybindingPath}`, "binding", shortcut],
        { stdio: "pipe" }
      );
      debugLogger.log(`[GnomeShortcut] Keybinding updated to "${shortcut}" for slot "${slotName}"`);
      return true;
    } catch (err) {
      debugLogger.log(
        `[GnomeShortcut] Failed to update keybinding for slot "${slotName}":`,
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

  findConflictingBinding(shortcut, existingPaths, ownPath) {
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
      try {
        const binding = execFileSync(
          "gsettings",
          ["get", `${KEYBINDING_SCHEMA}:${path}`, "binding"],
          { encoding: "utf-8" }
        ).trim().replace(/^'|'$/g, "");
        if (normalize(binding) === normalizedShortcut) return path;
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
    const modifiers = parts
      .map((mod) => {
        const m = mod.toLowerCase();
        if (m === "commandorcontrol" || m === "control" || m === "ctrl") return "<Control>";
        if (m === "alt") return "<Alt>";
        if (m === "shift") return "<Shift>";
        if (m === "super" || m === "meta") return "<Super>";
        return "";
      })
      .filter(Boolean)
      .join("");

    const keyLower = key.toLowerCase();

    let gnomeKey;
    if (key === "`" || keyLower === "backquote") {
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

  close() {
    if (this.bus) {
      this.bus.disconnect();
      this.bus = null;
    }
  }
}

module.exports = GnomeShortcutManager;
