const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

const START_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 2000;
const SYSTEM_STREAM = 1;
const MIC_STREAM = 2;
const SAMPLE_RATE = 24000;

class MeetingAecManager {
  constructor() {
    this.process = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
    this.onMicChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
  }

  isSupported() {
    return (
      process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    );
  }

  isAvailable() {
    return !!this.resolveBinary();
  }

  resolveBinary() {
    if (!this.isSupported()) {
      return null;
    }

    const binaryName = `meeting-aec-helper-${process.platform}-${process.arch}${
      process.platform === "win32" ? ".exe" : ""
    }`;
    const candidates = new Set([path.join(__dirname, "..", "..", "resources", "bin", binaryName)]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "bin", binaryName));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", binaryName));
      candidates.add(path.join(process.resourcesPath, binaryName));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  async start({ onMicChunk, onError, onWarning } = {}) {
    if (this.process) {
      this.onMicChunk = onMicChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      return true;
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      return false;
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      if (process.platform !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
      }
    }

    const child = spawn(binaryPath, ["--sample-rate", String(SAMPLE_RATE)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
    this.onMicChunk = onMicChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.isStopping = false;

    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      const timeout = setTimeout(() => {
        finish(false);
        void this.stop();
      }, START_TIMEOUT_MS);

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStdout(chunk);
      });

      child.stderr.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStderr(chunk, (message) => {
          if (message.type === "start") {
            started = true;
            finish(true);
            return;
          }
          if (message.type === "warning") {
            this.onWarning?.(message);
            return;
          }
          if (message.type === "error") {
            this.onError?.(new Error(message.message || "Meeting AEC helper failed"));
          }
        });
      });

      child.on("error", (error) => {
        if (!this.isStopping) {
          this.onError?.(error);
        }
        finish(false);
      });

      child.on("exit", (code, signal) => {
        const wasStopping = this.isStopping;
        if (this.process === child) {
          this.process = null;
        }
        this.isStopping = false;
        if (!wasStopping && (code || signal)) {
          this.onError?.(
            new Error(
              `Meeting AEC helper exited unexpectedly (code ${code ?? "null"}, signal ${
                signal ?? "null"
              })`
            )
          );
        }
        finish(started && (code === 0 || code === null));
      });
    });
  }

  processSystemBuffer(buffer) {
    return this._writeFrame(SYSTEM_STREAM, buffer);
  }

  processMicBuffer(buffer) {
    return this._writeFrame(MIC_STREAM, buffer);
  }

  async stop() {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.isStopping = true;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (child.exitCode == null) {
          child.kill();
        }
        finish();
      }, STOP_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timeout);
        finish();
      });

      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      } else {
        clearTimeout(timeout);
        finish();
      }
    });

    if (this.process === child) {
      this.process = null;
    }
    this.isStopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
  }

  _writeFrame(type, buffer) {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) {
      return false;
    }

    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!payload.length) {
      return true;
    }

    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(payload.length, 1);
    stdin.write(Buffer.concat([header, payload]));
    return true;
  }

  _consumeStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (this.stdoutBuffer.length >= 4) {
      const frameLength = this.stdoutBuffer.readUInt32LE(0);
      if (this.stdoutBuffer.length < 4 + frameLength) {
        return;
      }

      const payload = this.stdoutBuffer.subarray(4, 4 + frameLength);
      this.stdoutBuffer = this.stdoutBuffer.subarray(4 + frameLength);
      this.onMicChunk?.(Buffer.from(payload));
    }
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
          debugLogger.warn("[MeetingAecManager] Non-JSON stderr output", { line }, "meeting");
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }
}

module.exports = MeetingAecManager;
