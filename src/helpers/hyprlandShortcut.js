const { execFileSync } = require("child_process");
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

  /**
   * Register a keybinding in Hyprland using hyprctl keyword bind.
   * The binding executes a dbus-send command that calls our Toggle() method.
   */
  async registerKeybinding(hotkey) {
    if (!HyprlandShortcutManager.isHyprland()) {
      debugLogger.log("[HyprlandShortcut] Not running on Hyprland, skipping registration");
      return false;
    }

    const converted = HyprlandShortcutManager.convertToHyprlandFormat(hotkey);
    if (!converted) {
      debugLogger.log(`[HyprlandShortcut] Could not convert hotkey "${hotkey}" to Hyprland format`);
      return false;
    }

    try {
      // First unregister any existing binding
      if (this.currentBinding) {
        await this.unregisterKeybinding();
      }

      const dbusCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.Toggle`;

      // hyprctl keyword bind "MODS, key, exec, command"
      const bindValue = `${converted.bindKey}, exec, ${dbusCommand}`;

      execFileSync("hyprctl", ["keyword", "bind", bindValue], {
        stdio: "pipe",
        timeout: 5000,
      });

      this.currentBinding = converted.bindKey;
      this.isRegistered = true;
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

    try {
      execFileSync("hyprctl", ["keyword", "unbind", this.currentBinding], {
        stdio: "pipe",
        timeout: 5000,
      });

      debugLogger.log(
        `[HyprlandShortcut] Keybinding "${this.currentBinding}" unregistered successfully`
      );
      this.currentBinding = null;
      this.isRegistered = false;
      return true;
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to unregister keybinding:", err.message);
      // Even if unbind fails, clear state so we don't keep retrying
      this.currentBinding = null;
      this.isRegistered = false;
      return false;
    }
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
