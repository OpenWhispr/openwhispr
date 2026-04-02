const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const ARCH_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHUNK_MS = 100;
const START_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 5000;

function compareVersions(left, right) {
  const leftParts = String(left)
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
  const rightParts = String(right)
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

class AudioTapManager {
  constructor() {
    this.process = null;
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.isStopping = false;
    this.permissionStatus = "unknown";
    this._requestPromise = null;
  }

  isSupported() {
    return (
      process.platform === "darwin" && compareVersions(process.getSystemVersion(), "14.2") >= 0
    );
  }

  isAvailable() {
    if (!this.isSupported()) {
      return false;
    }
    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      return false;
    }
    return !this._checkArchMismatch(binaryPath);
  }

  getPermissionStatus() {
    if (this.process) {
      return "granted";
    }
    return this.permissionStatus;
  }

  async requestAccess() {
    if (!this.isSupported()) {
      return { granted: false, status: "unsupported" };
    }
    if (this.process) {
      this.permissionStatus = "granted";
      return { granted: true, status: "granted" };
    }
    if (this._requestPromise) {
      return this._requestPromise;
    }

    this._requestPromise = this._probeForAccess()
      .catch((error) => {
        const status = error.code === "permission_denied" ? "denied" : "unknown";
        this.permissionStatus = status;
        return { granted: false, status, error: error.message };
      })
      .finally(() => {
        this._requestPromise = null;
      });

    return this._requestPromise;
  }

  async start({ onChunk, onError } = {}) {
    if (!this.isSupported()) {
      throw new Error("macOS 14.2 or later is required for native system audio capture.");
    }
    if (this.process) {
      this.onChunk = onChunk || null;
      this.onError = onError || null;
      this.permissionStatus = "granted";
      return;
    }
    if (this._requestPromise) {
      await this._requestPromise.catch(() => {});
    }

    const binaryPath = this._prepareBinary();
    this.onChunk = onChunk || null;
    this.onError = onError || null;
    this.isStopping = false;
    this.stderrBuffer = "";

    const child = spawn(
      binaryPath,
      ["--sample-rate", String(DEFAULT_SAMPLE_RATE), "--chunk-ms", String(DEFAULT_CHUNK_MS)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.process = child;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error("Timed out starting macOS audio tap. Check System Audio permissions."),
          true
        );
      }, START_TIMEOUT_MS);

      const finish = (callback, value, shouldStop = false) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (shouldStop) {
          void this.stop();
        }
        callback(value);
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this.onChunk?.(chunk);
      });

      child.stderr.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStderr(chunk, (message) => {
          if (message.type === "start") {
            this.permissionStatus = "granted";
            finish(resolve);
            return;
          }

          if (message.type === "error") {
            const error = this._buildProcessError(message);
            if (error.code === "permission_denied") {
              this.permissionStatus = "denied";
            }
            if (!settled) {
              finish(reject, error, true);
            } else {
              this.onError?.(error);
            }
          }
        });
      });

      child.on("error", (error) => {
        if (this.process === child) {
          this.process = null;
        }
        finish(reject, error);
      });

      child.on("exit", (code, signal) => {
        const wasStopping = this.isStopping;
        if (this.process === child) {
          this.process = null;
        }

        if (!settled) {
          finish(
            reject,
            new Error(
              `macOS audio tap exited before start (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
          return;
        }

        if (!wasStopping) {
          this.onError?.(
            new Error(
              `macOS audio tap exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
        }
      });
    });
  }

  async stop() {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.isStopping = true;

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          resolve();
        }
      }, STOP_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    if (this.process === child) {
      this.process = null;
    }
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.isStopping = false;
  }

  async _probeForAccess() {
    const binaryPath = this._prepareBinary();
    const child = spawn(
      binaryPath,
      ["--sample-rate", String(DEFAULT_SAMPLE_RATE), "--chunk-ms", String(DEFAULT_CHUNK_MS)],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    let stderrBuffer = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(resolve, { granted: false, status: "unknown" }, true);
      }, REQUEST_TIMEOUT_MS);

      const finish = (callback, value, shouldStop = false) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (shouldStop) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
        callback(value);
      };

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
        let newlineIndex = stderrBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stderrBuffer.slice(0, newlineIndex).trim();
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
          if (line) {
            try {
              const message = JSON.parse(line);
              if (message.type === "start") {
                this.permissionStatus = "granted";
                finish(resolve, { granted: true, status: "granted" }, true);
                return;
              }
              if (message.type === "error") {
                const error = this._buildProcessError(message);
                if (error.code === "permission_denied") {
                  this.permissionStatus = "denied";
                }
                finish(reject, error, true);
                return;
              }
            } catch {
              debugLogger.warn("[AudioTapManager] Non-JSON stderr output", { line }, "meeting");
            }
          }
          newlineIndex = stderrBuffer.indexOf("\n");
        }
      });

      child.on("error", (error) => {
        finish(reject, error);
      });

      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }
        finish(resolve, {
          granted: false,
          status: this.permissionStatus === "denied" ? "denied" : "unknown",
          error:
            code && code !== 0
              ? `macOS audio tap exited (code ${code}, signal ${signal ?? "null"})`
              : undefined,
        });
      });
    });
  }

  _prepareBinary() {
    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      throw new Error(
        "macOS audio tap binary not found. Run `npm run compile:audio-tap` before packaging."
      );
    }

    const archMismatch = this._checkArchMismatch(binaryPath);
    if (archMismatch) {
      throw new Error(archMismatch);
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      fs.chmodSync(binaryPath, 0o755);
    }

    return binaryPath;
  }

  resolveBinary() {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", "macos-audio-tap"),
      path.join(__dirname, "..", "..", "resources", "macos-audio-tap"),
    ]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "macos-audio-tap"));
      candidates.add(path.join(process.resourcesPath, "bin", "macos-audio-tap"));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", "macos-audio-tap"));
      candidates.add(
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", "macos-audio-tap")
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  _consumeStderr(chunk, onMessage) {
    this.stderrBuffer += chunk.toString();
    let newlineIndex = this.stderrBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          debugLogger.warn("[AudioTapManager] Non-JSON stderr output", { line }, "meeting");
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  _buildProcessError(message) {
    const error = new Error(message.message || "macOS audio tap failed");
    error.code = message.code;
    error.status = message.status;
    error.operation = message.operation;
    return error;
  }

  _checkArchMismatch(binaryPath) {
    try {
      const fd = fs.openSync(binaryPath, "r");
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      if (header.readUInt32LE(0) !== 0xfeedfacf) {
        return "macOS audio tap binary is not a valid 64-bit Mach-O file.";
      }

      const cpuType = header.readInt32LE(4);
      const expectedCpu = ARCH_CPU_TYPE[process.arch];
      if (expectedCpu && cpuType !== expectedCpu) {
        return (
          `macOS audio tap binary architecture mismatch: binary does not match ${process.arch}. ` +
          `Try reinstalling or run \`TARGET_ARCH=${process.arch} npm run compile:audio-tap\`.`
        );
      }

      return null;
    } catch (error) {
      debugLogger.warn(
        "[AudioTapManager] Could not verify binary architecture",
        { error: error.message },
        "meeting"
      );
      return null;
    }
  }
}

module.exports = AudioTapManager;
