const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const normalizeLevel = (value) => {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, lower) ? lower : null;
};

const readArgLogLevel = () => {
  const argv = process.argv || [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log-level" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg.startsWith("--log-level=")) {
      return arg.split("=", 2)[1];
    }
  }
  return null;
};

class DebugLogger {
  constructor() {
    this.logLevel = this.resolveLogLevel();
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();
    this.logFile = null;
    this.logStream = null;
    this.fileLoggingEnabled = false;
    this.fileLoggingPending = this.debugMode; // Track if we need to initialize file logging later

    // IMPORTANT: Do NOT call initializeFileLogging() here!
    // It uses app.getPath() which is unsafe before app.whenReady().
    // File logging will be initialized on first log write or via ensureFileLogging().
  }

  initializeFileLogging() {
    if (this.fileLoggingEnabled) return;

    // Check if app is ready before accessing app.getPath()
    // This is critical because app.getPath() can hang or fail before app.whenReady()
    if (!app.isReady()) {
      // App not ready yet, will try again later via ensureFileLogging() or write()
      return;
    }

    try {
      const logsDir = path.join(app.getPath("userData"), "logs");
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.logFile = path.join(logsDir, `debug-${timestamp}.log`);

      this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
      this.fileLoggingEnabled = true;
      this.fileLoggingPending = false;

      this.debug("Debug logging enabled", { logFile: this.logFile });
      this.info("System Info", {
        platform: process.platform,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
        resourcesPath: process.resourcesPath,
        environment: process.env.NODE_ENV,
      });
    } catch (error) {
      this.fileLoggingEnabled = false;
      this.fileLoggingPending = false;
      console.error("Failed to initialize debug logging:", error);
    }
  }

