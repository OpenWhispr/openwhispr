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
  // Punctuation must be XKB names; a literal "," is the bind delimiter.
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
};

// Valid Electron-format hotkey: optional modifiers joined by +, ending with a key
// Supports: standalone keys (F4, Space), modifier+key combos, and modifier-only combos (Control+Super)
const VALID_HOTKEY_PATTERN =
  /^((CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|Shift|Super|Meta|Win|Command|Cmd)(\+(CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|Shift|Super|Meta|Win|Command|Cmd))*(\+)?)?(F([1-9]|1[0-9]|2[0-4])|[A-Za-z0-9]|Space|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Enter|PrintScreen|ScrollLock|Pause|Backquote|`|,|\.|\/|-|=|;|'|\[|\]|\\|Plus)?$/i;

const BINDS_FILENAMES = {
  conf: "openwhispr-binds.conf",
  lua: "openwhispr-binds.lua",
};
const MANAGED_HEADER_TEXT = [
  "OpenWhispr keybinds (managed automatically)",
  "If you delete this file, also remove the matching load line from your Hyprland config.",
];
const MANAGED_HEADER_VARIANTS = new Set([
  ...MANAGED_HEADER_TEXT,
  "If you delete this file, also remove the matching source line from your Hyprland config.",
]);

function isManagedHeaderLine(line) {
  return MANAGED_HEADER_VARIANTS.has(line.trim().replace(/^(#|--)\s*/, ""));
}

function buildManagedBindsContent(lines = [], format = "conf") {
  const body = lines.join("\n").trim();
  const comment = format === "lua" ? "--" : "#";
  const header = MANAGED_HEADER_TEXT.map((line) => `${comment} ${line}`).join("\n");
  return header + "\n" + (body ? body + "\n" : "");
}

function buildLuaBindExpression(luaKeys, dbusCommand, flags = "") {
  return `hl.bind(${JSON.stringify(luaKeys)}, hl.dsp.exec_cmd(${JSON.stringify(
    dbusCommand
  )})${flags ? `, ${flags}` : ""})`;
}

function runHyprctl(args) {
  const output = execFileSync("hyprctl", args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5000,
  });
  const response = Buffer.isBuffer(output) ? output.toString("utf8").trim() : String(output).trim();

  if (response !== "ok") {
    throw new Error(response || `hyprctl ${args[0]} returned an empty response`);
  }
}

function isModifierOnlyHotkey(hotkey) {
  const parts = hotkey
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return parts.length > 0 && parts.every((part) => ELECTRON_TO_HYPRLAND_MOD[part]);
}

function getHyprConfigDir() {
  if (process.env.HYPRLAND_CONFIG) {
    return path.dirname(path.resolve(process.env.HYPRLAND_CONFIG));
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "hypr");
}

let cachedHyprlandConfig = null;

function getHyprlandConfig() {
  if (cachedHyprlandConfig) return cachedHyprlandConfig;

  if (process.env.HYPRLAND_CONFIG) {
    const configPath = path.resolve(process.env.HYPRLAND_CONFIG);
    const format = path.extname(configPath).toLowerCase() === ".lua" ? "lua" : "conf";
    cachedHyprlandConfig = {
      path: configPath,
      format,
      bindsPath: getBindsFilePath(configPath, format),
    };
    return cachedHyprlandConfig;
  }

  const configDir = getHyprConfigDir();
  let format = "conf";
  try {
    const systemInfo = execFileSync("hyprctl", ["systeminfo"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 3000,
    });
    const provider = systemInfo.match(/configProvider:\s*(\S+)/i)?.[1]?.toLowerCase();
    if (
      provider === "lua" ||
      (provider !== "hyprlang" && fs.existsSync(path.join(configDir, "hyprland.lua")))
    ) {
      format = "lua";
    }
  } catch {
    if (fs.existsSync(path.join(configDir, "hyprland.lua"))) format = "lua";
  }

  const configPath = path.join(configDir, `hyprland.${format}`);
  cachedHyprlandConfig = {
    path: configPath,
    format,
    bindsPath: getBindsFilePath(configPath, format),
  };
  return cachedHyprlandConfig;
}

function getBindsFilePath(configPath, format) {
  return path.join(path.dirname(configPath), BINDS_FILENAMES[format]);
}

let dbus = null;

function getDBus() {
  if (dbus) return dbus;
  try {
    dbus = require("@homebridge/dbus-native");
    return dbus;
  } catch (err) {
    debugLogger.log("[HyprlandShortcut] Failed to load dbus-native:", err.message);
    return null;
  }
}

class HyprlandShortcutManager {
  constructor() {
    this.bus = null;
    this.callback = null;
    this.isRegistered = false;
    this.currentBinding = null; // Store the current Hyprland bind string for unbinding
    this.config = null;
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
   * Initialize a D-Bus service to receive hotkey events from Hyprland keybindings.
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
      // Without a listener, async socket errors (e.g. a stale
      // DBUS_SESSION_BUS_ADDRESS) crash the process as an unhandled
      // "error" event — sessionBus() returns before connecting.
      this.bus.connection.on("error", (err) => {
        debugLogger.log("[HyprlandShortcut] D-Bus connection error:", err.message);
      });
      this.bus.requestName(DBUS_SERVICE_NAME, 0);
      this.bus.exportInterface(
        {
          Toggle: () => {
            if (this.callback) {
              this.callback();
            }
          },
          PttDown: () => {
            if (this.callback) {
              this.callback(undefined, "down");
            }
          },
          PttUp: () => {
            if (this.callback) {
              this.callback(undefined, "up");
            }
          },
        },
        DBUS_OBJECT_PATH,
        {
          name: DBUS_INTERFACE,
          methods: {
            Toggle: ["", ""],
            PttDown: ["", ""],
            PttUp: ["", ""],
          },
        }
      );

      debugLogger.log("[HyprlandShortcut] D-Bus service initialized successfully");
      return true;
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to initialize D-Bus service:", err.message);
      if (this.bus) {
        this.bus.connection.end();
        this.bus = null;
      }
      return false;
    }
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
      luaKeys: [...uniqueMods, key].filter(Boolean).join(" + ").toUpperCase(),
      // Full bind key string for hyprctl keyword bind/unbind
      bindKey: uniqueMods.length > 0 ? `${uniqueMods.join(" ")}, ${key}` : `, ${key}`,
    };
  }

  _writeBindToConfig(config, bindLines) {
    fs.mkdirSync(path.dirname(config.bindsPath), { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(config.bindsPath, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isManagedHeaderLine(trimmed)) return false;
      if (trimmed.startsWith("#") || trimmed.startsWith("--")) return true;
      return !trimmed.includes(DBUS_SERVICE_NAME);
    });

    const managedBindLines = Array.isArray(bindLines) ? bindLines : [bindLines];
    const newContent = buildManagedBindsContent([...lines, ...managedBindLines], config.format);

    fs.writeFileSync(config.bindsPath, newContent, "utf-8");
  }

  _removeBindFromConfig(config) {
    let content = "";
    try {
      content = fs.readFileSync(config.bindsPath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const lines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || isManagedHeaderLine(trimmed)) return false;
      if (trimmed.startsWith("#") || trimmed.startsWith("--")) return true;
      return !trimmed.includes(DBUS_SERVICE_NAME);
    });

    fs.writeFileSync(config.bindsPath, buildManagedBindsContent(lines, config.format), "utf-8");
  }

  _ensureSourceInMainConfig(config) {
    let content;
    try {
      content = fs.readFileSync(config.path, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }

    const sourceLine =
      config.format === "lua"
        ? `pcall(require, ${JSON.stringify(config.bindsPath)})`
        : `source = ${config.bindsPath}`;
    const lines = content.split("\n").filter((line) => {
      if (!line.includes(BINDS_FILENAMES[config.format])) return true;
      const trimmed = line.trim();
      return config.format === "lua"
        ? !/^(?:dofile|require)\s*\(|^pcall\s*\(\s*require\s*,/.test(trimmed)
        : !/^source\s*=/.test(trimmed);
    });

    let insertionIndex = lines.length;
    while (insertionIndex > 0 && lines[insertionIndex - 1] === "") insertionIndex -= 1;
    if (config.format === "lua") {
      let lastStatementIndex = insertionIndex - 1;
      while (lastStatementIndex >= 0 && lines[lastStatementIndex].trim().startsWith("--")) {
        lastStatementIndex -= 1;
      }
      if (/^return\b/.test((lines[lastStatementIndex] || "").trim())) {
        insertionIndex = lastStatementIndex;
      }
    }
    lines.splice(insertionIndex, 0, sourceLine);

    const newContent = lines.join("\n");
    if (newContent === content) return true;

    fs.writeFileSync(config.path, newContent, "utf-8");
    debugLogger.log(`[HyprlandShortcut] Added binding load directive to ${config.path}`);
    return true;
  }

  _removeLegacyArtifacts(config) {
    if (config.format !== "lua") return;

    const configDir = path.dirname(config.path);
    const legacyConfigPath = path.join(configDir, "hyprland.conf");
    const legacyBindsPath = path.join(configDir, BINDS_FILENAMES.conf);

    try {
      const content = fs.readFileSync(legacyConfigPath, "utf-8");
      const newContent = content
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !(trimmed.includes(BINDS_FILENAMES.conf) && /^source\s*=/.test(trimmed));
        })
        .join("\n");
      if (newContent !== content) fs.writeFileSync(legacyConfigPath, newContent, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    try {
      const content = fs.readFileSync(legacyBindsPath, "utf-8");
      if (content.includes(MANAGED_HEADER_TEXT[0]) || content.includes(DBUS_SERVICE_NAME)) {
        fs.unlinkSync(legacyBindsPath);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  _getConfig() {
    if (!this.config) this.config = getHyprlandConfig();
    return this.config;
  }

  _unbindRuntime(config, binding) {
    const args =
      config.format === "lua"
        ? ["eval", `hl.unbind(${JSON.stringify(binding)})`]
        : ["keyword", "unbind", binding];
    runHyprctl(args);
  }

  _bindRuntime(config, converted, isPushToTalk, pressCommand, releaseCommand) {
    const runtimeBinding = config.format === "lua" ? converted.luaKeys : converted.bindKey;

    if (config.format === "lua") {
      runHyprctl([
        "eval",
        buildLuaBindExpression(
          converted.luaKeys,
          pressCommand,
          isPushToTalk ? "{ transparent = true }" : ""
        ),
      ]);
      if (isPushToTalk) {
        try {
          runHyprctl([
            "eval",
            buildLuaBindExpression(
              converted.luaKeys,
              releaseCommand,
              "{ release = true, transparent = true }"
            ),
          ]);
        } catch (err) {
          try {
            this._unbindRuntime(config, runtimeBinding);
          } catch {}
          throw err;
        }
      }
      return runtimeBinding;
    }

    const bindValue = `${converted.bindKey}, exec, ${pressCommand}`;
    runHyprctl(["keyword", isPushToTalk ? "bindt" : "bind", bindValue]);
    if (isPushToTalk) {
      try {
        runHyprctl(["keyword", "bindrt", `${converted.bindKey}, exec, ${releaseCommand}`]);
      } catch (err) {
        try {
          this._unbindRuntime(config, runtimeBinding);
        } catch {}
        throw err;
      }
    }
    return runtimeBinding;
  }

  static getHyprlandConfigStatus() {
    const mainConfig = getHyprlandConfig().path;
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
   * Register a keybinding using the runtime API for the active config provider.
   * The binding executes a dbus-send command that calls our Toggle() method.
   *
   * Also writes the bind to a format-specific config file so it survives
   * `hyprctl reload`.
   */
  async registerKeybinding(hotkey, isPushToTalk = false) {
    if (!HyprlandShortcutManager.isHyprland()) {
      debugLogger.log("[HyprlandShortcut] Not running on Hyprland, skipping registration");
      return false;
    }

    if (!HyprlandShortcutManager.isValidHotkey(hotkey)) {
      debugLogger.log(`[HyprlandShortcut] Invalid hotkey format: "${hotkey}"`);
      return false;
    }

    if (isPushToTalk && isModifierOnlyHotkey(hotkey)) {
      debugLogger.log(
        `[HyprlandShortcut] Modifier-only hotkey "${hotkey}" does not support push-to-talk`
      );
      return false;
    }

    const converted = HyprlandShortcutManager.convertToHyprlandFormat(hotkey);
    if (!converted) {
      debugLogger.log(`[HyprlandShortcut] Could not convert hotkey "${hotkey}" to Hyprland format`);
      return false;
    }

    try {
      const config = this._getConfig();
      const runtimeBinding = config.format === "lua" ? converted.luaKeys : converted.bindKey;

      // First unregister any existing OpenWhispr binding if the hotkey changed.
      if (this.currentBinding && this.currentBinding !== runtimeBinding) {
        const unregistered = await this.unregisterKeybinding();
        if (!unregistered) return false;
      }

      const pressCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${isPushToTalk ? "PttDown" : "Toggle"}`;
      const releaseCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.PttUp`;

      try {
        this._unbindRuntime(config, runtimeBinding);
      } catch (err) {
        debugLogger.log(
          `[HyprlandShortcut] Pre-bind unbind for "${runtimeBinding}" failed, continuing:`,
          err.message
        );
      }

      this._bindRuntime(config, converted, isPushToTalk, pressCommand, releaseCommand);

      this.currentBinding = runtimeBinding;
      this.isRegistered = true;

      try {
        const persistedPressBind =
          config.format === "lua"
            ? buildLuaBindExpression(
                converted.luaKeys,
                pressCommand,
                isPushToTalk ? "{ transparent = true }" : ""
              )
            : `${isPushToTalk ? "bindt" : "bind"} = ${converted.bindKey}, exec, ${pressCommand}`;
        const persistedReleaseBind = !isPushToTalk
          ? null
          : config.format === "lua"
            ? buildLuaBindExpression(
                converted.luaKeys,
                releaseCommand,
                "{ release = true, transparent = true }"
              )
            : `bindrt = ${converted.bindKey}, exec, ${releaseCommand}`;
        this._writeBindToConfig(config, [persistedPressBind, persistedReleaseBind].filter(Boolean));
        const mainConfigFound = this._ensureSourceInMainConfig(config);
        if (mainConfigFound) this._removeLegacyArtifacts(config);
      } catch (err) {
        debugLogger.log(
          "[HyprlandShortcut] Failed to persist keybinding; runtime bind is still active:",
          err.message
        );
      }

      debugLogger.log(
        `[HyprlandShortcut] Keybinding "${hotkey}" (${runtimeBinding}) registered successfully`
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
  async updateKeybinding(hotkey, isPushToTalk = false) {
    // Just unregister old and register new
    return this.registerKeybinding(hotkey, isPushToTalk);
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
    const config = this._getConfig();

    try {
      this._unbindRuntime(config, binding);
    } catch (err) {
      debugLogger.log(`[HyprlandShortcut] Runtime unbind for "${binding}" failed:`, err.message);
      return false;
    }

    try {
      this._removeBindFromConfig(config);
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
      this.bus.connection.end();
      this.bus = null;
    }
  }
}

module.exports = HyprlandShortcutManager;
