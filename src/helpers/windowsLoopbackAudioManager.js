const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 3000;
const PROBE_TIMEOUT_MS = 5000;
const TRANSIENT_CAPABILITY_TTL_MS = 30000;
const SAMPLE_RATE = 24000;
const BINARY_NAME = "windows-system-audio-helper.exe";

// Captures system audio on Windows via a native WASAPI process-loopback
// helper. Unlike Chromium's display-media loopback (which only hears the
// default render device), process loopback hears every application on every
// output device and excludes OpenWhispr's own audio.
class WindowsLoopbackAudioManager {
  constructor() {
    this.process = null;
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
    this.cachedCapability = null;
    this.cachedCapabilityExpiresAt = 0;
    this.capabilityPromise = null;
  }

  isSupported() {
    return process.platform === "win32";
  }

  isAvailable() {
    return !!this.resolveBinary();
  }

  resolveBinary() {
    const candidates = new Set([path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME)]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, BINARY_NAME));
      candidates.add(path.join(process.resourcesPath, "bin", BINARY_NAME));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", BINARY_NAME));
      candidates.add(
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", BINARY_NAME)
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
      return { available: false, error: "Not running on Windows." };
    }

    if (!force && this.cachedCapability && Date.now() < this.cachedCapabilityExpiresAt) {
      return this.cachedCapability;
    }

    if (!force && this.capabilityPromise) {
      return this.capabilityPromise;
    }

    // Definitive probe results are cached for the session. Transient failures
    // (the helper's own activation timeout, a spawn failure, a probe that hung)
    // are cached only briefly so a momentary audio-stack hiccup can't pin the
    // native path "unavailable" until restart, while still bounding how often
    // IPC capability checks can respawn the probe.
    const promise = this._probeCapability()
      .then((capability) => {
        this._cacheCapability(capability, this._isTransientProbeFailure(capability));
        return capability;
      })
      .catch((error) => {
        debugLogger.warn(
          "[WindowsLoopbackAudioManager] Capability probe failed",
          { error: error.message },
          "meeting"
        );
        const capability = { available: false, error: error.message };
        this._cacheCapability(capability, true);
        return capability;
      })
      .finally(() => {
        this.capabilityPromise = null;
      });

    this.capabilityPromise = promise;
    return promise;
  }

  _cacheCapability(capability, transient) {
    this.cachedCapability = capability;
    this.cachedCapabilityExpiresAt = transient
      ? Date.now() + TRANSIENT_CAPABILITY_TTL_MS
      : Infinity;
  }

  _isTransientProbeFailure(capability) {
    return !capability.available && /activation_timeout/i.test(capability.error || "");
  }

  async start({ onChunk, onError, onWarning } = {}) {
    const capability = await this.getCapability();
    if (!capability.available) {
      throw new Error(capability.error || "Windows system audio helper is unavailable.");
    }

    if (this.process) {
      this.onChunk = onChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      return;
    }

    const binaryPath = this.resolveBinary();
    const args = [
      "start",
      "--exclude-pid",
      String(process.pid),
      "--sample-rate",
      String(SAMPLE_RATE),
    ];

    // stdin stays piped so the helper can detect parent death via EOF.
    const child = spawn(binaryPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.onChunk = onChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.isStopping = false;
    this.stderrBuffer = "";

    await new Promise((resolve, reject) => {
      let settled = false;
      let fatalErrorReported = false;
      const timeout = setTimeout(() => {
        finish(reject, new Error("Timed out starting Windows system audio capture."), true);
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
            finish(resolve);
            return;
          }

          if (message.type === "warning") {
            this.onWarning?.(message);
            return;
          }

          if (message.type === "error") {
            const error = this._buildProcessError(message);
            if (!settled) {
              finish(reject, error, true);
            } else {
              fatalErrorReported = true;
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
              `Windows system audio helper exited before start (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
          return;
        }

        // Skip the synthetic exit error when the helper already delivered a
        // specific JSON error event, so the informative message isn't
        // clobbered by the generic one.
        if (!wasStopping && !fatalErrorReported) {
          this.onError?.(
            new Error(
              `Windows system audio helper exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
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

    // Resolve only once the child has actually exited (kill on timeout, then
    // keep waiting) so cleanup below can't reset isStopping while the child is
    // still alive — a late exit would otherwise surface a spurious
    // "exited unexpectedly" error into a subsequent capture session.
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          resolve();
        }
      }, STOP_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      // Closing stdin signals the helper to exit gracefully.
      try {
        child.stdin.end();
      } catch {
        try {
          child.kill();
        } catch {
          clearTimeout(timeout);
          resolve();
        }
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

  async _probeCapability() {
    if (!this.resolveBinary()) {
      return { available: false, error: "Windows system audio helper binary not found." };
    }

    const result = await this._runJsonCommand(["probe"], PROBE_TIMEOUT_MS);
    return {
      available: !!result?.ok,
      error: typeof result?.error === "string" ? result.error : null,
    };
  }

  _runJsonCommand(args, timeoutMs) {
    const child = spawn(this.resolveBinary(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(
          reject,
          new Error(`Windows system audio helper timed out running ${args[0]}.`),
          true
        );
      }, timeoutMs);

      const finish = (callback, value, shouldKill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (shouldKill) {
          try {
            child.kill();
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
        } catch {
          finish(
            reject,
            new Error(
              `Windows system audio helper returned invalid JSON for ${args[0]}: ${stdout.trim().slice(0, 200)}`
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
          debugLogger.warn(
            "[WindowsLoopbackAudioManager] Non-JSON stderr output",
            { line },
            "meeting"
          );
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  _buildProcessError(message) {
    const error = new Error(message.message || "Windows system audio capture failed");
    error.code = message.code;
    return error;
  }
}

module.exports = WindowsLoopbackAudioManager;
