const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const { resolveBundledBinary } = require("./binaryResolver");
const {
  EMPTY_SPEAKER_STATE,
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

// Runs resources/macos-meeting-speaker-listener.swift for the length of a
// meeting and turns its accessibility snapshots into speaking states for
// meetingSpeakerFusion.js. Helper output carries participant names, so it is
// never logged — only counts and strategies.
class MeetingSpeakerListener {
  constructor({
    spawnProcess = spawn,
    platform = process.platform,
    arch = process.arch,
    binaryPath = null,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.arch = arch;
    this.binaryPathOverride = binaryPath;
    this.process = null;
    this.stdoutBuffer = "";
    this.isStopping = false;
    this.onState = null;
    this.onError = null;
    this.lastStrategy = null;
    // Everyone seen this session, so a caption from someone whose tile is off
    // screen still matches a name, and who the session knows is the user.
    this.knownParticipants = new Map();
    this.knownSelfIds = new Set();
    this.lastTruncatedWindows = 0;
    // The start in progress; a stop clears it, so a start still waiting on an
    // older helper's exit knows it was cancelled meanwhile.
    this.pendingStart = null;
  }

  // The labels name voices live speaker identification finds, which needs
  // onnxruntime-node: it has no Intel Mac binding (#1500).
  isSupported() {
    return this.platform === "darwin" && this.arch !== "x64";
  }

  isAvailable() {
    return this.isSupported() && !!this.resolveBinary();
  }

  resolveBinary() {
    return this.binaryPathOverride || resolveBundledBinary(BINARY_NAME, "meeting", { quiet: true });
  }

  // onState receives { at, participants, speakingIds, strategy } whenever the
  // meeting app's tree changes, and an empty state when the app, its meeting
  // window or the helper goes away.
  async start({ onState, onError } = {}) {
    if (!this.isSupported()) {
      throw new Error("Meeting app speaker labels need a Mac with Apple silicon.");
    }
    const pendingStart = {};
    this.pendingStart = pendingStart;
    if (this.process) {
      await this._stopProcess();
    }
    if (this.pendingStart !== pendingStart) {
      throw new Error("Meeting speaker listener start was cancelled.");
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      throw new Error(
        "Meeting speaker listener binary not found. Run `npm run compile:meeting-speaker-listener`."
      );
    }

    this.onState = onState || null;
    this.onError = onError || null;
    this.isStopping = false;
    this.stdoutBuffer = "";
    this.lastStrategy = null;
    this.knownParticipants = new Map();
    this.knownSelfIds = new Set();
    this.lastTruncatedWindows = 0;

    const args = [
      ...MEETING_APP_SPEAKER_TARGETS.flatMap(({ bundleId, pages }) => [
        "--bundle-id",
        bundleId,
        ...pages.flatMap(({ pageTitle, pageMarker }) => [
          "--page-title",
          pageTitle,
          "--page-marker",
          pageMarker,
        ]),
      ]),
      "--interval-ms",
      String(POLL_INTERVAL_MS),
    ];
    const child = this.spawnProcess(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    // Decoded as a stream: a name's multibyte character can straddle two reads.
    child.stdout.setEncoding("utf8");

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
          this._emitState(Date.now(), EMPTY_SPEAKER_STATE);
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
    this.pendingStart = null;
    return this._stopProcess();
  }

  async _stopProcess() {
    if (!this.process) {
      this.onState = null;
      this.onError = null;
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
    // A line the helper wrote just before it was told to stop must not reopen
    // a speaker the stop has just closed.
    if (this.isStopping) return;
    if (message.type === "status") {
      debugLogger.debug(
        "[MeetingSpeakerListener] status",
        {
          state: message.state,
          bundleIds: message.bundleIds,
          unreadable: message.unreadable,
          busy: message.busy,
        },
        "meeting"
      );
      if (message.state !== "tracking") {
        this._emitState(Date.now(), EMPTY_SPEAKER_STATE);
      }
      return;
    }

    if (message.type === "snapshot") {
      const at = Number.isFinite(message.at) ? message.at : Date.now();
      const truncatedWindows = Array.isArray(message.windows)
        ? message.windows.filter((window) => window?.truncated).length
        : 0;
      if (truncatedWindows !== this.lastTruncatedWindows) {
        // A cut-off window names no one; worth seeing in the log of a large call.
        this.lastTruncatedWindows = truncatedWindows;
        debugLogger.debug(
          "[MeetingSpeakerListener] snapshot cut off",
          { truncatedWindows },
          "meeting"
        );
      }
      let state;
      try {
        state = interpretMeetingAppSnapshot(message, {
          knownParticipants: this.knownParticipants,
          knownSelfIds: this.knownSelfIds,
        });
      } catch (error) {
        // An app's new layout must cost its labels, never the main process.
        debugLogger.warn(
          "[MeetingSpeakerListener] Could not read snapshot",
          { error: error.name },
          "meeting"
        );
        state = EMPTY_SPEAKER_STATE;
      }
      for (const participant of state.participants) {
        if (participant.isSelf) {
          // Marked as the user later than first seen (Zoom's home window, a
          // Teams self tile): never a remote name again this session.
          this.knownSelfIds.add(participant.id);
          this.knownParticipants.delete(participant.id);
        } else if (!this.knownSelfIds.has(participant.id)) {
          this.knownParticipants.set(participant.id, participant);
        }
      }
      this._emitState(at, state);
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

  _consumeStdout(chunk, onMessage) {
    this.stdoutBuffer += chunk;
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

// Main reads the meeting app only for a recording that asked for it, in a
// meeting that isn't 1:1 (its one remote voice is already named after the
// attendee), with the helper present.
function shouldReadMeetingApp({ options, oneOnOneAttendee, available }) {
  return options?.appSpeakerLabelsEnabled === true && !oneOnOneAttendee && available;
}

module.exports = MeetingSpeakerListener;
module.exports.shouldReadMeetingApp = shouldReadMeetingApp;
module.exports.MEETING_SPEAKER_STATE_LAG_MS = MEETING_SPEAKER_STATE_LAG_MS;
