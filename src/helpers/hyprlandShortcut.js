const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const debugLogger = require("./debugLogger");

const DBUS_SERVICE_NAME = "com.openwhispr.App";
const DBUS_OBJECT_PATH = "/com/openwhispr/App";
const DBUS_INTERFACE = "com.openwhispr.App";
const DBUS_NAME_REQUEST_TIMEOUT_MS = 5000;

const SLOT_TOGGLE_METHOD = {
  dictation: "Toggle",
  meeting: "ToggleMeeting",
  voiceAgent: "ToggleVoiceAgent",
  translation: "ToggleTranslation",
};

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

function isManagedBindLine(line, format) {
  const hasManagedCall = line.includes(
    `--dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.`
  );
  if (!hasManagedCall) return false;
  return format === "lua" ? /^hl\.bind\s*\(/.test(line) : /^bind(?:t|rt)?\s*=/.test(line);
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
  constructor({ dbusNameRequestTimeoutMs = DBUS_NAME_REQUEST_TIMEOUT_MS } = {}) {
    this.bus = null;
    this.callbacks = {};
    this.isRegistered = false;
    this.bindings = {};
    this.bindingPtt = {};
    this.desiredBinds = {};
    this.persistencePending = false;
    this.config = null;
    this.dbusNameRequestTimeoutMs = dbusNameRequestTimeoutMs;
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
    this.callbacks.dictation = callback;

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
        debugLogger.log("[HyprlandShortcut] D-Bus connection error:", err.message);
        rejectNameRequest?.(err);
      });
      const nameReply = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          rejectNameRequest = null;
          handler(value);
        };
        rejectNameRequest = (err) => finish(reject, err);
        const timeoutId = setTimeout(
          () => rejectNameRequest?.(new Error("D-Bus name request timed out")),
          this.dbusNameRequestTimeoutMs
        );
        this.bus.requestName(DBUS_SERVICE_NAME, 0, (err, reply) => {
          if (err) finish(reject, err);
          else finish(resolve, reply);
        });
      });
      if (nameReply !== 1 && nameReply !== 4) {
        throw new Error(`D-Bus name request returned ${nameReply}`);
      }

      const toggleMethods = {};
      for (const [slot, method] of Object.entries(SLOT_TOGGLE_METHOD)) {
        toggleMethods[method] = () => {
          const cb = this.callbacks[slot];
          if (typeof cb === "function") cb();
        };
      }
      toggleMethods.PttDown = () => {
        const cb = this.callbacks.dictation;
        if (typeof cb === "function") cb(undefined, "down");
      };
      toggleMethods.PttUp = () => {
        const cb = this.callbacks.dictation;
        if (typeof cb === "function") cb(undefined, "up");
      };
      this.bus.exportInterface(toggleMethods, DBUS_OBJECT_PATH, {
        name: DBUS_INTERFACE,
        methods: Object.fromEntries(
          [...Object.values(SLOT_TOGGLE_METHOD), "PttDown", "PttUp"].map((method) => [
            method,
            ["", ""],
          ])
        ),
      });

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

  static getCanonicalBinding(hotkey) {
    if (isModifierOnlyHotkey(hotkey)) {
      const modifiers = hotkey
        .split("+")
        .map((part) => ELECTRON_TO_HYPRLAND_MOD[part.trim().toLowerCase()])
        .filter(Boolean);
      return `modifier-only:${[...new Set(modifiers)].sort().join("+")}`;
    }

    const converted = HyprlandShortcutManager.convertToHyprlandFormat(hotkey);
    if (!converted) return null;

    const modifiers = converted.mods.split(/\s+/).filter(Boolean).sort().join(" ");
    return `${modifiers}, ${converted.key.toLowerCase()}`;
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

  _rewriteConfig(config, desiredBinds = this.desiredBinds) {
    fs.mkdirSync(path.dirname(config.bindsPath), { recursive: true });

    let content = "";
    try {
      content = fs.readFileSync(config.bindsPath, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    const userLines = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (isManagedHeaderLine(trimmed)) return false;
      if (trimmed.startsWith("#") || trimmed.startsWith("--")) return true;
      return !isManagedBindLine(trimmed, config.format);
    });

    const bindLines = [];
    for (const slotName of Object.keys(desiredBinds)) {
      const b = desiredBinds[slotName];
      if (b.press) bindLines.push(b.press);
      if (b.release) bindLines.push(b.release);
    }

    const newContent = buildManagedBindsContent([...userLines, ...bindLines], config.format);
    fs.writeFileSync(config.bindsPath, newContent, "utf-8");
  }

  _persistBinds(config, desiredBinds) {
    fs.accessSync(config.path, fs.constants.F_OK);
    this._rewriteConfig(config, desiredBinds);
    if (!this._ensureSourceInMainConfig(config)) {
      throw new Error(`Hyprland config not found: ${config.path}`);
    }
    this._removeLegacyArtifacts(config);
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
    let removeLegacySource = false;

    try {
      const content = fs.readFileSync(legacyBindsPath, "utf-8");
      const lines = content.split("\n");
      const hasManagedArtifacts = lines.some((line) => {
        const trimmed = line.trim();
        return isManagedHeaderLine(trimmed) || isManagedBindLine(trimmed, "conf");
      });
      if (!hasManagedArtifacts) return;

      const remainingLines = lines.filter((line) => {
        const trimmed = line.trim();
        return !isManagedHeaderLine(trimmed) && !isManagedBindLine(trimmed, "conf");
      });
      if (remainingLines.join("\n").trim()) {
        fs.writeFileSync(legacyBindsPath, remainingLines.join("\n"), "utf-8");
      } else {
        fs.unlinkSync(legacyBindsPath);
        removeLegacySource = true;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return;
    }

    if (!removeLegacySource) return;
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
    const config = getHyprlandConfig();
    const mainConfig = config.path;
    const configDir = path.dirname(mainConfig);
    const status = {
      path: mainConfig,
      canWrite: false,
    };

    try {
      fs.accessSync(mainConfig, fs.constants.F_OK | fs.constants.W_OK);
      if (!fs.statSync(mainConfig).isFile()) {
        throw new Error(`Hyprland config is not a file: ${mainConfig}`);
      }
      fs.accessSync(configDir, fs.constants.W_OK);
      if (fs.existsSync(config.bindsPath)) {
        fs.accessSync(config.bindsPath, fs.constants.W_OK);
        if (!fs.statSync(config.bindsPath).isFile()) {
          throw new Error(`Managed binds path is not a file: ${config.bindsPath}`);
        }
      }
      status.canWrite = true;
    } catch (err) {
      debugLogger.log(
        "[HyprlandShortcut] Hyprland config or managed binds path is not writable:",
        err.message
      );
    }

    return status;
  }

  async _registerForSlot(hotkey, slotName, callback, isPtt) {
    if (!HyprlandShortcutManager.isHyprland()) {
      debugLogger.log("[HyprlandShortcut] Not running on Hyprland, skipping registration");
      return false;
    }
    if (!HyprlandShortcutManager.isValidHotkey(hotkey)) {
      debugLogger.log(`[HyprlandShortcut] Invalid hotkey format: "${hotkey}"`);
      return false;
    }

    const method = SLOT_TOGGLE_METHOD[slotName];
    if (!method) {
      debugLogger.log(`[HyprlandShortcut] Unknown slot "${slotName}"`);
      return false;
    }

    if (isPtt && isModifierOnlyHotkey(hotkey)) {
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

    let config;
    try {
      config = this._getConfig();
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to read Hyprland config:", err.message);
      return false;
    }
    const runtimeBinding = config.format === "lua" ? converted.luaKeys : converted.bindKey;
    const previousBinding = this.bindings[slotName];
    const previousIsPtt = this.bindingPtt[slotName] ?? false;
    if (previousBinding === runtimeBinding && previousIsPtt === isPtt) {
      if (typeof callback === "function") this.callbacks[slotName] = callback;
      if (this.persistencePending) {
        try {
          this._persistBinds(config, this.desiredBinds);
          this.persistencePending = false;
        } catch (err) {
          debugLogger.log(
            `[HyprlandShortcut] Keybinding "${hotkey}" is active but still cannot persist:`,
            err.message
          );
        }
      }
      return true;
    }

    const pressCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${isPtt ? "PttDown" : method}`;
    const releaseCommand = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.PttUp`;
    const persistedPressBind =
      config.format === "lua"
        ? buildLuaBindExpression(
            converted.luaKeys,
            pressCommand,
            isPtt ? "{ transparent = true }" : ""
          )
        : `${isPtt ? "bindt" : "bind"} = ${converted.bindKey}, exec, ${pressCommand}`;
    const persistedReleaseBind = !isPtt
      ? null
      : config.format === "lua"
        ? buildLuaBindExpression(
            converted.luaKeys,
            releaseCommand,
            "{ release = true, transparent = true }"
          )
        : `bindrt = ${converted.bindKey}, exec, ${releaseCommand}`;
    const nextDesiredBinds = {
      ...this.desiredBinds,
      [slotName]: { press: persistedPressBind, release: persistedReleaseBind },
    };
    try {
      try {
        this._unbindRuntime(config, runtimeBinding);
      } catch (err) {
        debugLogger.log(
          `[HyprlandShortcut] Pre-bind unbind for "${runtimeBinding}" failed:`,
          err.message
        );
      }
      this._bindRuntime(config, converted, isPtt, pressCommand, releaseCommand);
    } catch (err) {
      if (previousBinding === runtimeBinding) {
        try {
          const previousPress = `dbus-send --session --type=method_call --dest=${DBUS_SERVICE_NAME} ${DBUS_OBJECT_PATH} ${DBUS_INTERFACE}.${previousIsPtt ? "PttDown" : method}`;
          this._bindRuntime(config, converted, previousIsPtt, previousPress, releaseCommand);
        } catch {}
      }
      debugLogger.log("[HyprlandShortcut] Failed to register keybinding:", err.message);
      return false;
    }

    if (previousBinding && previousBinding !== runtimeBinding) {
      try {
        this._unbindRuntime(config, previousBinding);
      } catch (err) {
        try {
          this._unbindRuntime(config, runtimeBinding);
        } catch {}
        debugLogger.log("[HyprlandShortcut] Failed to replace keybinding:", err.message);
        return false;
      }
    }

    this.bindings[slotName] = runtimeBinding;
    this.bindingPtt[slotName] = isPtt;
    this.isRegistered = true;
    if (typeof callback === "function") this.callbacks[slotName] = callback;
    this.desiredBinds = nextDesiredBinds;
    this.persistencePending = true;
    try {
      this._persistBinds(config, nextDesiredBinds);
      this.persistencePending = false;
    } catch (err) {
      debugLogger.log(
        `[HyprlandShortcut] Keybinding "${hotkey}" is active for this session but will not persist:`,
        err.message
      );
    }
    debugLogger.log(
      `[HyprlandShortcut] Keybinding "${hotkey}" (${runtimeBinding}) registered for slot "${slotName}"`
    );
    return true;
  }

  registerKeybinding(hotkey, isPushToTalk = false) {
    return this._registerForSlot(hotkey, "dictation", null, isPushToTalk);
  }

  registerSlotKeybinding(hotkey, slotName, callback) {
    return this._registerForSlot(hotkey, slotName, callback, false);
  }

  updateKeybinding(hotkey, isPushToTalk = false) {
    return this.registerKeybinding(hotkey, isPushToTalk);
  }

  // Unregister one slot, or all slots on teardown.
  async unregisterKeybinding(slotName) {
    if (!slotName) {
      const removals = Object.keys(this.bindings).map((slot) => this.unregisterKeybinding(slot));
      const success = (await Promise.all(removals)).every(Boolean);
      if (success) this.isRegistered = false;
      return success;
    }

    let config;
    try {
      config = this._getConfig();
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to read Hyprland config:", err.message);
      return false;
    }

    const binding = this.bindings[slotName];
    try {
      if (binding) this._unbindRuntime(config, binding);
    } catch (err) {
      debugLogger.log("[HyprlandShortcut] Failed to unregister keybinding:", err.message);
      return false;
    }

    const nextDesiredBinds = { ...this.desiredBinds };
    delete nextDesiredBinds[slotName];
    this.desiredBinds = nextDesiredBinds;
    this.persistencePending = true;
    try {
      this._persistBinds(config, nextDesiredBinds);
      this.persistencePending = false;
    } catch (err) {
      debugLogger.log(
        `[HyprlandShortcut] Runtime binding "${slotName}" removed but config was unchanged:`,
        err.message
      );
    }

    delete this.bindings[slotName];
    delete this.bindingPtt[slotName];
    if (slotName !== "dictation") delete this.callbacks[slotName];
    if (Object.keys(this.bindings).length === 0) this.isRegistered = false;
    debugLogger.log(`[HyprlandShortcut] Keybinding "${slotName}" unregistered successfully`);
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
