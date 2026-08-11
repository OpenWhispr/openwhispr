const { BrowserWindow, shell } = require("electron");
const debugLogger = require("./debugLogger");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");
const health = require("./meetingDetectionHealth");
const { resetAutomationDenied } = require("./browserMeetingUrlChecker");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_AUTO_RECORD_MS = 4 * 60 * 60 * 1000; // safety cap for auto-started recordings
// Backstop only: the latch is cleared where the session ends. Long enough not to
// interrupt a meeting being set up, short enough that a missed clear costs one
// coffee break rather than the rest of the day.
const MEETING_MODE_WATCHDOG_MS = 15 * 60 * 1000;
// An unanswered prompt keeps its detection id reserved; without an expiry that id
// is blocked for the life of the process.
const DETECTION_TTL_MS = 30 * 60 * 1000;

const PLACEHOLDER_PREFIX = { __detected__: "detected", __manual__: "manual" };

function placeholderEvent(calendarId) {
  const now = Date.now();
  return {
    id: `${PLACEHOLDER_PREFIX[calendarId]}-${now}`,
    calendar_id: calendarId,
    summary: "New note",
    start_time: new Date(now).toISOString(),
    end_time: new Date(now + 3600000).toISOString(),
    is_all_day: 0,
    status: "confirmed",
    hangout_link: null,
    conference_data: null,
    organizer_email: null,
    attendees_count: 0,
  };
}

