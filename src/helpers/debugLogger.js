const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  // Not a problem, but expensive or irreversible enough that we want it on the
  // record without asking the user to turn on debug logging: a model server
  // starting, a multi-minute inference, a migration.
  notice: 35,
  warn: 40,
  error: 50,
  fatal: 60,
};

// warn and above always reach disk, whatever the log level — a failure nobody can
// see is a failure nobody can fix. Rotation and throttling are what make that
// affordable: some call sites warn per audio chunk.
const PERSIST_FROM = LOG_LEVELS.notice;
const RETENTION_DAYS = 30;
const MAX_LOG_FILES = 60;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const THROTTLE_WINDOW_MS = 10000;
const THROTTLE_LIMIT = 5;
const THROTTLE_KEYS_MAX = 500;

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
  constructor(options = {}) {
    this.logLevel = normalizeLevel(options.level) || this.resolveLogLevel();
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();
    this.logFile = null;
    this.logStream = null;
    this.fileLoggingEnabled = false;
    this.maxFiles = options.maxFiles || MAX_LOG_FILES;
    this.retentionDays = options.retentionDays || RETENTION_DAYS;
    this.maxBytes = options.maxBytes || MAX_LOG_BYTES;
    this.bytesWritten = 0;
    this._throttle = new Map();

    // IMPORTANT: Do NOT call initializeFileLogging() here!
    // It uses app.getPath() which is unsafe before app.whenReady().
    // File logging is initialized on the first write that needs to persist.
  }

  // Outside Electron `app` is undefined, and before whenReady() getPath() can hang.
  _resolveLogsDir() {
    if (!app?.isReady?.()) return null;
    return path.join(app.getPath("userData"), "logs");
  }

  _pruneOldLogs(logsDir, keep) {
    try {
      const entries = fs
        .readdirSync(logsDir)
        .filter((name) => /^debug-.*\.log$/.test(name))
        .map((name) => {
          const full = path.join(logsDir, name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(full).mtimeMs;
          } catch {
            // Raced with another prune; treat it as oldest.
          }
          return { full, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Age is the primary bound — a month of history is what makes a failure
      // reported days later still diagnosable. The count is only a backstop so a
      // restart loop cannot fill the disk.
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const doomed = entries.filter((entry, index) => index >= Math.max(keep, 0) || entry.mtimeMs < cutoff);

      for (const entry of doomed) {
        try {
          fs.rmSync(entry.full, { force: true });
        } catch {
          // A log we cannot delete is not worth failing a log write over.
        }
      }
    } catch {
      // Missing or unreadable directory — nothing to prune.
    }
  }

  initializeFileLogging() {
    if (this.fileLoggingEnabled) return;

    const logsDir = this._resolveLogsDir();
    if (!logsDir) return;

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      this._pruneOldLogs(logsDir, this.maxFiles - 1);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      let candidate = path.join(logsDir, `debug-${timestamp}.log`);
      for (let seq = 1; fs.existsSync(candidate); seq += 1) {
        candidate = path.join(logsDir, `debug-${timestamp}-${seq}.log`);
      }
      this.logFile = candidate;

      this.logStream = fs.createWriteStream(this.logFile, { flags: "a" });
      this.fileLoggingEnabled = true;
      this.bytesWritten = 0;

      this._writeToStream(
        `${this.formatLine("info", "Log file opened", {
          platform: process.platform,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appPath: app?.getAppPath?.() ?? null,
          resourcesPath: process.resourcesPath,
          environment: process.env.NODE_ENV,
          logLevel: this.logLevel,
        })}\n`
      );
    } catch (error) {
      this.fileLoggingEnabled = false;
      this.logStream = null;
      console.error("Failed to initialize debug logging:", error);
    }
  }

  /**
   * Opens the log file eagerly once the app is ready, so the file exists before
   * the first warning rather than after it.
   */
  ensureFileLogging() {
    this.initializeFileLogging();
  }

  _rotate() {
    const stream = this.logStream;
    this.logStream = null;
    this.fileLoggingEnabled = false;
    this.bytesWritten = 0;
    try {
      stream?.end();
    } catch {
      // Already closed.
    }
    this.initializeFileLogging();
  }

  _writeToStream(line) {
    if (!this.logStream) return;
    this.logStream.write(line);
    this.bytesWritten += Buffer.byteLength(line);
    if (this.bytesWritten >= this.maxBytes) {
      this._rotate();
    }
  }

  _shouldPersist(level) {
    return this.debugMode || LOG_LEVELS[level] >= PERSIST_FROM;
  }

  // Some call sites warn per audio chunk. Persist the first few of any repeated
  // message per window, then a single count of what was dropped.
  _passesThrottle(level, message) {
    const key = `${level}:${message}`;
    const now = Date.now();
    const entry = this._throttle.get(key);

    if (!entry || now - entry.windowStart >= THROTTLE_WINDOW_MS) {
      if (entry?.suppressed > 0) {
        this._writeToStream(
          `${this.formatLine("warn", `suppressed ${entry.suppressed} repeats of: ${message}`)}\n`
        );
      }
      if (this._throttle.size >= THROTTLE_KEYS_MAX) this._throttle.clear();
      this._throttle.set(key, { windowStart: now, count: 1, suppressed: 0 });
      return true;
    }

    entry.count += 1;
    if (entry.count > THROTTLE_LIMIT) {
      entry.suppressed += 1;
      return false;
    }
    return true;
  }

  formatLine(level, message, meta, scope, source) {
    const scopeTag = scope ? `[${scope}]` : "";
    const sourceTag = source ? `[${source}]` : "";
    const metaText = this.formatMeta(meta);
    const base = `[${new Date().toISOString()}] [${level.toUpperCase()}]${scopeTag}${sourceTag} ${message}`;
    return metaText ? `${base} ${metaText}` : base;
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

    if (!this.fileLoggingEnabled) {
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

    const persist = this._shouldPersist(normalized);
    if (persist && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }

    const scopeTag = scope ? `[${scope}]` : "";
    const sourceTag = source ? `[${source}]` : "";
    const levelTag = `[${normalized.toUpperCase()}]`;

    const consoleFn =
      normalized === "error" || normalized === "fatal"
        ? console.error
        : normalized === "warn"
          ? console.warn
          : console.log;

    if (meta !== undefined) {
      // Pass the prefix as a %s arg, not as a format string. See CodeQL js/tainted-format-string.
      consoleFn("%s", `${levelTag}${scopeTag}${sourceTag} ${message}`, meta);
    } else {
      consoleFn(`${levelTag}${scopeTag}${sourceTag} ${message}`);
    }

    if (persist && this.logStream && this._passesThrottle(normalized, message)) {
      this._writeToStream(`${this.formatLine(normalized, message, meta, scope, source)}\n`);
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

  // Always reaches the log file. Keep variable data in `meta` — the message is
  // the throttle key, so "pass 3 of 14" in the message defeats throttling.
  notice(message, meta, scope, source) {
    this.write("notice", message, meta, scope, source);
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

  _flushThrottleSummaries() {
    for (const [key, entry] of this._throttle) {
      if (entry.suppressed > 0) {
        const message = key.slice(key.indexOf(":") + 1);
        this._writeToStream(
          `${this.formatLine("warn", `suppressed ${entry.suppressed} repeats of: ${message}`)}\n`
        );
        entry.suppressed = 0;
      }
    }
  }

  // Resolves once the stream has flushed, so callers can read the file back.
  close() {
    if (this.logStream) {
      this._flushThrottleSummaries();
    }
    if (this.logStream) {
      this._writeToStream(`${this.formatLine("info", "Log file closing")}\n`);
    }
    const stream = this.logStream;
    this.logStream = null;
    this.fileLoggingEnabled = false;
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.end(resolve));
  }
}

// Singleton instance
const debugLogger = new DebugLogger();

module.exports = debugLogger;
module.exports.DebugLogger = DebugLogger;
