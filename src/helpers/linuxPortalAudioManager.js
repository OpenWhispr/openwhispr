const { app } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const REQUEST_TIMEOUT_MS = 90000;
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;
const TOKEN_FILE_NAME = ".linux-system-audio-restore-token.json";

class LinuxPortalAudioManager {
  constructor() {
    this.process = null;
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
    this.cachedCapability = null;
    this.capabilityPromise = null;
  }

  isSupported() {
    return process.platform === "linux";
  }

  isAvailable() {
    return !!this.resolveBinary();
  }

  resolveBinary() {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", "linux-system-audio-helper"),
      path.join(__dirname, "..", "..", "resources", "linux-system-audio-helper"),
    ]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "linux-system-audio-helper"));
      candidates.add(path.join(process.resourcesPath, "bin", "linux-system-audio-helper"));
      candidates.add(
        path.join(process.resourcesPath, "resources", "bin", "linux-system-audio-helper")
      );
      candidates.add(
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "resources",
          "bin",
          "linux-system-audio-helper"
        )
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  async getCapability({ force = false } = {}) {
    if (!this.isSupported()) {
      return this._buildCapability({ available: false, error: "Not running on Linux." });
    }

    if (!force && this.cachedCapability) {
      return this.cachedCapability;
    }

    if (!force && this.capabilityPromise) {
      return this.capabilityPromise;
    }

    const promise = this._probeCapability()
      .catch((error) => {
        debugLogger.warn(
          "[LinuxPortalAudioManager] Capability probe failed",
          { error: error.message },
          "meeting"
        );
        return this._buildCapability({ available: false, error: error.message });
      })
      .then((capability) => {
        this.cachedCapability = capability;
        return capability;
      })
      .finally(() => {
        this.capabilityPromise = null;
      });

    this.capabilityPromise = promise;
    return promise;
  }

  hasStoredRestoreToken() {
    return !!this.getStoredRestoreToken();
  }

  getStoredRestoreToken() {
    try {
      const raw = fs.readFileSync(this._tokenFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed?.restoreToken === "string" && parsed.restoreToken.trim()
        ? parsed.restoreToken.trim()
        : null;
    } catch {
      return null;
    }
  }

  async requestAccess() {
    const capability = await this.getCapability();
    if (!capability.available || !capability.supportsPersistentGrant) {
      return {
        granted: false,
        status: "unknown",
        restoreTokenAvailable: false,
        portalVersion: capability.portalVersion,
        error: capability.error,
      };
    }

    const result = await this._runJsonCommand(["grant"], REQUEST_TIMEOUT_MS);
    const restoreToken =
      typeof result?.restoreToken === "string" && result.restoreToken.trim()
        ? result.restoreToken.trim()
        : null;

    if (restoreToken) {
      this._writeTokenRecord({ restoreToken, portalVersion: capability.portalVersion });
    }

    return {
      granted: !!result?.granted && !!restoreToken,
      status: result?.granted && restoreToken ? "granted" : "unknown",
      restoreTokenAvailable: !!restoreToken,
      portalVersion: capability.portalVersion,
      error: result?.error,
    };
  }

  async start({ onChunk, onError, onWarning } = {}) {
    const capability = await this.getCapability();
    if (!capability.available || !capability.supportsSystemAudio) {
      throw new Error(capability.error || "Linux portal system audio helper is unavailable.");
    }

    if (this.process) {
      this.onChunk = onChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      return;
    }

    const binaryPath = this._prepareBinary();
    const restoreToken = this.getStoredRestoreToken();
    const args = ["start"];
    if (restoreToken) {
      args.push("--restore-token", restoreToken);
    }

    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process = child;
    this.onChunk = onChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.isStopping = false;
    this.stderrBuffer = "";

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(reject, new Error("Timed out starting Linux portal system audio capture."), true);
      }, START_TIMEOUT_MS);

      const finish = (callback, value, shouldStop = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (shouldStop) {
          void this.stop();
        }
        callback(value);
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) return;
        this.onChunk?.(chunk);
      });

      child.stderr.on("data", (chunk) => {
        this._consumeStderr(chunk, (message) => {
          if (message.type === "start") {
            if (typeof message.restoreToken === "string" && message.restoreToken.trim()) {
              this._writeTokenRecord({
                restoreToken: message.restoreToken.trim(),
                portalVersion: capability.portalVersion,
              });
            }
            finish(resolve);
            return;
          }

          if (message.type === "warning") {
            if (message.code === "restore_failed") {
              this.clearStoredRestoreToken();
            }
            this.onWarning?.(message);
            return;
          }

          if (message.type === "error") {
            if (
              message.code === "restore_failed" ||
              message.code === "permission_denied" ||
              message.code === "portal_denied"
            ) {
              this.clearStoredRestoreToken();
            }
            const error = this._buildProcessError(message);
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
              `Linux portal audio helper exited before start (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
          return;
        }

        if (!wasStopping) {
          this.onError?.(
            new Error(
              `Linux portal audio helper exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
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
    this.onWarning = null;
    this.isStopping = false;
  }

  clearStoredRestoreToken() {
    try {
      fs.unlinkSync(this._tokenFilePath());
    } catch {}
  }

  _prepareBinary() {
    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      throw new Error(
        "Linux portal system audio helper not found. Run `npm run compile:linux-system-audio` before packaging."
      );
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      fs.chmodSync(binaryPath, 0o755);
    }

    return binaryPath;
  }

  async _probeCapability() {
    if (!this.resolveBinary()) {
      return this._buildCapability({
        available: false,
        error: "Linux portal system audio helper binary not found.",
      });
    }

    const result = await this._runJsonCommand(["probe"], REQUEST_TIMEOUT_MS);
    return this._buildCapability(result);
  }

  _buildCapability(result = {}) {
    const portalVersion = Number.isFinite(result?.portalVersion) ? result.portalVersion : null;
    const supportsPersistMode = !!result?.supportsPersistMode;
    const supportsRestoreToken = !!result?.supportsRestoreToken;
    const supportsSystemAudio = !!result?.supportsSystemAudio;
    const supportsNativeCapture = !!result?.supportsNativeCapture;
    const available = !!result?.ok;
    const supportsPersistentPortalGrant =
      available && supportsPersistMode && supportsRestoreToken && supportsSystemAudio;
    const supportsPersistentGrant = supportsPersistentPortalGrant && supportsNativeCapture;

    return {
      available,
      portalVersion,
      supportsPersistMode,
      supportsRestoreToken,
      supportsPersistentPortalGrant,
      supportsNativeCapture,
      supportsPersistentGrant,
      supportsSystemAudio,
      error: typeof result?.error === "string" ? result.error : null,
      source: typeof result?.source === "string" ? result.source : null,
    };
  }

  _runJsonCommand(args, timeoutMs) {
    const binaryPath = this._prepareBinary();
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(reject, new Error(`Linux portal helper timed out running ${args[0]}.`), true);
      }, timeoutMs);

      const finish = (callback, value, shouldStop = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (shouldStop) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        callback(value);
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        finish(reject, error);
      });

      child.on("exit", (code) => {
        if (settled) return;

        if (code !== 0) {
          const message = stderr.trim() || stdout.trim() || `exit code ${code}`;
          finish(reject, new Error(message));
          return;
        }

        try {
          finish(resolve, JSON.parse(stdout.trim() || "{}"));
        } catch (error) {
          finish(
            reject,
            new Error(
              `Linux portal helper returned invalid JSON for ${args[0]}: ${stdout.trim().slice(0, 200)}`
            )
          );
        }
      });
    });
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
          debugLogger.warn("[LinuxPortalAudioManager] Non-JSON stderr output", { line }, "meeting");
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  _buildProcessError(message) {
    const error = new Error(message.message || "Linux portal system audio capture failed");
    error.code = message.code;
    error.status = message.status;
    error.operation = message.operation;
    return error;
  }

  _tokenFilePath() {
    return path.join(app.getPath("userData"), TOKEN_FILE_NAME);
  }

  _writeTokenRecord({ restoreToken, portalVersion }) {
    if (!restoreToken) return;

    try {
      fs.writeFileSync(
        this._tokenFilePath(),
        JSON.stringify(
          {
            restoreToken,
            portalVersion: portalVersion ?? null,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
    } catch (error) {
      debugLogger.warn(
        "[LinuxPortalAudioManager] Failed to persist restore token",
        { error: error.message },
        "meeting"
      );
    }
  }
}

module.exports = LinuxPortalAudioManager;
