const debugLogger = require("./debugLogger");
const { openExternalUrl } = require("./externalUrlOpener");
const { getMeetingJoinUrl } = require("./meetingJoinUrl");
const createMeetingAutoEndController = require("./meetingAutoEndController");
const { createMeetingAudioActivityMonitor } = require("./meetingAudioActivityMonitor");
const { broadcastToWindows } = require("./windowBroadcast");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;
const AUTO_END_TICK_MS = 1000;
const AUTO_END_RESTART_WINDOW_MS = 30_000;
// Clicking Restart is the user saying the meeting is still live. Honour that for
// a while, or the same silence that just ended the recording ends it again a
// minute later and they have to keep clicking.
const AUTO_END_RESTART_GRACE_MS = 5 * 60_000;
// The grace belongs to the recording the user restarted, which starts within a
// second or two. Main cannot see a restart the renderer drops (its context died
// with a reload, or a manual recording won the race), so an unclaimed grace has
// to lapse rather than wait to be taken by whatever recording starts next.
const AUTO_END_RESTART_CLAIM_MS = 30_000;

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
    reminderScheduler,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager,
    {
      createAutoEndController = createMeetingAutoEndController,
      createAudioActivityMonitor = createMeetingAudioActivityMonitor,
      now = Date.now,
      setInterval = global.setInterval,
      clearInterval = global.clearInterval,
    } = {}
  ) {
    this.reminderScheduler = reminderScheduler;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true };
    this._userRecording = false;
    this._meetingModeActive = false;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._recordingSession = null;
    this._pendingAutoEnd = null;
    this._autoEndRestartGrace = null;
    this._now = now;
    this._setInterval = setInterval;
    this._clearInterval = clearInterval;
    // True only between controller.beginSession and endSession — meeting audio
    // starts streaming before the session is registered, and chunks fed to the
    // monitor before the controller exists would leave the two out of sync.
    this._autoEndActive = false;
    this._autoEndTicker = null;
    this._audioActivityMonitor = createAudioActivityMonitor({
      onActivityChanged: (state) => {
        const session = this._recordingSession;
        if (!this._autoEndActive || !session) return;
        this._autoEndController.handleAudioActivity({ sessionId: session.sessionId, ...state });
      },
    });
    this._autoEndController = createAutoEndController({
      now,
      onStop: (sessionId, reason) => this._requestRecordingStop(sessionId, reason),
    });
    this._bindListeners();
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

      // The detector removes the ended key before emitting, so an empty list
      // means the last tracked meeting app is gone.
      const session = this._recordingSession;
      if (!this._autoEndActive || !session) return;
      const remaining = this.meetingProcessDetector.getDetectedProcesses?.() ?? [];
      if (remaining.length > 0) return;
      debugLogger.info(
        "Last tracked meeting app exited during recording",
        { sessionId: session.sessionId, processKey: data.processKey },
        "meeting"
      );
      this._autoEndController.handleMeetingProcessExit({ sessionId: session.sessionId });
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection("audio", "sustained-audio", data);
    });

    this.audioActivityDetector.on("external-mic-state-changed", (state) => {
      const session = this._recordingSession;
      if (!this._autoEndActive || !session) return;

      debugLogger.debug(
        "External mic state for auto-end",
        { sessionId: session.sessionId, ...state },
        "meeting"
      );
      this._autoEndController.handleExternalMicState({
        sessionId: session.sessionId,
        reliable: state.reliable,
        externalMicActive: state.externalMicActive,
      });
    });
  }

  _requestRecordingStop(sessionId, reason) {
    const session = this._recordingSession;
    if (!session || session.sessionId !== sessionId) return;

    debugLogger.info(
      "Meeting end detected, requesting automatic stop",
      { sessionId, reason },
      "meeting"
    );
    const ownerWebContents = session.ownerWebContents;
    if (!ownerWebContents || ownerWebContents.isDestroyed?.()) return;
    this._clearAutoEndRecovery();
    this._pendingAutoEnd = {
      sessionId,
      reason,
      ownerWebContents,
      expiresAt: null,
    };
    try {
      ownerWebContents.send("meeting-auto-end-requested", { sessionId, reason });
    } catch (error) {
      this._pendingAutoEnd = null;
      debugLogger.error(
        "Failed to request meeting auto-end from recording renderer",
        { error: error?.message, sessionId },
        "meeting"
      );
    }
  }

  // Time-bounded on purpose: the window manager destroys a notification window
  // on paths that cannot notify us (_hideNormalAppSurfaces, a late detection
  // response landing on a replaced card), and this gate holds every meeting
  // prompt. Without the deadline one of those silently kills detection for the
  // rest of the app session.
  _hasLiveAutoEndOffer() {
    const expiresAt = this._pendingAutoEnd?.expiresAt;
    return expiresAt != null && this._now() < expiresAt;
  }

  _clearAutoEndRecovery({ dismiss = true } = {}) {
    const pending = this._pendingAutoEnd;
    this._pendingAutoEnd = null;
    if (dismiss && pending?.expiresAt != null) {
      this.windowManager.dismissMeetingAutoEndNotification?.(pending.sessionId);
    }
  }

  async completeAutoEndSession(sessionId, ownerWebContents) {
    const pending = this._pendingAutoEnd;
    if (
      !pending ||
      pending.sessionId !== sessionId ||
      pending.ownerWebContents !== ownerWebContents ||
      pending.expiresAt !== null ||
      this._recordingSession !== null ||
      ownerWebContents?.isDestroyed?.()
    ) {
      return false;
    }

    const expiresAt = this._now() + AUTO_END_RESTART_WINDOW_MS;
    pending.expiresAt = expiresAt;
    try {
      const shown = await this.windowManager.showMeetingAutoEndNotification?.({
        sessionId,
        reason: pending.reason,
        expiresAt,
      });
      if (this._pendingAutoEnd !== pending) return false;
      // Only an explicit success offers the restart: anything else (a missing
      // window manager method, a load aborted by a replacement) means the card
      // the user would click never appeared.
      if (shown !== true) {
        this._clearAutoEndRecovery({ dismiss: false });
        return false;
      }
      debugLogger.info(
        "Meeting recording auto-ended; restart window shown",
        { sessionId, reason: pending.reason, expiresAt },
        "meeting"
      );
      return true;
    } catch (error) {
      if (this._pendingAutoEnd === pending) {
        this._clearAutoEndRecovery({ dismiss: false });
      }
      debugLogger.error(
        "Failed to show meeting auto-end recovery notification",
        { error: error?.message, sessionId },
        "meeting"
      );
      return false;
    }
  }

  respondToAutoEndNotification(sessionId, action, responderWebContents) {
    if (
      (action !== "restart" && action !== "dismiss") ||
      !this.windowManager.isMeetingNotificationSender?.(responderWebContents)
    ) {
      return false;
    }

    const pending = this._pendingAutoEnd;
    if (!pending || pending.sessionId !== sessionId || pending.expiresAt === null) return false;
    if (this._now() >= pending.expiresAt || this._recordingSession !== null) {
      this._clearAutoEndRecovery();
      this._flushNotificationQueue();
      return false;
    }

    const ownerWebContents = pending.ownerWebContents;
    this._clearAutoEndRecovery();
    if (action === "dismiss") {
      this._flushNotificationQueue();
      return true;
    }

    // A delivered restart deliberately does not flush: the user chose the old
    // meeting, and the recording about to start gates the queue again anyway.
    // One that cannot be delivered starts nothing, so the detections held
    // behind the offer have to go out.
    if (!ownerWebContents || ownerWebContents.isDestroyed?.()) {
      this._flushNotificationQueue();
      return false;
    }

    try {
      ownerWebContents.send("meeting-auto-end-restart-requested", { sessionId });
      const nowMs = this._now();
      this._autoEndRestartGrace = {
        suppressUntil: nowMs + AUTO_END_RESTART_GRACE_MS,
        claimUntil: nowMs + AUTO_END_RESTART_CLAIM_MS,
      };
      return true;
    } catch (error) {
      debugLogger.error(
        "Failed to request meeting recording restart",
        { error: error?.message, sessionId },
        "meeting"
      );
      this._flushNotificationQueue();
      return false;
    }
  }

  // `flushQueued` is false when a replacement notification is already being
  // shown: flushing there would re-enter showMeetingNotification.
  handleAutoEndNotificationClosed(sessionId, { flushQueued = true } = {}) {
    if (this._pendingAutoEnd?.sessionId !== sessionId) return false;
    this._clearAutoEndRecovery({ dismiss: false });
    if (flushQueued) this._flushNotificationQueue();
    return true;
  }

  // Hot path — called for every meeting PCM chunk of both channels.
  recordMeetingAudioChunk(source, buffer) {
    if (!this._autoEndActive) return;
    this._audioActivityMonitor.recordChunk(source, buffer);
  }

  _isAutoEndWanted() {
    return (
      this._recordingSession?.autoEndEligible === true &&
      this._recordingSession.systemAudioAvailable === true
    );
  }

  _syncAudioActivityDetector() {
    if (this.preferences.audioDetection || this._isAutoEndWanted()) {
      return this.audioActivityDetector.start();
    }

    this.audioActivityDetector.stop();
    return undefined;
  }

  // The process-exit fast path needs the detector even when the user has turned
  // process detection off for meeting prompts.
  _syncMeetingProcessDetector() {
    if (this.preferences.processDetection || this._isAutoEndWanted()) {
      this.meetingProcessDetector.start();
      return;
    }
    this.meetingProcessDetector.stop();
  }

  _startAutoEndTicker() {
    if (this._autoEndTicker) return;
    this._autoEndTicker = this._setInterval(() => {
      // Monitor first so a fresh activity change reaches the controller before
      // it evaluates its windows for this second.
      this._audioActivityMonitor.tick(this._now());
      this._autoEndController.tick();
    }, AUTO_END_TICK_MS);
    this._autoEndTicker?.unref?.();
  }

  _stopAutoEndTicker() {
    if (!this._autoEndTicker) return;
    this._clearInterval(this._autoEndTicker);
    this._autoEndTicker = null;
  }

  // Ends the controller session for the tracked recording (if any) and stops
  // feeding it audio. Safe to call when nothing is active.
  _deactivateAutoEnd() {
    const session = this._recordingSession;
    this._autoEndActive = false;
    this._stopAutoEndTicker();
    this._audioActivityMonitor.reset();
    if (session) this._autoEndController.endSession(session.sessionId);
  }

  async _activateAutoEnd(sessionId) {
    await this._syncAudioActivityDetector();
    if (this._recordingSession?.sessionId !== sessionId || !this._isAutoEndWanted()) return;

    const externalMicState = this.audioActivityDetector.getExternalMicState();
    debugLogger.info(
      "Auto-end armed for recording session",
      { sessionId, ...externalMicState },
      "meeting"
    );
    this._audioActivityMonitor.reset();
    const grace = this._autoEndRestartGrace;
    this._autoEndRestartGrace = null;
    const suppressUntil = grace && this._now() < grace.claimUntil ? grace.suppressUntil : 0;
    this._autoEndController.beginSession({
      sessionId,
      eligible: true,
      reliable: externalMicState.reliable,
      externalMicActive: externalMicState.externalMicActive,
      suppressUntil,
      ...this._audioActivityMonitor.getState(),
    });
    this._autoEndActive = true;
    this._startAutoEndTicker();
  }

  async beginRecordingSession({
    sessionId,
    autoEndEligible,
    ownerWebContents,
    systemAudioAvailable = false,
  }) {
    this._clearAutoEndRecovery();
    if (this._recordingSession) this._deactivateAutoEnd();

    this._recordingSession = {
      sessionId,
      autoEndEligible: autoEndEligible === true,
      ownerWebContents,
      systemAudioAvailable: systemAudioAvailable === true,
    };
    this._syncMeetingProcessDetector();

    if (!this._isAutoEndWanted()) {
      this._syncAudioActivityDetector();
      return;
    }

    await this._activateAutoEnd(sessionId);
  }

  async setRecordingSystemAudioAvailable(sessionId, available, ownerWebContents) {
    const session = this._recordingSession;
    if (
      !session ||
      session.sessionId !== sessionId ||
      (ownerWebContents && session.ownerWebContents !== ownerWebContents)
    ) {
      return false;
    }

    const autoEndWasWanted = this._isAutoEndWanted();
    session.systemAudioAvailable = available === true;
    const autoEndWanted = this._isAutoEndWanted();

    if (autoEndWasWanted && !autoEndWanted) {
      this._deactivateAutoEnd();
    } else if (!autoEndWasWanted && autoEndWanted) {
      await this._activateAutoEnd(sessionId);
    }

    this._syncMeetingProcessDetector();
    this._syncAudioActivityDetector();
    return true;
  }

  // Returns false only when a *different* session is currently live — the one
  // case where the caller must not tear down shared capture. With no tracked
  // session (e.g. after engine stop at quit) teardown must still proceed.
  endRecordingSession(expectedSessionId) {
    const session = this._recordingSession;
    if (!session) return true;
    if (expectedSessionId != null && session.sessionId !== expectedSessionId) {
      debugLogger.info(
        "Recording session end skipped — another session is live",
        { expectedSessionId, activeSessionId: session.sessionId },
        "meeting"
      );
      return false;
    }

    this._deactivateAutoEnd();
    debugLogger.info(
      "Recording session ended",
      { sessionId: session.sessionId, autoEndEligible: session.autoEndEligible },
      "meeting"
    );
    this._recordingSession = null;
    // Meeting mode was entered when the note was created; the recording it led
    // to is over, so the next call (or the next meeting's reminder) must prompt
    // again. Only the narrow layout's "Back to notes" button cleared it before,
    // which in the wide layout meant no prompts for the rest of the app session.
    if (this._meetingModeActive) this.setMeetingModeActive(false);
    this._syncAudioActivityDetector();
    this._syncMeetingProcessDetector();
    return true;
  }

  // Calendar reminders enter the same pipeline as mic detections, so they share
  // the recording gates, queueing, cooldowns, and the overlay window.
  handleCalendarReminder(event) {
    this._handleDetection("calendar", event.id, { event, detectedAt: Date.now() });
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;

    if (source === "audio" && !this.preferences.audioDetection) {
      debugLogger.debug("Audio detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }

    if (!this._notificationsEnabledFor(source)) {
      debugLogger.info(
        "Notification disabled by preference, ignoring",
        { detectionId, source },
        "meeting"
      );
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      debugLogger.debug("Detection already active, skipping", { detectionId }, "meeting");
      return;
    }

    if (this._meetingModeActive) {
      debugLogger.info(
        "Suppressing detection — meeting mode already active",
        { detectionId },
        "meeting"
      );
      return;
    }

    // _userRecording is shared with dictation, so a dictation ending mid-meeting
    // clears it while the recording is still live; the tracked session is the
    // gate that cannot be reset from outside. A prompt shown then could replace
    // the recording UI while the tracked recording is still active.
    if (
      this._userRecording ||
      this._postRecordingCooldown ||
      this._recordingSession ||
      this._hasLiveAutoEndOffer()
    ) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, { source, key, data });
      return;
    }

    debugLogger.info("Meeting detection triggered", { detectionId, source }, "meeting");
    this.activeDetections.set(detectionId, { source, key, data });
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
    const calendarState = this.reminderScheduler.getActiveMeetingState();
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

    this.windowManager.showMeetingNotification({
      kind: "detection",
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
            openExternalUrl(joinUrl).catch((error) =>
              debugLogger.error(
                "Failed to open meeting link",
                { error: error.message, joinUrl },
                "meeting"
              )
            );
          }
        }

        const eventSummary = detection.event?.summary || "New note";

        const isRealEvent =
          detection.event?.calendar_id &&
          detection.event.calendar_id !== "__detected__" &&
          detection.event.calendar_id !== "__manual__";

        if (
          isRealEvent &&
          (await this._resumeExistingEventNote(detection.event, "calendar-join"))
        ) {
          this._meetingModeActive = true;
          this.audioActivityDetector.resetPrompt();
          return;
        }

        const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting");
        const meetingsFolder = this.databaseManager.getMeetingsFolder();

        if (!noteResult?.note?.id || !meetingsFolder?.id) {
          debugLogger.error(
            "Meeting note creation failed",
            { noteId: noteResult?.note?.id, folderId: meetingsFolder?.id },
            "meeting"
          );
          return;
        }

        this._meetingModeActive = true;

        broadcastToWindows("note-added", noteResult.note);

        if (isRealEvent) {
          const calEvent = this.databaseManager.getCalendarEventById(detection.event.id);
          const updates = { calendar_event_id: detection.event.id };
          if (calEvent?.attendees) {
            updates.participants = calEvent.attendees;
          }
          const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);
          if (updateResult?.success && updateResult?.note) {
            broadcastToWindows("note-updated", updateResult.note);
          }
        }

        await this.windowManager.queueMeetingNoteNavigation({
          noteId: noteResult.note.id,
          folderId: meetingsFolder.id,
          event: detection.event,
          trigger: "calendar-join",
        });

        this.audioActivityDetector.resetPrompt();
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

    broadcastToWindows("note-added", noteResult.note);

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event,
      trigger: "hotkey",
    });
  }

  /** Navigates to the note already linked to a calendar event, if any. */
  async _resumeExistingEventNote(event, trigger) {
    const existingNote = this.databaseManager.getNoteByCalendarEventId(event.id);
    if (!existingNote?.id) return false;
    debugLogger.info(
      "Reusing existing note for calendar meeting",
      { eventId: event.id, noteId: existingNote.id, trigger },
      "meeting"
    );
    await this.windowManager.queueMeetingNoteNavigation({
      noteId: existingNote.id,
      folderId: existingNote.folder_id ?? this.databaseManager.getMeetingsFolder()?.id,
      event,
      trigger,
    });
    return true;
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

    // Joining the same event twice resumes its note instead of creating a duplicate.
    if (await this._resumeExistingEventNote(calEvent, trigger)) {
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
    const updateResult = this.databaseManager.updateNote(noteResult.note.id, updates);

    broadcastToWindows("note-added", updateResult?.note || noteResult.note);

    await this.windowManager.queueMeetingNoteNavigation({
      noteId: noteResult.note.id,
      folderId: meetingsFolder.id,
      event: calEvent,
      trigger,
    });
  }

  // A card can vanish without a response — a compositor kill, a load failure,
  // onboarding taking the screen. Only this detection is released, unlike a
  // response or an expiry which settle every pending one: clearing them all
  // would strand _notificationQueue, whose entries the flush below looks up in
  // activeDetections.
  handleDetectionNotificationClosed(detectionId, { flushQueued = true } = {}) {
    if (!this.activeDetections.has(detectionId)) return;
    this.activeDetections.delete(detectionId);
    debugLogger.info(
      "Detection notification closed without a response",
      { detectionId },
      "meeting"
    );
    if (flushQueued) this._flushNotificationQueue();
  }

  handleNotificationTimeout(notification = null) {
    if (notification?.kind === "auto-end") {
      this.handleAutoEndNotificationClosed(notification.sessionId);
      return;
    }

    // Expiring unanswered is not a decline, so no dismissal cooldown starts:
    // the detector's hasPrompted flag already keeps the ongoing call from
    // re-prompting, while a call starting right after the timeout still
    // prompts. Only an explicit dismissal (handleNotificationResponse) cools
    // the mic detector down.
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

    // A dictation's post-recording cooldown can flush while a meeting recording
    // is still live; hold the queue for the flush that follows the recording.
    if (this._recordingSession) {
      debugLogger.info("Holding queued notifications — recording session live", {}, "meeting");
      return;
    }

    // The post-recording cooldown fires 2.5s after an auto-end stop, while the
    // restart card still has most of its window left. Showing a prompt here
    // would replace that card and silently void the restart offer.
    if (this._hasLiveAutoEndOffer()) {
      debugLogger.info("Holding queued notifications — restart offer live", {}, "meeting");
      return;
    }

    debugLogger.info(
      "Flushing notification queue",
      { count: this._notificationQueue.length },
      "meeting"
    );

    const best = this._notificationQueue[0];
    const detectionId = `${best.source}:${best.key}`;

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
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

  setUserRecording(active) {
    this._userRecording = active;
    this.audioActivityDetector.setUserRecording(active);

    if (active) {
      if (this._postRecordingCooldown) {
        clearTimeout(this._postRecordingCooldown);
        this._postRecordingCooldown = null;
      }
    } else {
      this._postRecordingCooldown = setTimeout(() => {
        this._postRecordingCooldown = null;
        this._flushNotificationQueue();
      }, 2500);
    }
  }

  // Forward-only: unlike setUserRecording there is no cooldown or queue flush —
  // that machinery exists for real recordings, while a warm-hold merely means
  // our own renderer still has the device open.
  setMicWarmHold(active) {
    this.audioActivityDetector.setMicWarmHold(active);
  }

  setPreferences(prefs) {
    debugLogger.info("Updating detection preferences", prefs, "meeting");
    if (typeof prefs?.processDetection === "boolean") {
      this.preferences.processDetection = prefs.processDetection;
    }
    if (typeof prefs?.audioDetection === "boolean") {
      this.preferences.audioDetection = prefs.audioDetection;
    }

    this._syncMeetingProcessDetector();
    this._syncAudioActivityDetector();
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    this._syncMeetingProcessDetector();
    this._syncAudioActivityDetector();
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this._clearAutoEndRecovery();
    this._autoEndRestartGrace = null;
    this._deactivateAutoEnd();
    this._recordingSession = null;
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.activeDetections.clear();
    this._meetingModeActive = false;
    if (this._postRecordingCooldown) {
      clearTimeout(this._postRecordingCooldown);
      this._postRecordingCooldown = null;
    }
    this._notificationQueue = [];
  }
}

module.exports = MeetingDetectionEngine;
module.exports.AUTO_END_RESTART_WINDOW_MS = AUTO_END_RESTART_WINDOW_MS;
module.exports.AUTO_END_RESTART_GRACE_MS = AUTO_END_RESTART_GRACE_MS;
module.exports.AUTO_END_RESTART_CLAIM_MS = AUTO_END_RESTART_CLAIM_MS;