  /**
   * Ensures file logging is initialized if debug mode is enabled.
   * This should be called after app.whenReady() to safely initialize file logging.
   */
  ensureFileLogging() {
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }
  }

  resolveLogLevel() {
    const argLevel = normalizeLevel(readArgLogLevel());
    if (argLevel) {
      return argLevel;
    }

    const envLevel = normalizeLevel(process.env.OPENWHISPR_LOG_LEVEL || process.env.LOG_LEVEL);
    if (envLevel) {
      return envLevel;
    }

    return "info";
  }

  refreshLogLevel() {
    const nextLevel = this.resolveLogLevel();
    if (nextLevel === this.logLevel) return;

    this.logLevel = nextLevel;
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();

    if (this.debugMode && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }
  }

  getLevel() {
    return this.logLevel;
  }

  isDebugEnabled() {
    return this.levelValue <= LOG_LEVELS.debug;
  }

  shouldLog(level) {
    const normalized = normalizeLevel(level) || "info";
    return LOG_LEVELS[normalized] >= this.levelValue;
  }

  serializeValue(value) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.code ? { code: value.code } : {}),
        ...(value.stack ? { stack: value.stack } : {}),
        ...value,
      };
    }
    return value;
  }

  formatArgs(args) {
    return args
      .map((arg) => {
        if (arg !== null && typeof arg === "object") {
          try {
            return JSON.stringify(this.serializeValue(arg), null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");
  }

  formatMeta(meta) {
    if (meta === undefined) return "";
    if (typeof meta === "string") return meta;
    try {
      return JSON.stringify(this.serializeValue(meta), null, 2);
    } catch {
      return String(meta);
    }
  }

  write(level, message, meta, scope, source) {
    const normalized = normalizeLevel(level) || "info";
    if (!this.shouldLog(normalized)) return;

    // Try to initialize file logging if pending and app is ready
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }

    const timestamp = new Date().toISOString();
    const scopeTag = scope ? `[${scope}]` : "";
    const sourceTag = source ? `[${source}]` : "";
    const levelTag = `[${normalized.toUpperCase()}]`;
    const baseLine = `[${timestamp}] ${levelTag}${scopeTag}${sourceTag} ${message}`;
    const metaText = this.formatMeta(meta);
    const logLine = metaText ? `${baseLine} ${metaText}\n` : `${baseLine}\n`;

    const consoleFn =
      normalized === "error" || normalized === "fatal"
        ? console.error
        : normalized === "warn"
          ? console.warn
          : console.log;

    if (meta !== undefined) {
      consoleFn(`${levelTag}${scopeTag}${sourceTag} ${message}`, meta);
    } else {
      consoleFn(`${levelTag}${scopeTag}${sourceTag} ${message}`);
    }

    if (this.logStream) {
      this.logStream.write(logLine);
    }
  }

  log(...args) {
    this.write("debug", this.formatArgs(args));
  }

  debug(message, meta, scope, source) {
    this.write("debug", message, meta, scope, source);
  }

  trace(message, meta, scope, source) {
    this.write("trace", message, meta, scope, source);
  }

  info(message, meta, scope, source) {
    this.write("info", message, meta, scope, source);
  }

  warn(message, meta, scope, source) {
    this.write("warn", message, meta, scope, source);
  }

  logReasoning(stage, details) {
    this.debug(stage, details, "reasoning");
  }

  error(...args) {
    const message = `ERROR: ${this.formatArgs(args)}`;
    this.write("error", message);
  }

  fatal(...args) {
    const message = `FATAL: ${this.formatArgs(args)}`;
    this.write("fatal", message);
  }

  logEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    const normalized = normalizeLevel(entry.level) || "info";
    const message = entry.message ? String(entry.message) : "";
    const scope = entry.scope ? String(entry.scope) : undefined;
    const source = entry.source ? String(entry.source) : "renderer";
    this.write(normalized, message, entry.meta, scope, source);
  }

  logFFmpegDebug(context, ffmpegPath, additionalInfo = {}) {
    if (!this.isDebugEnabled()) return;

    const debugInfo = {
      context,
      ffmpegPath,
      exists: ffmpegPath ? fs.existsSync(ffmpegPath) : false,
      platform: process.platform,
      ...additionalInfo,
    };

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      try {
        const stats = fs.statSync(ffmpegPath);
        debugInfo.fileInfo = {
          size: stats.size,
          isFile: stats.isFile(),
          // Skip X_OK check on Windows (not reliable)
          isExecutable: process.platform !== "win32" ? !!(stats.mode & fs.constants.X_OK) : false,
          executableCheckSkipped: process.platform === "win32",
          permissions: stats.mode.toString(8),
          modified: stats.mtime,
        };
      } catch (e) {
        debugInfo.statError = e.message;
      }
    }

    // Check parent directory permissions
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      try {
        fs.accessSync(dir, fs.constants.R_OK);
        debugInfo.dirReadable = true;
      } catch (e) {
        debugInfo.dirReadable = false;
        debugInfo.dirError = e.message;
      }
    }

    // Platform-specific path checks
    let possiblePaths = [];
    if (process.platform === "win32") {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg.exe"
        ),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean);
    } else {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace("app.asar", "app.asar.unpacked"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg"
        ),
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
      ].filter(Boolean);
    }

    debugInfo.pathChecks = possiblePaths.map((p) => ({
      path: p,
      exists: fs.existsSync(p),
      normalized: path.normalize(p),
    }));

    this.debug(`FFmpeg Debug - ${context}`, debugInfo, "ffmpeg");
  }

  logAudioData(context, audioBlob) {
    if (!this.isDebugEnabled()) return;

    const audioInfo = {
      context,
      type: audioBlob?.type || "unknown",
      size: audioBlob?.size || 0,
      constructor: audioBlob?.constructor?.name || "unknown",
    };

    if (audioBlob instanceof ArrayBuffer) {
      audioInfo.byteLength = audioBlob.byteLength;
      // Check first few bytes
      const view = new Uint8Array(audioBlob, 0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else if (audioBlob instanceof Uint8Array) {
      audioInfo.byteLength = audioBlob.byteLength;
      const view = audioBlob.slice(0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    }

    this.debug("Audio Data Debug", audioInfo, "audio");
  }

  logProcessStart(command, args, options = {}) {
    if (!this.isDebugEnabled()) return;

    this.debug(
      "Starting process",
      {
        command,
        args,
        cwd: options.cwd || process.cwd(),
        env: {
          FFMPEG_PATH: options.env?.FFMPEG_PATH,
          FFMPEG_EXECUTABLE: options.env?.FFMPEG_EXECUTABLE,
          FFMPEG_BINARY: options.env?.FFMPEG_BINARY,
          PATH_preview: options.env?.PATH?.substring(0, 200) + "...",
        },
      },
      "process"
    );
  }

  logProcessOutput(processName, type, data) {
    if (!this.isDebugEnabled()) return;

    const output = data.toString().trim();
    if (output) {
      this.debug(`${processName} ${type}`, output, "process");
    }
  }

  logWhisperPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`Whisper Pipeline - ${stage}`, details, "whisper");
  }

  logSTTPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`STT Pipeline - ${stage}`, details, "stt");
  }

  getLogPath() {
    return this.logFile;
  }

  isEnabled() {
    return this.isDebugEnabled();
  }

  close() {
    if (this.logStream) {
      this.log("📝 Debug logger closing");
      this.logStream.end();
      this.logStream = null;
    }
  }
}

// Singleton instance
const debugLogger = new DebugLogger();

module.exports = debugLogger;
