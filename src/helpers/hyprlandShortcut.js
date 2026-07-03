const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";

// Map Electron modifier names to Hyprland modifier names
const ELECTRON_TO_HYPRLAND_MOD = {
  commandorcontrol: "CTRL",
  control: "CTRL",
  ctrl: "CTRL",
  alt: "ALT",
  option: "ALT",
  shift: "SHIFT",
  super: "SUPER",
  meta: "SUPER",
  win: "SUPER",
  command: "SUPER",
  cmd: "SUPER",
  cmdorctrl: "CTRL",
};

// Map Electron key names to Hyprland key names
const ELECTRON_TO_HYPRLAND_KEY = {
  pageup: "Page_Up",
  pagedown: "Page_Down",
  scrolllock: "Scroll_Lock",
  printscreen: "Print",
  enter: "Return",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  backquote: "grave",
  "`": "grave",
  " ": "space",
};

// Valid Electron-format hotkey: optional modifiers joined by +, ending with a key
// Supports: standalone keys (F4, Space), modifier+key combos, and modifier-only combos (Control+Super)
const VALID_HOTKEY_PATTERN =
  /^((CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|Shift|Super|Meta|Win|Command|Cmd)(\+(CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|Shift|Super|Meta|Win|Command|Cmd))*(\+)?)?(F([1-9]|1[0-9]|2[0-4])|[A-Za-z0-9]|Space|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|PrintScreen|ScrollLock|Pause|Backquote|`)?$/i;

const BINDS_FILENAME = "openwhispr-binds.conf";
const MANAGED_HEADER_LINES = [
  "# OpenWhispr keybinds (managed automatically)",
  "# If you delete this file, also remove the matching source line from your Hyprland config.",
];

function isManagedHeaderLine(line) {
  return MANAGED_HEADER_LINES.includes(line.trim());
}

function buildManagedBindsContent(lines = []) {
  const body = lines.join("\n").trim();
  return MANAGED_HEADER_LINES.join("\n") + "\n" + (body ? body + "\n" : "");
}

function getHyprConfigDir() {
  if (process.env.HYPRLAND_CONFIG) {
    return path.dirname(path.resolve(process.env.HYPRLAND_CONFIG));
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "hypr");
}

function getHyprlandConfPath() {
  if (process.env.HYPRLAND_CONFIG) {
    return path.resolve(process.env.HYPRLAND_CONFIG);
  }
  return path.join(getHyprConfigDir(), "hyprland.conf");
}

function getBindsFilePath() {
  return path.join(getHyprConfigDir(), BINDS_FILENAME);
}

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("dbus-next");
    return dbus;
  } catch (err) {
    debugLogger.log("[HyprlandShortcut] Failed to load dbus-next:", err.message);
    return null;
  }
}

class HyprlandShortcutManager {
  constructor() {
    this.bus = null;
    this.callback = null;
    this.isRegistered = false;
    this.currentBinding = null; // Store the current Hyprland bind string for unbinding
  }

  /**
   * Detect if the current session is running on Hyprland.
   * Checks the HYPRLAND_INSTANCE_SIGNATURE env var (most reliable)
   * and falls back to XDG_CURRENT_DESKTOP.
   */
  static isHyprland() {
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
      return true;
    }
    const desktop = (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase();
    return desktop.includes("hyprland");
  }

  static isWayland() {
    return process.env.XDG_SESSION_TYPE === "wayland";
  }

  /**
   * Check if hyprctl is available on the system.
   */
  static isHyprctlAvailable() {
    try {
      execFileSync("hyprctl", ["version"], { stdio: "pipe", timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a D-Bus service to receive Toggle() calls from Hyprland keybindings.
   * Reuses the same D-Bus service name/path as the GNOME integration.
   */
  async initDBusService(callback) {
    this.callback = callback;

    const dbusModule = getDBus();
    if (!dbusModule) {
      return false;
    }

    try {
      this.bus = dbusModule.sessionBus();
      await this.bus.requestName(DBUS_SERVICE_NAME, 0);

      const InterfaceClass = this._createInterfaceClass(dbusModule, callback);
      const iface = new InterfaceClass();
      this.bus.export(DBUS_OBJECT_PATH, iface);

      debugLogger.log("[HyprlandShortcut] D-Bus service initialized successfully");
      return true;
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to initialize D-Bus service:", err.message);
      if (this.bus) {
        this.bus.disconnect();
        this.bus = null;
      }
      return false;
    }
  }

  _createInterfaceClass(dbusModule, callback) {
    class OpenWhisprInterface extends dbusModule.interface.Interface {
      constructor() {
        super(DBUS_INTERFACE);
        this._callback = callback;
      }

      Toggle() {
        if (this._callback) {
          this._callback();
        }
      }
    }

    OpenWhisprInterface.configureMembers({
      methods: {
        Toggle: { inSignature: "", outSignature: "" },
      },
    });

    return OpenWhisprInterface;
  }

  static isValidHotkey(hotkey) {
    if (!hotkey || typeof hotkey !== "string") {
      return false;
    }
    return VALID_HOTKEY_PATTERN.test(hotkey);
  }

  /**
   * Convert an Electron-format hotkey string to Hyprland bind format.
   *
   * Electron format: "Control+Super", "Alt+R", "CommandOrControl+Shift+Space"
   * Hyprland format: "CTRL SUPER", "ALT, R" (mods space-separated, comma before key)
   *
   * For modifier-only combos (e.g. "Control+Super"), Hyprland expects:
   *   bind = CTRL, Super_L, exec, ...
   * where the last modifier is treated as the trigger key.
   *
   * Returns { mods, key } where mods is the modifier string and key is the trigger key,
   * or null if the hotkey can't be converted.
   */
  static convertToHyprlandFormat(hotkey) {
    if (!hotkey || typeof hotkey !== "string") {
      return null;
    }

    const parts = hotkey
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length === 0) {
      return null;
    }

    // Separate modifiers from the key
    const modifiers = [];
    let key = null;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const modName = ELECTRON_TO_HYPRLAND_MOD[part.toLowerCase()];
      if (modName) {
        modifiers.push(modName);
      } else {
        // This is the actual key (should be the last part)
        key = part;
      }
    }

    // If no key was found (modifier-only combo like "Control+Super"),
    // use the last modifier as the trigger key in XKB format
    if (!key && modifiers.length >= 2) {
      const triggerMod = modifiers.pop();
      const modToXkbKey = {
        CTRL: "Control_L",
        ALT: "Alt_L",
        SHIFT: "Shift_L",
        SUPER: "Super_L",
      };
      key = modToXkbKey[triggerMod] || triggerMod;
    } else if (!key && modifiers.length === 1) {
      // Single modifier -- can't create a useful bind
      return null;
    }

    // Convert special key names
    if (key) {
      const mappedKey = ELECTRON_TO_HYPRLAND_KEY[key.toLowerCase()];
      if (mappedKey) {
        key = mappedKey;
      }
    }

    // Deduplicate modifiers (e.g. if "Control+Ctrl" was somehow passed)
    const uniqueMods = [...new Set(modifiers)];

    return {
      mods: uniqueMods.join(" "),
      key: key,
      // Full bind key string for hyprctl keyword bind/unbind
      bindKey: uniqueMods.length > 0 ? `${uniqueMods.join(" ")}, ${key}` : `, ${key}`,
    };
  }

  _writeBindToConfig(bindLine) {
    const bindsFile = getBindsFilePath();
    fs.mkdirSync(path.dirname(bindsFile), { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(bindsFile, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isManagedHeaderLine(trimmed)) return false;
      if (trimmed.startsWith("#")) return true;
      return !trimmed.includes(DBUS_SERVICE_NAME);
    });

    const newContent = buildManagedBindsContent([...lines, bindLine]);

    fs.writeFileSync(bindsFile, newContent, "utf-8");
  }

  _removeBindFromConfig() {
    const bindsFile = getBindsFilePath();
    let content = "";
    try {
      content = fs.readFileSync(bindsFile, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isManagedHeaderLine(trimmed)) return false;
      if (trimmed.startsWith("#")) return true;
      return !trimmed.includes(DBUS_SERVICE_NAME);
    });

    fs.writeFileSync(bindsFile, buildManagedBindsContent(lines), "utf-8");
  }

  _ensureSourceInMainConfig() {
    const mainConfig = getHyprlandConfPath();
    let content;
    try {
      content = fs.readFileSync(mainConfig, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const sourceLine = `source = ./${BINDS_FILENAME}`;
    if (content.includes(`./${BINDS_FILENAME}`)) return;

    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(mainConfig, `${separator}${sourceLine}\n`, "utf-8");
    debugLogger.log("[HyprlandShortcut] Added source directive to hyprland.conf");
  }

  static getHyprlandConfigStatus() {
    const mainConfig = getHyprlandConfPath();
    const status = {
      path: mainConfig,
      canWrite: false,
    };

    try {
      fs.accessSync(mainConfig, fs.constants.F_OK);
      try {
        fs.accessSync(mainConfig, fs.constants.W_OK);
        status.canWrite = true;
      } catch {
        debugLogger.log("[HyprlandShortcut] Hyprland config is not writable:", mainConfig);
      }
    } catch {
      debugLogger.log("[HyprlandShortcut] Hyprland config not found:", mainConfig);
    }

    return status;
  }

  /**
   * Register a keybinding in Hyprland using hyprctl keyword bind.
   * The binding executes a dbus-send command that calls our Toggle() method.
   *
   * Also writes the bind to openwhispr-binds.conf (sourced from hyprland.conf)
   * so it survives `hyprctl reload`.
   */
  async registerKeybinding(hotkey) {
    if (!HyprlandShortcutManager.isHyprland()) {
      debugLogger.log("[HyprlandShortcut] Not running on Hyprland, skipping registration");
      return false;
    }

    if (!HyprlandShortcutManager.isValidHotkey(hotkey)) {
      debugLogger.log(`[HyprlandShortcut] Invalid hotkey format: "${hotkey}"`);
      return false;
    }

    const converted = HyprlandShortcutManager.convertToHyprlandFormat(hotkey);
    if (!converted) {
      debugLogger.log(`[HyprlandShortcut] Could not convert hotkey "${hotkey}" to Hyprland format`);
      return false;
    }

    try {
      // First unregister any existing OpenWhispr binding if the hotkey changed.
      if (this.currentBinding && this.currentBinding !== converted.bindKey) {
        await this.unregisterKeybinding();
      }

      const dbusCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`;

      // hyprctl keyword bind "MODS, key, exec, command"
      const bindValue = `${converted.bindKey}, exec, ${dbusCommand}`;

      try {
        execFileSync("hyprctl", ["keyword", "unbind", converted.bindKey], {
          stdio: "pipe",
          timeout: 5000,
        });
      } catch (err) {
        debugLogger.log(
          `[HyprlandShortcut] Pre-bind unbind for "${converted.bindKey}" failed, continuing:`,
          err.message
        );
      }

      execFileSync("hyprctl", ["keyword", "bind", bindValue], {
        stdio: "pipe",
        timeout: 5000,
      });

      this.currentBinding = converted.bindKey;
      this.isRegistered = true;

      try {
        this._writeBindToConfig(`bind = ${bindValue}`);
        this._ensureSourceInMainConfig();
      } catch (err) {
        debugLogger.log(
          "[HyprlandShortcut] Failed to persist keybinding; runtime bind is still active:",
          err.message
        );
      }

      debugLogger.log(
        `[HyprlandShortcut] Keybinding "${hotkey}" (${converted.bindKey}) registered successfully`
      );
      return true;
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to register keybinding:", err.message);
      return false;
    }
  }

  /**
   * Update the keybinding to a new hotkey.
   */
  async updateKeybinding(hotkey) {
    // Just unregister old and register new
    return this.registerKeybinding(hotkey);
  }

  /**
   * Unregister the current keybinding from Hyprland.
   */
  async unregisterKeybinding() {
    if (!this.currentBinding) {
      this.isRegistered = false;
      return true;
    }

    const binding = this.currentBinding;

    try {
      execFileSync("hyprctl", ["keyword", "unbind", binding], {
        stdio: "pipe",
        timeout: 5000,
      });
    } catch (err) {
      debugLogger.log(`[HyprlandShortcut] Runtime unbind for "${binding}" failed:`, err.message);
    }

    try {
      this._removeBindFromConfig();
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to remove persisted keybinding:", err.message);
    }

    debugLogger.log(`[HyprlandShortcut] Keybinding "${binding}" unregistered successfully`);
    this.currentBinding = null;
    this.isRegistered = false;
    return true;
  }

  /**
   * Clean up D-Bus connection.
   */
  close() {
    if (this.bus) {
      this.bus.disconnect();
      this.bus = null;
    }
  }
}

module.exports = HyprlandShortcutManager;
