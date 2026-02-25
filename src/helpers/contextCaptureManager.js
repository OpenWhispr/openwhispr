const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const COMMAND_CACHE_TTL_MS = 30000;

const CODE_EXTENSIONS = new Set([
  "swift",
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "m",
  "mm",
  "php",
  "vue",
  "svelte",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "sql",
  "sh",
  "zsh",
  "bash",
  "fish",
  "lua",
  "zig",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "scala",
  "r",
  "jl",
  "dart",
  "tf",
  "proto",
  "graphql",
  "md",
  "mdx",
  "dockerfile",
  "makefile",
  "cmake",
  "gradle",
  "plist",
  "xcconfig",
]);

function hasCodeExtension(segment) {
  const trimmed = segment.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_EXTENSIONS.has(trimmed.slice(dot + 1).toLowerCase());
}

function matchesApp(id, title, idKeywords, titleKeywords) {
  return idKeywords.some((k) => id.includes(k)) || titleKeywords.some((k) => title.includes(k));
}

function parseFileName(windowTitle, appIdentifier) {
  if (!windowTitle) return null;
  const id = (appIdentifier || "").toLowerCase();

  // VS Code / Cursor / Windsurf: "file.ts — project — Visual Studio Code"
  if (
    matchesApp(
      id,
      windowTitle,
      ["vscode", "cursor", "windsurf"],
      ["Visual Studio Code", "Cursor", "Windsurf"]
    ) ||
    /^code(\.exe)?$/i.test(appIdentifier || "")
  ) {
    const parts = windowTitle.split(" \u2014 ");
    if (parts[0] && hasCodeExtension(parts[0])) return parts[0].trim();
    return null;
  }

  // Xcode: "Project — file.swift"
  if (matchesApp(id, windowTitle, ["xcode"], ["Xcode"])) {
    for (const part of windowTitle.split(" \u2014 ")) {
      if (hasCodeExtension(part)) return part.trim();
    }
    return null;
  }

  // JetBrains: "project – file.ts [path]"
  const jetbrainsIds = [
    "jetbrains",
    "intellij",
    "webstorm",
    "pycharm",
    "phpstorm",
    "rubymine",
    "goland",
    "rider",
    "clion",
    "datagrip",
    "appcode",
    "idea",
  ];
  if (matchesApp(id, windowTitle, jetbrainsIds, [])) {
    const parts = windowTitle.split(" \u2013 ");
    if (parts.length >= 2) {
      const segment = parts[1].trim().replace(/\s*\[.*\]$/, "");
      if (hasCodeExtension(segment)) return segment.trim();
    }
    return null;
  }

  // Sublime Text: "file.ts - Project"
  if (matchesApp(id, windowTitle, ["sublime"], ["Sublime Text"])) {
    const parts = windowTitle.split(" - ");
    if (parts[0] && hasCodeExtension(parts[0])) return parts[0].trim();
    return null;
  }

  // Vim / Neovim (runs inside terminals, detected from title)
  if (matchesApp(id, windowTitle, ["nvim", "neovim", "vim"], ["NVIM", "VIM"])) {
    const parts = windowTitle.split(" - ");
    if (parts[0] && hasCodeExtension(parts[0])) return parts[0].trim();
    return null;
  }

  return null;
}

class ContextCaptureManager {
  constructor() {
    this._linuxStrategy = undefined;
    this._commandCache = new Map();
  }

  captureContext() {
    try {
      let raw;
      switch (process.platform) {
        case "darwin":
          raw = this._captureDarwin();
          break;
        case "win32":
          raw = this._captureWin32();
          break;
        case "linux":
          raw = this._captureLinux();
          break;
        default:
          return null;
      }
      if (!raw) return null;

      const fileName = parseFileName(raw.windowTitle, raw.appIdentifier);
      const context = {
        bundleId: raw.appIdentifier || null,
        appName: raw.appName || null,
        windowTitle: raw.windowTitle || null,
        fileName,
      };

      debugLogger.info("[ContextCapture] Context captured", {
        platform: process.platform,
        appName: context.appName,
        fileName: context.fileName,
      });
      return context;
    } catch (err) {
      debugLogger.info("[ContextCapture] Error", { error: err.message });
      return null;
    }
  }

  // --- macOS: spawn compiled Swift binary ---

  _captureDarwin() {
    const binaryPath = this._resolveBinary("macos-context-capture");
    if (!binaryPath) return null;

    const result = spawnSync(binaryPath, [], { timeout: 500 });
    if (result.error || (result.status !== 0 && result.status !== 2)) return null;

    const stdout = result.stdout?.toString().trim();
    if (!stdout) return null;

    const parsed = JSON.parse(stdout);
    return {
      appName: parsed.appName || null,
      windowTitle: parsed.windowTitle || null,
      appIdentifier: parsed.bundleId || null,
    };
  }

  // --- Windows: spawn compiled C binary ---

  _captureWin32() {
    const binaryPath = this._resolveBinary("windows-context-capture.exe");
    if (!binaryPath) return null;

    const result = spawnSync(binaryPath, [], { timeout: 500 });
    if (result.error || result.status !== 0) return null;

    const stdout = result.stdout?.toString().trim();
    if (!stdout) return null;

    const parsed = JSON.parse(stdout);
    const exeName = parsed.appName || "";
    return {
      appName: exeName.replace(/\.exe$/i, "") || null,
      windowTitle: parsed.windowTitle || null,
      appIdentifier: exeName || null,
    };
  }

