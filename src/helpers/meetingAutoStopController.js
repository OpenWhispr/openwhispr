const debugLogger = require("./debugLogger");
const { MeetingInactivityMonitor, computeRmsFromPcm16 } = require("./meetingInactivityMonitor");

const SILENCE_COUNTDOWN_MS = 30_000;
// The tracked meeting app quitting is a much stronger signal than plain
// silence, so the warning gets a shorter runway.
const PROCESS_EXIT_COUNTDOWN_MS = 15_000;
const TICK_INTERVAL_MS = 1000;

// Watches an active meeting recording for "the call is over" evidence —
// sustained silence on both channels, or the meeting app exiting — and drives
// the warn-then-stop flow through the meeting notification overlay. The
// countdown itself lives in windowManager's NotificationDismissTimer (so it
// pauses while the user hovers the card); its expiry routes back here.
class MeetingAutoStopController {
  constructor({ windowManager, processDetector = null }) {
    this.windowManager = windowManager;
    this.processDetector = processDetector;
    this.enabled = true;
    this.monitor = new MeetingInactivityMonitor({
      onEvent: (type, payload) => this._onMonitorEvent(type, payload),
    });
    this._tickInterval = null;
    this._recordingActive = false;
    this._recordingWin = null;
    // Meeting apps present at recording start or launched during it. A
    // process exit only counts as "this call ended" for these; manual and
    // calendar meetings with no tracked app leave the set empty.
    this._sessionProcessKeys = new Set();
    this._endedAppName = null;
    this._promptReason = null;
    // Set once a stop has been dispatched to the renderer; monitor events in
    // the window before meeting-transcription-stop lands must be ignored.
    this._stopping = false;

    if (this.processDetector) {
      this.processDetector.on("meeting-process-detected", (data) => {
        if (this._recordingActive && data?.processKey) {
          this._sessionProcessKeys.add(data.processKey);
        }
      });
      this.processDetector.on("meeting-process-ended", (data) => this._onProcessEnded(data));
    }
  }

  setEnabled(enabled) {
    const next = enabled !== false;
    if (next === this.enabled) {
      return;
    }
    this.enabled = next;

    if (!next) {
      this._stopMonitoring();
      this._dismissOwnPrompt();
    } else if (this._recordingActive) {
      this._startMonitoring();
    }
  }

  onRecordingStarted(win) {
    this.onRecordingStopped();
    this._recordingActive = true;
    this._recordingWin = win ?? null;
    this._sessionProcessKeys = new Set(
      (this.processDetector?.getDetectedProcesses?.() ?? [])
        .map((p) => p?.processKey)
        .filter(Boolean)
    );

    if (this.enabled) {
      this._startMonitoring();
    }
  }

  onRecordingStopped() {
    this._stopMonitoring();
    this._dismissOwnPrompt();
    this._recordingActive = false;
    this._recordingWin = null;
    this._sessionProcessKeys.clear();
    this._endedAppName = null;
    this._promptReason = null;
    this._stopping = false;
  }

  // Hot path — called for every meeting PCM chunk (~33ms each per channel).
  recordChunk(source, buffer) {
    if (!this._tickInterval || this._stopping) {
      return;
    }
    // Activity already registered for this tick; skip the RMS pass.
    if (this.monitor.activityPending) {
      return;
    }
    this.monitor.recordChunkRms(source, computeRmsFromPcm16(buffer));
  }

  handleResponse(detectionId, action) {
    if (!this._recordingActive) {
      this.windowManager?.dismissMeetingNotification();
      return;
    }

    debugLogger.info("Auto-stop prompt response", { detectionId, action }, "meeting");

    if (action === "stop") {
      this.windowManager?.dismissMeetingNotification();
      this._dispatchStop();
      return;
    }

    // "keep" and the non-destructive X both mean the meeting is still on.
    this.monitor.keepRecording(Date.now());
    this._promptReason = null;
    this.windowManager?.dismissMeetingNotification();
  }

  handleCountdownExpired() {
    this._dispatchStop();
  }

  _dispatchStop() {
    if (!this._recordingActive || this._stopping) {
      return;
    }
    this._stopping = true;

    const reason = this._promptReason ?? "silence";
    // The store that owns stopRecording() lives in the window that started the
    // recording; fall back to the control panel like the diarization events do.
    let win = this._recordingWin;
    if (!win || win.isDestroyed()) {
      win = this.windowManager?.controlPanelWindow;
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send("meeting-auto-stop", { reason });
      debugLogger.info("Meeting auto-stop dispatched", { reason }, "meeting");
    } else {
      debugLogger.warn("No window to deliver meeting auto-stop", { reason }, "meeting");
    }
  }

  _onProcessEnded(data) {
    if (!this.enabled || !this._recordingActive || this._stopping || !data?.processKey) {
      return;
    }
    if (!this._sessionProcessKeys.has(data.processKey)) {
      return;
    }
    this._sessionProcessKeys.delete(data.processKey);

    // Another tracked meeting app is still up (the detector deletes the ended
    // key before emitting, so the remaining list is current).
    if ((this.processDetector?.getDetectedProcesses?.() ?? []).length > 0) {
      return;
    }

    this._endedAppName = data.appName ?? null;
    debugLogger.info(
      "Meeting app exited during recording, tightening silence window",
      { processKey: data.processKey },
      "meeting"
    );
    this.monitor.armFast(Date.now());
  }

  _onMonitorEvent(type, payload) {
    if (!this._recordingActive || this._stopping) {
      return;
    }

    if (type === "silence-threshold-reached") {
      const reason = payload?.reason === "process-exit" ? "process-exit" : "silence";
      this._promptReason = reason;
      const countdownMs =
        reason === "process-exit" ? PROCESS_EXIT_COUNTDOWN_MS : SILENCE_COUNTDOWN_MS;

      debugLogger.info("Meeting inactivity threshold reached", { reason }, "meeting");
      void this.windowManager?.showMeetingNotification({
        detectionId: `auto-stop:${reason}`,
        source: "auto-stop",
        key: reason,
        variant: "ending",
        appName: reason === "process-exit" ? this._endedAppName : null,
        countdownMs,
        timeoutMs: countdownMs,
        event: null,
        joinUrl: null,
      });
      return;
    }

    if (type === "activity-resumed") {
      this._promptReason = null;
      this._dismissOwnPrompt();
    }
  }

  _dismissOwnPrompt() {
    if (this.windowManager?._pendingNotificationData?.source === "auto-stop") {
      this.windowManager.dismissMeetingNotification();
    }
  }

  _startMonitoring() {
    if (this._tickInterval) {
      return;
    }
    this.monitor.start(Date.now());
    this._tickInterval = setInterval(() => this.monitor.tick(Date.now()), TICK_INTERVAL_MS);
    this._tickInterval.unref?.();
  }

  _stopMonitoring() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    this.monitor.stop();
  }
}

module.exports = MeetingAutoStopController;