class MeetingDetectionEngine {
  constructor(
    googleCalendarManager,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager,
    callStateDetector = null
  ) {
    this.googleCalendarManager = googleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.callStateDetector = callStateDetector;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true, autoStartRecording: false };
    this._userRecording = false;
    this._meetingModeActive = false;
    this._autoStarted = false;
    this._autoStopTimer = null;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._bindListeners();
  }

  // Assignment publishes the latch, so a future call site cannot quietly skip
  // telemetry for the two flags that can silently disable detection.
  get _meetingModeActive() {
    return this.__meetingModeActive ?? false;
  }

  set _meetingModeActive(value) {
    this.__meetingModeActive = value;
    health.setLatches({ meetingModeActive: value });
    if (value) this._armMeetingModeWatchdog();
    else this._clearMeetingModeWatchdog();
  }

  get _userRecording() {
    return this.__userRecording ?? false;
  }

  set _userRecording(value) {
    this.__userRecording = value;
    health.setLatches({ userRecording: value });
  }

  _bindListeners() {
    // Process detection is context-only — track running apps but don't trigger notifications.
    // This avoids false positives from apps like FaceTime running in the background.
    this.meetingProcessDetector.on("meeting-process-detected", (data) => {
      debugLogger.info(
        "Meeting app running (context only)",
        { processKey: data.processKey, appName: data.appName },
        "meeting"
      );
    });

    this.meetingProcessDetector.on("meeting-process-ended", (data) => {
      this.activeDetections.delete(`process:${data.processKey}`);
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection("audio", "sustained-audio", data);
    });

    // Camera/mic device-in-use — the "actually in a call" signal used for
    // opt-in auto-start. Fires even when muted; ignores idle meeting tabs.
    if (this.callStateDetector) {
      this.callStateDetector.on("call-active", (data) => this._handleCallActive(data));
      this.callStateDetector.on("call-ended", () => this._handleCallEnded());
    }
  }

  _handleCallActive(data) {
    if (!this.preferences.autoStartRecording) return;
    if (this._meetingModeActive || this._userRecording) {
      debugLogger.debug(
        "Call active but a recording/meeting is already in progress",
        {},
        "meeting"
      );
      return;
    }
    // Confirm it's really a meeting, not incidental camera/mic use (Photo Booth,
    // a voice memo). A browser meeting-URL match confirms it; if Automation is
    // denied we can't check, so we trust the device-in-use signal.
    const urlMatch = data?.urlMatch;
    // Three outcomes:
    // 1. matched=true → definitely a meeting → auto-start
    // 2. denied/unavailable/null → can't check → trust device signal → auto-start
    // 3. matched=false (confident) → no meeting → skip
    const urlCheckRan = urlMatch && !urlMatch.denied && !urlMatch.unavailable;
    const noMeetingFound = urlCheckRan && !urlMatch.matched;

    if (noMeetingFound) {
      debugLogger.info(
        "Camera/mic in use but browser check found no meeting URL; not auto-starting",
        { devices: data?.devices },
        "meeting"
      );
      return;
    }

    if (!urlMatch?.matched) {
      debugLogger.info(
        "Camera/mic in use; URL check unavailable — trusting device signal for auto-start",
        { devices: data?.devices, reason: urlMatch?.denied ? "denied" : urlMatch?.unavailable ? "unavailable" : "no-checker" },
        "meeting"
      );
    }
    debugLogger.info(
      "Auto-starting meeting recording (call detected)",
      { devices: data?.devices, url: urlMatch?.url, browser: urlMatch?.browser },
      "meeting"
    );
    this._autoStarted = true;
    this._beginMeetingSession(placeholderEvent("__detected__"), "auto-start")
      .then((ok) => {
        if (ok) {
          // Tell the detector we now hold the mic, so it switches to camera/URL
          // end-detection, and arm a max-duration safety stop.
          this.callStateDetector?.setSelfRecording(true);
          this._armAutoStopSafety();
        } else {
          this._autoStarted = false;
        }
      })
      .catch((error) => {
        this._autoStarted = false;
        // The latch is set before the navigation is awaited, so a rejection here
        // would otherwise disable detection for the rest of the process.
        this._meetingModeActive = false;
        debugLogger.error("Auto-start meeting failed", { error: error?.message }, "meeting");
      });
  }

  _handleCallEnded() {
    this._clearAutoStopSafety();
    // Only auto-stop sessions that were auto-started — never a manual recording.
    if (this._autoStarted && this._userRecording) {
      debugLogger.info("Call ended — auto-stopping recording", {}, "meeting");
      this.broadcastToWindows("meeting-auto-stop-request", {});
    }
    this._autoStarted = false;
  }

  _armMeetingModeWatchdog() {
    this._clearMeetingModeWatchdog();
    if (this._userRecording) return; // a live recording is a legitimate reason to stay latched
    this._meetingModeWatchdog = setTimeout(() => {
      this._meetingModeWatchdog = null;
      if (!this.__meetingModeActive || this._userRecording) return;
      debugLogger.warn(
        "Meeting mode was still latched with no recording; clearing",
        { afterMs: MEETING_MODE_WATCHDOG_MS },
        "meeting"
      );
      health.recordSuppression("watchdog-cleared-meeting-mode", {});
      this.setMeetingModeActive(false);
    }, MEETING_MODE_WATCHDOG_MS);
    this._meetingModeWatchdog?.unref?.();
  }

  _clearMeetingModeWatchdog() {
    if (this._meetingModeWatchdog) {
      clearTimeout(this._meetingModeWatchdog);
      this._meetingModeWatchdog = null;
    }
  }

  _sweepStaleDetections() {
    const now = Date.now();
    for (const [detectionId, detection] of this.activeDetections) {
      if (typeof detection?.at === "number" && now - detection.at >= DETECTION_TTL_MS) {
        this.activeDetections.delete(detectionId);
        health.recordSuppression("detection-expired", { detectionId });
      }
    }
  }

  // Ask every detector to prove it is still working — used after the machine
  // wakes, when a child may have died while we were asleep.
  revalidate(reason = "revalidate") {
    debugLogger.info("Revalidating meeting detection", { reason }, "meeting");
    // Automation denial is cached for the process; the user may have granted it
    // since, and the URL check is what separates a meeting from Photo Booth.
    resetAutomationDenied();
    this.audioActivityDetector?.revalidate?.(reason);
    this.callStateDetector?.revalidate?.(reason);
  }

  _armAutoStopSafety() {
    this._clearAutoStopSafety();
    this._autoStopTimer = setTimeout(() => {
      debugLogger.warn("Auto-started recording hit the max duration; stopping", {}, "meeting");
      this._handleCallEnded();
    }, MAX_AUTO_RECORD_MS);
  }

  _clearAutoStopSafety() {
    if (this._autoStopTimer) {
      clearTimeout(this._autoStopTimer);
      this._autoStopTimer = null;
    }
  }

  // Shared "begin a meeting recording" path used by both the notification
  // "start" action and auto-start: create the meeting note and navigate the
  // renderer, which then starts the actual recording.
  async _beginMeetingSession(event, trigger) {
    const eventSummary = event?.summary || "New note";
    const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Meeting note creation failed",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      return false;
    }

    this._meetingModeActive = true;
    this.broadcastToWindows("note-added", noteResult.note);

    const isRealEvent =
      event?.calendar_id &&
      event.calendar_id !== "__detected__" &&
      event.calendar_id !== "__manual__";

    if (isRealEvent) {
      const calEvent = this.databaseManager.getCalendarEventById(event.id);
      const updates = { calendar_event_id: event.id };
      if (calEvent?.attendees) {
        updates.participants = calEvent.attendees;
      }
      const meetingTypeId = this.databaseManager.autoMapMeetingType(eventSummary);
      if (meetingTypeId) {
        updates.meeting_type_id = meetingTypeId;
      }
      const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);
      if (updateResult?.success && updateResult?.note) {
        this.broadcastToWindows("note-updated", updateResult.note);
      }
    }

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event,
      trigger,
    });

    this.audioActivityDetector.resetPrompt();
    return true;
  }

  // Calendar reminders enter the same pipeline as mic detections, so they share
  // the recording gates, queueing, cooldowns, and the overlay window.
  handleCalendarReminder(event) {
    this._handleDetection("calendar", event.id, { event, detectedAt: Date.now() });
  }

  _suppress(reason, detectionId, source) {
    health.recordSuppression(reason, { detectionId, source });
    debugLogger.info("Detection suppressed", { reason, detectionId, source }, "meeting");
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;
    this._sweepStaleDetections();

    if (source === "audio" && !this.preferences.audioDetection) {
      this._suppress("audio-detection-disabled", detectionId, source);
      return;
    }

    if (!this._notificationsEnabledFor(source)) {
      this._suppress("notifications-disabled", detectionId, source);
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      this._suppress("already-active", detectionId, source);
      return;
    }

    if (this._meetingModeActive) {
      this._suppress("meeting-mode-active", detectionId, source);
      return;
    }

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      health.recordSuppression("queued-user-recording", { detectionId, source });
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, { source, key, data, dismissed: false, at: Date.now() });
      return;
    }

    debugLogger.info("Meeting detection triggered", { detectionId, source }, "meeting");
    this.activeDetections.set(detectionId, { source, key, data, dismissed: false, at: Date.now() });
    this._showPrompt(detectionId, source, key, data);
  }

  _notificationsEnabledFor(source) {
    const nPrefs = this.windowManager.notificationPrefs || {};
    if (nPrefs.notificationsEnabled === false) return false;
    const prefKey = source === "calendar" ? "notifyCalendarReminders" : "notifyMeetingDetection";
    return nPrefs[prefKey] !== false;
  }

  // activeMeeting only means the event's scheduled window is open — actual meeting
  // recordings are tracked by _meetingModeActive.
  _findCalendarEvent() {
    const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
    if (!calendarState) return null;
    if (calendarState.activeMeeting) return calendarState.activeMeeting;

    const now = Date.now();
    return (
      calendarState.upcomingEvents?.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      }) ?? null
    );
  }

  _showPrompt(detectionId, source, key, data) {
    const calendarEvent = data?.event ?? this._findCalendarEvent();
    const event = calendarEvent ?? placeholderEvent("__detected__");

    let variant = "detected";
    if (calendarEvent) {
      const started = new Date(calendarEvent.start_time).getTime() <= Date.now();
      variant = started ? "underway" : "starting";
    }
    const joinUrl = source === "calendar" ? getMeetingJoinUrl(calendarEvent) : null;

    debugLogger.info(
      "Showing notification",
      {
        detectionId,
        source,
        variant,
        title: calendarEvent?.summary ?? null,
        hasJoinUrl: !!joinUrl,
      },
      "meeting"
    );

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
      detection.event = event;
    }

    health.recordEvent("engine");
    this.windowManager.showMeetingNotification({
      detectionId,
      source,
      key,
      event,
      variant,
      joinUrl,
    });
  }

  async handleNotificationResponse(detectionId, action) {
    debugLogger.info("Notification response", { detectionId, action }, "meeting");
    try {
      const detection = this.activeDetections.get(detectionId);

      if ((action === "start" || action === "join") && detection) {
        if (action === "join") {
          const joinUrl = getMeetingJoinUrl(detection.event);
          if (joinUrl) {
            shell
              .openExternal(joinUrl)
              .catch((error) =>
                debugLogger.error(
                  "Failed to open meeting link",
                  { error: error.message, joinUrl },
                  "meeting"
                )
              );
          }
        }

        await this._beginMeetingSession(
          detection.event,
          action === "join" ? "calendar-join" : "notification-start"
        );
      } else if (action === "dismiss") {
        if (detection) {
          this._dismiss();
        }
      }
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error(
        "Error handling notification response",
        { error: error?.message, detectionId, action },
        "meeting"
      );
    } finally {
      // One overlay at a time — a response settles every pending detection,
      // including any the responded prompt replaced.
      this.activeDetections.clear();
      this.windowManager.dismissMeetingNotification();
    }
  }

  async startManualMeeting() {
    debugLogger.info("Starting manual meeting", {}, "meeting");

    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents?.length > 0) {
      return this.joinCalendarMeeting(activeEvents[0].id, "hotkey");
    }

    this._meetingModeActive = true;

    const event = placeholderEvent("__manual__");

    const noteResult = this.databaseManager.saveNote(event.summary, "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Manual meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    this.broadcastToWindows("note-added", noteResult.note);

    try {
      await this.windowManager.queueMeetingNoteNavigation({
        noteId: noteResult.note.id,
        folderId: meetingsFolder.id,
        event,
        trigger: "hotkey",
      });
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error("Manual meeting navigation failed", { error: error?.message }, "meeting");
    }
  }

  async joinCalendarMeeting(eventId, trigger = "calendar-join") {
    this._meetingModeActive = true;
    debugLogger.info("Joining calendar meeting", { eventId, trigger }, "meeting");

    const calEvent = this.databaseManager.getCalendarEventById(eventId);
    if (!calEvent) {
      debugLogger.error("Calendar event not found", { eventId }, "meeting");
      this._meetingModeActive = false;
      return;
    }

    const noteResult = this.databaseManager.saveNote(calEvent.summary || "New note", "", "meeting");
    const meetingsFolder = this.databaseManager.getMeetingsFolder();

    if (!noteResult?.note?.id || !meetingsFolder?.id) {
      debugLogger.error(
        "Join calendar meeting failed — missing note or folder",
        { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
        "meeting"
      );
      this._meetingModeActive = false;
      return;
    }

    const updates = { calendar_event_id: calEvent.id };
    if (calEvent.attendees) {
      updates.participants = calEvent.attendees;
    }
    const meetingTypeId = this.databaseManager.autoMapMeetingType(calEvent.summary);
    if (meetingTypeId) {
      updates.meeting_type_id = meetingTypeId;
    }
    const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);

    this.broadcastToWindows("note-added", updateResult?.note || noteResult.note);

    try {
      await this.windowManager.queueMeetingNoteNavigation({
        noteId: noteResult.note.id,
        folderId: meetingsFolder.id,
        event: calEvent,
        trigger,
      });
    } catch (error) {
      this._meetingModeActive = false;
      debugLogger.error("Calendar join navigation failed", { error: error?.message }, "meeting");
    }
  }

  handleNotificationTimeout() {
    for (const [detectionId, detection] of this.activeDetections) {
      if (!detection.dismissed) {
        this._dismiss();
        detection.dismissed = true;
      }
    }
    this.activeDetections.clear();
    debugLogger.info("Notification auto-dismissed, detections cleared", {}, "meeting");
  }

  _flushNotificationQueue() {
    if (this._notificationQueue.length === 0) return;

    if (this._meetingModeActive) {
      debugLogger.info("Dropping queued notifications — meeting mode active", {}, "meeting");
      for (const { source, key } of this._notificationQueue) {
        this.activeDetections.delete(`${source}:${key}`);
      }
      this._notificationQueue = [];
      return;
    }

    debugLogger.info(
      "Flushing notification queue",
      { count: this._notificationQueue.length },
      "meeting"
    );

    const best = this._notificationQueue[0];
    const detectionId = `${best.source}:${best.key}`;

    // Only one overlay is shown; the rest are dropped here, so their reservations
    // have to go with them or they block their ids until the next sweep.
    for (const { source, key } of this._notificationQueue.slice(1)) {
      this.activeDetections.delete(`${source}:${key}`);
    }

    const detection = this.activeDetections.get(detectionId);
    if (detection && !detection.dismissed) {
      this._showPrompt(detectionId, best.source, best.key, best.data);
    }

    this._notificationQueue = [];
  }

  _dismiss() {
    this.audioActivityDetector.dismiss();
  }

  setMeetingModeActive(active) {
    this._meetingModeActive = active;
    debugLogger.info("Meeting mode active state changed", { active }, "meeting");
    if (!active) {
      // Own mic usage during meeting mode sets hasPrompted=true; reset so future detections work
      this.audioActivityDetector.resetPrompt();
    }
  }

  // The meeting session ends when its recording stops, not when the renderer
  // happens to navigate away — "Back to notes" isn't rendered in every layout, so
  // relying on it left the suppression latch set for the rest of the process.
  endMeetingSession(reason = "recording-stopped") {
    debugLogger.info("Meeting session ended", { reason }, "meeting");
    this.setMeetingModeActive(false);
    this.setUserRecording(false);
  }

  setUserRecording(active) {
    this._userRecording = active;
    this.audioActivityDetector.setUserRecording(active);

    if (active) {
      this._clearMeetingModeWatchdog();
      if (this._postRecordingCooldown) {
        clearTimeout(this._postRecordingCooldown);
        this._postRecordingCooldown = null;
      }
    } else {
      if (this.__meetingModeActive) this._armMeetingModeWatchdog();
      // Recording stopped (manually or auto): stop treating the mic as ours and
      // clear the auto-start bookkeeping.
      this.callStateDetector?.setSelfRecording(false);
      this._autoStarted = false;
      this._clearAutoStopSafety();
      this._postRecordingCooldown = setTimeout(() => {
        this._postRecordingCooldown = null;
        this._flushNotificationQueue();
      }, 2500);
    }
  }

  setPreferences(prefs) {
    debugLogger.info("Updating detection preferences", prefs, "meeting");
    Object.assign(this.preferences, prefs);

    if (this.preferences.processDetection) {
      this.meetingProcessDetector.start();
    } else {
      this.meetingProcessDetector.stop();
    }

    if (this.preferences.audioDetection) {
      this.audioActivityDetector.start();
    } else {
      this.audioActivityDetector.stop();
    }

    if (this.callStateDetector) {
      if (this.preferences.autoStartRecording) this.callStateDetector.start();
      else this.callStateDetector.stop();
    }
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) this.audioActivityDetector.start();
    if (this.preferences.autoStartRecording) this.callStateDetector?.start();
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.callStateDetector?.stop();
    this._autoStarted = false;
    this._clearAutoStopSafety();
    this._clearMeetingModeWatchdog();
    this.activeDetections.clear();
    this._meetingModeActive = false;
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
    this._notificationQueue = [];
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }
}

module.exports = MeetingDetectionEngine;
