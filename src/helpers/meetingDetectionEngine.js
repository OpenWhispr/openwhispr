const { BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;

class MeetingDetectionEngine {
  constructor(
    googleCalendarManager,
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    databaseManager
  ) {
    this.googleCalendarManager = googleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.windowManager = windowManager;
    this.databaseManager = databaseManager;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true };
    this._userRecording = false;
    this._notificationQueue = [];
    this._postRecordingCooldown = null;
    this._bindListeners();
  }

  _bindListeners() {
    this.meetingProcessDetector.on("meeting-process-detected", (data) => {
      this._handleDetection("process", data.processKey, data);
    });

    this.meetingProcessDetector.on("meeting-process-ended", (data) => {
      this.activeDetections.delete(`process:${data.processKey}`);
    });

    this.audioActivityDetector.on("sustained-audio-detected", (data) => {
      this._handleDetection("audio", "sustained-audio", data);
    });
  }

  _handleDetection(source, key, data) {
    const detectionId = `${source}:${key}`;

    if (source === "process" && !this.preferences.processDetection) {
      debugLogger.debug("Process detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }
    if (source === "audio" && !this.preferences.audioDetection) {
      debugLogger.debug("Audio detection disabled, ignoring", { detectionId }, "meeting");
      return;
    }

    if (this.activeDetections.has(detectionId)) {
      debugLogger.debug("Detection already active, skipping", { detectionId }, "meeting");
      return;
    }

    const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
    if (calendarState) {
      if (calendarState.activeMeeting) {
        debugLogger.info(
          "Suppressing detection — active calendar meeting recording in progress",
          { detectionId, activeMeeting: calendarState.activeMeeting?.summary },
          "meeting"
        );
        return;
      }
    }

    if (this._userRecording || this._postRecordingCooldown) {
      debugLogger.info("Detection queued — user is recording", { detectionId, source }, "meeting");
      this._notificationQueue.push({ source, key, data });
      this.activeDetections.set(detectionId, { source, key, data, dismissed: false });
      return;
    }

    let imminentEvent = null;
    if (calendarState?.upcomingEvents?.length > 0) {
      const now = Date.now();
      imminentEvent = calendarState.upcomingEvents.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      });
    }

    debugLogger.info(
      "Meeting detection triggered",
      { detectionId, source, imminentEvent: imminentEvent?.summary ?? null },
      "meeting"
    );
    this.activeDetections.set(detectionId, { source, key, data, dismissed: false });
    this._showPrompt(detectionId, source, key, data, imminentEvent);
  }

  _showPrompt(detectionId, source, key, data, imminentEvent) {
    let title, body;

    if (imminentEvent) {
      title = imminentEvent.summary || "Upcoming Meeting";
      body = "Your meeting is starting. Want to take notes?";
    } else if (source === "process") {
      title = `${data.appName} Meeting Detected`;
      body = "It looks like you're in a meeting. Want to take notes?";
    } else {
      title = "Meeting Detected";
      body = "It sounds like you're in a meeting. Want to take notes?";
    }

    debugLogger.info("Showing notification", { detectionId, title }, "meeting");

    let event;
    if (imminentEvent) {
      event = imminentEvent;
    } else {
      event = {
        id: `detected-${Date.now()}`,
        calendar_id: "__detected__",
        summary: data.appName ? `${data.appName} Meeting` : "New note",
        start_time: new Date().toISOString(),
        end_time: new Date(Date.now() + 3600000).toISOString(),
        is_all_day: 0,
        status: "confirmed",
        hangout_link: null,
        conference_data: null,
        organizer_email: null,
        attendees_count: 0,
      };
    }

    const detection = this.activeDetections.get(detectionId);
    if (detection) {
      detection.event = event;
    }

    this.windowManager.showMeetingNotification({
      detectionId,
      source,
      key,
      title,
      body,
      event,
    });

    this.broadcastToWindows("meeting-detected", {
      detectionId,
      source,
      data,
      imminentEvent,
    });
  }

  handleUserResponse(detectionId, action) {
    debugLogger.info("User response to detection", { detectionId, action }, "meeting");
    if (action === "dismiss") {
      const detection = this.activeDetections.get(detectionId);
      if (detection) {
        this._dismiss(detection.source, detection.key);
        detection.dismissed = true;
      }
    }
  }

  async handleNotificationResponse(detectionId, action) {
    debugLogger.info("Notification response", { detectionId, action }, "meeting");
    try {
      const detection = this.activeDetections.get(detectionId);

      if (action === "start" && detection) {
        const eventSummary = detection.event?.summary || "New note";

        const noteResult = this.databaseManager.saveNote(eventSummary, "", "meeting");
        const meetingsFolder = this.databaseManager.getMeetingsFolder();

        if (noteResult?.note?.id && meetingsFolder?.id) {
          await this.windowManager.createControlPanelWindow();
          this.windowManager.snapControlPanelToMeetingMode();
          this.windowManager.sendToControlPanel("navigate-to-meeting-note", {
            noteId: noteResult.note.id,
            folderId: meetingsFolder.id,
            event: detection.event,
          });
        }

        this.activeDetections.delete(detectionId);
      } else if (action === "dismiss") {
        if (detection) {
          this._dismiss(detection.source, detection.key);
          detection.dismissed = true;
        }
      }
    } finally {
      this.windowManager.dismissMeetingNotification();
    }
  }

  _flushNotificationQueue() {
    if (this._notificationQueue.length === 0) return;

    debugLogger.info("Flushing notification queue", { count: this._notificationQueue.length }, "meeting");

    const prioritized = this._notificationQueue.sort((a, b) => {
      const priority = { process: 1, audio: 2 };
      return (priority[a.source] || 0) - (priority[b.source] || 0);
    });

    const best = prioritized[0];
    const detectionId = `${best.source}:${best.key}`;

    const detection = this.activeDetections.get(detectionId);
    if (detection && !detection.dismissed) {
      const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
      let imminentEvent = null;
      if (calendarState?.upcomingEvents?.length > 0) {
        const now = Date.now();
        imminentEvent = calendarState.upcomingEvents.find((evt) => {
          const start = new Date(evt.start_time).getTime();
          return start - now <= 5 * 60 * 1000 && start > now;
        });
      }

      if (imminentEvent) {
        this._showPrompt(detectionId, best.source, best.key, best.data, imminentEvent);
      } else {
        this._showPrompt(detectionId, best.source, best.key, best.data, null);
      }
    }

    this._notificationQueue = [];
  }

  _dismiss(source, key) {
    if (source === "process") {
      this.meetingProcessDetector.dismiss(key);
    } else if (source === "audio") {
      this.audioActivityDetector.dismiss();
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
  }

  getPreferences() {
    return { ...this.preferences };
  }

  start() {
    debugLogger.info("Meeting detection engine started", this.preferences, "meeting");
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) this.audioActivityDetector.start();
  }

  stop() {
    debugLogger.info("Meeting detection engine stopped", {}, "meeting");
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.activeDetections.clear();
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
