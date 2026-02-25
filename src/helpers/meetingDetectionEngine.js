const { Notification, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");

const IMMINENT_THRESHOLD_MS = 5 * 60 * 1000;

class MeetingDetectionEngine {
  constructor(googleCalendarManager, meetingProcessDetector, audioActivityDetector) {
    this.googleCalendarManager = googleCalendarManager;
    this.meetingProcessDetector = meetingProcessDetector;
    this.audioActivityDetector = audioActivityDetector;
    this.activeDetections = new Map();
    this.preferences = { processDetection: true, audioDetection: true };
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
    if (source === "process" && !this.preferences.processDetection) return;
    if (source === "audio" && !this.preferences.audioDetection) return;

    const detectionId = `${source}:${key}`;

    if (this.activeDetections.has(detectionId)) return;

    const calendarState = this.googleCalendarManager?.getActiveMeetingState?.();
    if (calendarState) {
      if (calendarState.activeMeeting !== null || calendarState.activeEvents?.length > 0) {
        debugLogger.debug(
          "Suppressing detection — active calendar meeting exists",
          { detectionId },
          "meeting"
        );
        return;
      }
    }

    let imminentEvent = null;
    if (calendarState?.upcomingEvents?.length > 0) {
      const now = Date.now();
      imminentEvent = calendarState.upcomingEvents.find((evt) => {
        const start = new Date(evt.start_time).getTime();
        return start - now <= IMMINENT_THRESHOLD_MS && start > now;
      });
    }

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

    const notif = new Notification({ title, body });

    notif.on("click", () => {
      let event;
      if (imminentEvent) {
        event = imminentEvent;
      } else {
        event = {
          id: `detected-${Date.now()}`,
          calendar_id: "__detected__",
          summary: data.appName ? `${data.appName} Meeting` : "Detected Meeting",
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

      this.broadcastToWindows("meeting-detected-start-recording", {
        event,
        source,
        detectionId,
      });
    });

    notif.on("close", () => {
      this._dismiss(source, key);
      const detection = this.activeDetections.get(detectionId);
      if (detection) detection.dismissed = true;
    });

    notif.show();

    this.broadcastToWindows("meeting-detected", {
      detectionId,
      source,
      data,
      imminentEvent,
    });
  }

  handleUserResponse(detectionId, action) {
    if (action === "dismiss") {
      const detection = this.activeDetections.get(detectionId);
      if (detection) {
        this._dismiss(detection.source, detection.key);
        detection.dismissed = true;
      }
    }
  }

  _dismiss(source, key) {
    if (source === "process") {
      this.meetingProcessDetector.dismiss(key);
    } else if (source === "audio") {
      this.audioActivityDetector.dismiss();
    }
  }

  setPreferences(prefs) {
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
    if (this.preferences.processDetection) this.meetingProcessDetector.start();
    if (this.preferences.audioDetection) this.audioActivityDetector.start();
  }

  stop() {
    this.meetingProcessDetector.stop();
    this.audioActivityDetector.stop();
    this.activeDetections.clear();
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