  // --- Linux: shell commands with auto-detected strategy ---

  _captureLinux() {
    const strategy = this._detectLinuxStrategy();
    if (!strategy) return null;

    switch (strategy) {
      case "hyprctl":
        return this._captureHyprctl();
      case "swaymsg":
        return this._captureSwaymsg();
      case "xdotool":
        return this._captureXdotool();
      case "gdbus":
        return this._captureGdbus();
      default:
        return null;
    }
  }

  _detectLinuxStrategy() {
    if (this._linuxStrategy !== undefined) return this._linuxStrategy;

    if (process.env.HYPRLAND_INSTANCE_SIGNATURE && this._commandExists("hyprctl")) {
      this._linuxStrategy = "hyprctl";
    } else if (process.env.SWAYSOCK && this._commandExists("swaymsg")) {
      this._linuxStrategy = "swaymsg";
    } else if (process.env.DISPLAY && this._commandExists("xdotool")) {
      this._linuxStrategy = "xdotool";
    } else if (
      (process.env.XDG_CURRENT_DESKTOP || "").toLowerCase().includes("gnome") &&
      this._commandExists("gdbus")
    ) {
      this._linuxStrategy = "gdbus";
    } else {
      this._linuxStrategy = null;
    }

    debugLogger.info("[ContextCapture] Linux strategy", { strategy: this._linuxStrategy });
    return this._linuxStrategy;
  }

  _captureHyprctl() {
    const result = spawnSync("hyprctl", ["activewindow", "-j"], { timeout: 500 });
    if (result.status !== 0 || !result.stdout) return null;

    const data = JSON.parse(result.stdout.toString().trim());
    const appClass = data.class || data.initialClass || null;
    return {
      appName: appClass,
      windowTitle: data.title || null,
      appIdentifier: appClass,
    };
  }

  _captureSwaymsg() {
    const result = spawnSync("swaymsg", ["-t", "get_tree"], { timeout: 500 });
    if (result.status !== 0 || !result.stdout) return null;

    const tree = JSON.parse(result.stdout.toString());
    const focused = this._findSwayFocused(tree);
    if (!focused) return null;

    const appId = focused.app_id || focused.window_properties?.class || null;
    return {
      appName: appId,
      windowTitle: focused.name || null,
      appIdentifier: appId,
    };
  }

  _captureXdotool() {
    const idResult = spawnSync("xdotool", ["getactivewindow"], { timeout: 500 });
    if (idResult.status !== 0 || !idResult.stdout) return null;
    const winId = idResult.stdout.toString().trim();

    const nameResult = spawnSync("xdotool", ["getwindowname", winId], { timeout: 500 });
    const windowTitle = nameResult.status === 0 ? nameResult.stdout.toString().trim() : null;

    // Try WM_CLASS via xprop (most reliable for IDE detection)
    let appIdentifier = null;
    if (this._commandExists("xprop")) {
      const xpropResult = spawnSync("xprop", ["-id", winId, "WM_CLASS"], { timeout: 500 });
      if (xpropResult.status === 0) {
        const match = xpropResult.stdout.toString().match(/= "([^"]*)", "([^"]*)"/);
        if (match) appIdentifier = match[2];
      }
    }

    // Fallback: process name from /proc
    if (!appIdentifier) {
      const pidResult = spawnSync("xdotool", ["getwindowpid", winId], { timeout: 500 });
      if (pidResult.status === 0) {
        const pid = pidResult.stdout.toString().trim();
        try {
          appIdentifier = fs.readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
        } catch {
          /* not available */
        }
      }
    }

    return { appName: appIdentifier, windowTitle, appIdentifier };
  }

  _captureGdbus() {
    const result = spawnSync(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.gnome.Shell",
        "--object-path",
        "/org/gnome/Shell",
        "--method",
        "org.gnome.Shell.Eval",
        "global.display.get_focus_window()?.get_title() || ''",
      ],
      { timeout: 500 }
    );
    if (result.status !== 0) return null;

    const output = (result.stdout || "").toString().trim();
    const match = output.match(/^\(true,\s*'(.+)'\)$/);
    if (!match) return null;

    let title = match[1];
    if (title.startsWith('"') && title.endsWith('"')) {
      title = title.slice(1, -1);
    }
    if (!title) return null;

    return { appName: null, windowTitle: title, appIdentifier: null };
  }

  _findSwayFocused(node) {
    if (node.focused && (node.type === "con" || node.type === "floating_con")) {
      return node;
    }
    const children = [...(node.nodes || []), ...(node.floating_nodes || [])];
    for (const child of children) {
      const found = this._findSwayFocused(child);
      if (found) return found;
    }
    return null;
  }

  // --- Utilities ---

  _resolveBinary(binaryName) {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((c) => candidates.add(c));
    }

    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }

    return null;
  }

  _commandExists(cmd) {
    const now = Date.now();
    const cached = this._commandCache.get(cmd);
    if (cached && now < cached.expiresAt) return cached.exists;

    try {
      const res = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      const exists = res.status === 0;
      this._commandCache.set(cmd, { exists, expiresAt: now + COMMAND_CACHE_TTL_MS });
      return exists;
    } catch {
      this._commandCache.set(cmd, { exists: false, expiresAt: now + COMMAND_CACHE_TTL_MS });
      return false;
    }
  }
}

module.exports = ContextCaptureManager;
