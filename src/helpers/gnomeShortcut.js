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
};

const KEYBINDING_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";

// Valid pattern for GNOME shortcut format (e.g., "<Alt>r", "<Control><Shift>space")
// Supports: letters/digits, function keys (F1-F24), navigation, and special keys
const VALID_SHORTCUT_PATTERN =
  /^(<(Control|Alt|Shift|Super)>)*(F([1-9]|1[0-9]|2[0-4])|[a-z0-9]|space|escape|tab|backspace|grave|pause|scroll_lock|insert|delete|home|end|page_up|page_down|up|down|left|right|return|print)$/i;

// Map Electron key names to GNOME keysym names
const ELECTRON_TO_GNOME_KEY_MAP = {
  pageup: "page_up",
  pagedown: "page_down",
  scrolllock: "scroll_lock",
  printscreen: "print",
  enter: "return",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
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
      const iface = new InterfaceClass(dictationCallback, this.agentCallback);
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
      constructor(dictationCallback, agentCallback) {
        super(DBUS_INTERFACE);
        this._dictationCallback = dictationCallback;
        this._agentCallback = agentCallback || null;
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
    }

    OpenWhisprInterface.configureMembers({
      methods: {
        Toggle: { inSignature: "", outSignature: "" },
        ToggleAgent: { inSignature: "", outSignature: "" },
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

    // The dbus-send command for agent uses ToggleAgent, dictation uses Toggle
    const dbusMethod = slotName === "agent" ? "ToggleAgent" : "Toggle";
    const command = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${dbusMethod}`;

    try {
      const existing = this.getExistingKeybindings();
      const alreadyRegistered = existing.includes(keybindingPath);

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

    let gnomeKey = key.toLowerCase();

    if (gnomeKey === "`" || gnomeKey === "backquote") {
      gnomeKey = "grave";
    }
    if (gnomeKey === " ") {
      gnomeKey = "space";
    }
    if (ELECTRON_TO_GNOME_KEY_MAP[gnomeKey]) {
      gnomeKey = ELECTRON_TO_GNOME_KEY_MAP[gnomeKey];
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
