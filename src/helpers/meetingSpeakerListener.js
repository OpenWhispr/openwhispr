const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const {
  MEETING_APP_SPEAKER_TARGETS,
  interpretMeetingAppSnapshot,
} = require("./meetingAppSpeakerAdapters");

const BINARY_NAME = "macos-meeting-speaker-listener";
const POLL_INTERVAL_MS = 500;
// The helper stamps a change when it next polls, on average half an interval
// after it happened. The meeting app's own highlight delay comes on top and
// isn't measured yet.
const MEETING_SPEAKER_STATE_LAG_MS = POLL_INTERVAL_MS / 2;
const START_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 2000;
// A snapshot is a few KB; a line this long means the helper is misbehaving.
const MAX_LINE_LENGTH = 2 * 1024 * 1024;

const EMPTY_STATE = Object.freeze({ participants: [], speakingIds: [], strategy: "none" });

// Runs resources/macos-meeting-speaker-listener.swift for the length of a
// meeting and turns its accessibility snapshots into speaking states for
// meetingSpeakerFusion.js. Helper output carries participant names, so it is
// never logged — only counts and strategies.
class MeetingSpeakerListener {
  constructor({ spawnProcess = spawn, platform = process.platform, binaryPath = null } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.binaryPathOverride = binaryPath;
    this.process = null;
    this.stdoutBuffer = "";
    this.isStopping = false;
    this.onState = null;
    this.onError = null;
    this.lastStrategy = null;
  }

  isSupported() {
    return this.platform === "darwin";
  }

  isAvailable() {
    return this.isSupported() && !!this.resolveBinary();
  }

  resolveBinary() {
    if (this.binaryPathOverride) {
      return this.binaryPathOverride;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME),
      path.join(__dirname, "..", "..", "resources", BINARY_NAME),
    ]);

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

  // onState receives { at, participants, speakingIds, strategy } whenever the
  // meeting app's tree changes, and an empty state when the app, its meeting
  // window or the helper goes away.
  async start({ onState, onError } = {}) {
    if (!this.isSupported()) {
      throw new Error("Meeting app speaker labels need macOS.");
    }
    if (this.process) {
      await this.stop();
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      throw new Error(
        "Meeting speaker listener binary not found. Run `npm run compile:meeting-speaker-listener`."
      );
    }
    this._ensureExecutable(binaryPath);

    this.onState = onState || null;
    this.onError = onError || null;
    this.isStopping = false;
    this.stdoutBuffer = "";
    this.lastStrategy = null;

    const args = [
      ...MEETING_APP_SPEAKER_TARGETS.flatMap(({ bundleId, pageTitle }) =>
        pageTitle ? ["--bundle-id", bundleId, "--page-title", pageTitle] : ["--bundle-id", bundleId]
      ),
      "--interval-ms",
      String(POLL_INTERVAL_MS),
    ];
    const child = this.spawnProcess(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(reject, new Error("Timed out starting the meeting speaker listener."), true);
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
        this._consumeStdout(chunk, (message) => {
          if (message.type === "start") {
            finish(resolve);
            return;
          }

          if (message.type === "error") {
            const error = this._buildProcessError(message);
            if (!settled) {
              finish(reject, error, true);
            } else {
              this.onError?.(error);
            }
            return;
          }

          this._handleMessage(message);
        });
      });

      // The helper reports through stdout; stderr only carries Swift runtime
      // failures, which can quote element text.
      child.stderr.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        debugLogger.debug(
          "[MeetingSpeakerListener] stderr output",
          { bytes: chunk.length },
          "meeting"
        );
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
              `Meeting speaker listener exited before start (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
          return;
        }

        if (!wasStopping) {
          // Nothing reports speaking any more; end whatever was still open.
          this._emitState(Date.now(), EMPTY_STATE);
          this.onError?.(
            new Error(
              `Meeting speaker listener exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
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
    this.stdoutBuffer = "";
    this.onState = null;
    this.onError = null;
    this.isStopping = false;
  }

  _handleMessage(message) {
    if (message.type === "status") {
      debugLogger.debug(
        "[MeetingSpeakerListener] status",
        { state: message.state, bundleIds: message.bundleIds, axError: message.axError },
        "meeting"
      );
      if (message.state !== "tracking") {
        this._emitState(Date.now(), EMPTY_STATE);
      }
      return;
    }

    if (message.type === "snapshot") {
      const at = Number.isFinite(message.at) ? message.at : Date.now();
      this._emitState(at, interpretMeetingAppSnapshot(message));
    }
  }

  _emitState(at, state) {
    if (state.strategy !== this.lastStrategy) {
      this.lastStrategy = state.strategy;
      debugLogger.debug(
        "[MeetingSpeakerListener] speaker strategy",
        {
          strategy: state.strategy,
          participants: state.participants.length,
          speaking: state.speakingIds.length,
        },
        "meeting"
      );
    }
    this.onState?.({ at, ...state });
  }

  _ensureExecutable(binaryPath) {
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {
        // spawn reports whatever is still wrong with the binary.
      }
    }
  }

  _consumeStdout(chunk, onMessage) {
    this.stdoutBuffer += chunk.toString();
    let newlineIndex = this.stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          debugLogger.warn(
            "[MeetingSpeakerListener] Non-JSON stdout output",
            { length: line.length },
            "meeting"
          );
        }
        if (message && typeof message === "object") {
          onMessage(message);
        }
      }

      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }

    if (this.stdoutBuffer.length > MAX_LINE_LENGTH) {
      debugLogger.warn(
        "[MeetingSpeakerListener] Dropping oversized output",
        { length: this.stdoutBuffer.length },
        "meeting"
      );
      this.stdoutBuffer = "";
    }
  }

  _buildProcessError(message) {
    const error = new Error(message.message || "Meeting speaker listener failed");
    error.code = message.code;
    return error;
  }
}

module.exports = MeetingSpeakerListener;
module.exports.MEETING_SPEAKER_STATE_LAG_MS = MEETING_SPEAKER_STATE_LAG_MS;
