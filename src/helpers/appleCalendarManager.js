const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");
const { extractMeetingUrl } = require("./meetingJoinUrl");

const BINARY_NAME = "macos-calendar-listener";
const FOCUS_SYNC_THROTTLE_MS = 30 * 1000;

// Reads the local EventKit store (all accounts Calendar.app aggregates) via a
// bundled Swift helper that pushes calendars+events snapshots as line-delimited
// JSON. "Connected" means apple_calendars has rows — no tokens or settings.
class AppleCalendarManager {
  constructor(databaseManager, windowManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.reminderScheduler = reminderScheduler;
    this._helperProcess = null;
    this._pendingConnect = null;
    this._lastFocusSync = 0;
  }

  isConnected() {
    return this.databaseManager.getAppleCalendars().length > 0;
  }

  getConnectionStatus() {
    const calendars = this.databaseManager.getAppleCalendars();
    return {
      connected: calendars.length > 0,
      sourceNames: [...new Set(calendars.map((cal) => cal.source_name).filter(Boolean))],
    };
  }

  start() {
    if (process.platform !== "darwin" || !this.isConnected()) return;
    this._spawnHelper(false);
  }

  // User-initiated: spawns the helper with --request so the TCC prompt shows.
  // Resolves after the first snapshot lands (success) or access is denied.
  connect() {
    if (process.platform !== "darwin") {
      return Promise.resolve({ success: false, reason: "unsupported" });
    }
    return new Promise((resolve) => {
      this._pendingConnect = { resolve, awaitingSnapshot: false };
      if (!this._spawnHelper(true)) {
        this._pendingConnect = null;
        resolve({ success: false, reason: "helper-missing" });
      }
    });
  }

  disconnect() {
    this.stop();
    this.databaseManager.clearAppleCalendarData();
    this.reminderScheduler.reset();
    this.reminderScheduler.scheduleNextMeeting();
    this._broadcastConnectionChanged();
    this.broadcastToWindows("acal-events-synced", {});
    return { success: true };
  }

  stop() {
    if (this._helperProcess) {
      const child = this._helperProcess;
      this._helperProcess = null;
      try {
        child.kill();
      } catch {
        // already exited
      }
    }
  }

  syncOnFocus() {
    if (!this._helperProcess) return;
    const now = Date.now();
    if (now - this._lastFocusSync < FOCUS_SYNC_THROTTLE_MS) return;
    this._lastFocusSync = now;
    this._requestSync();
  }

  onWakeFromSleep() {
    this._requestSync();
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }

  _requestSync() {
    try {
      this._helperProcess?.stdin.write("sync\n");
    } catch (err) {
      debugLogger.debug("Calendar listener sync request failed", { error: err.message }, "acal");
    }
  }

  _resolveBinary() {
    const candidates = [
      path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME),
      path.join(__dirname, "..", "..", "resources", BINARY_NAME),
    ];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, BINARY_NAME),
        path.join(process.resourcesPath, "bin", BINARY_NAME),
        path.join(process.resourcesPath, "resources", "bin", BINARY_NAME),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", BINARY_NAME)
      );
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          debugLogger.info("Resolved binary", { name: BINARY_NAME, path: candidate }, "acal");
          return candidate;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  _spawnHelper(requestAccess) {
    this.stop();

    const binaryPath = this._resolveBinary();
    if (!binaryPath) {
      debugLogger.warn("macos-calendar-listener binary not found", {}, "acal");
      return false;
    }

    try {
      // stdin stays open for "sync" requests; its EOF also ends the helper
      const child = spawn(binaryPath, requestAccess ? ["--request"] : [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this._helperProcess = child;

      let buffer = "";
      child.stdout.on("data", (data) => {
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            this._handleMessage(JSON.parse(line));
          } catch (err) {
            debugLogger.warn(
              "Unparseable calendar listener output",
              { line, error: err.message },
              "acal"
            );
          }
        }
      });

      child.stderr.on("data", (data) => {
        debugLogger.debug(
          "macos-calendar-listener stderr",
          { output: data.toString().trim() },
          "acal"
        );
      });

      child.on("error", (err) => {
        debugLogger.warn("macos-calendar-listener error", { error: err.message }, "acal");
        this._onHelperGone(child);
      });

      child.on("exit", (code) => {
        debugLogger.info("macos-calendar-listener exited", { code }, "acal");
        this._onHelperGone(child);
      });

      return true;
    } catch (err) {
      debugLogger.warn("Failed to spawn macos-calendar-listener", { error: err.message }, "acal");
      return false;
    }
  }

  _onHelperGone(child) {
    if (this._helperProcess !== child) return;
    this._helperProcess = null;

    if (this._pendingConnect) {
      const pending = this._pendingConnect;
      this._pendingConnect = null;
      pending.resolve({ success: false, reason: "denied" });
    }
  }

  _handleMessage(message) {
    if (message.type === "permission") {
      this._handlePermission(message.status);
    } else if (message.type === "snapshot") {
      this._applySnapshot(message);
    }
  }

  _handlePermission(status) {
    debugLogger.info("Calendar permission status", { status }, "acal");
    const pending = this._pendingConnect;

    if (pending) {
      if (status === "granted") {
        pending.awaitingSnapshot = true;
      } else if (status !== "notDetermined") {
        // notDetermined means the TCC prompt is up; wait for the re-emit
        this._pendingConnect = null;
        pending.resolve({ success: false, reason: "denied" });
      }
      return;
    }

    if (status !== "granted" && this.isConnected()) {
      // Access revoked in System Settings; a full re-connect is required
      debugLogger.warn("Calendar access no longer granted", { status }, "acal");
      this.databaseManager.clearAppleCalendarData();
      this._broadcastConnectionChanged();
      this.broadcastToWindows("acal-events-synced", {});
    }
  }

  _applySnapshot({ calendars, events }) {
    try {
      this.databaseManager.saveAppleCalendars(calendars);

      const selectedIds = new Set(
        this.databaseManager.getSelectedAppleCalendars().map((cal) => cal.id)
      );
      const selectedEvents = events.filter((event) => selectedIds.has(event.calendar_id));
      this.databaseManager.replaceAppleCalendarEvents(
        selectedEvents.map((event) => this._mapEvent(event))
      );

      const contacts = [];
      for (const event of selectedEvents) {
        for (const attendee of event.attendees || []) {
          if (attendee.email) contacts.push({ email: attendee.email, displayName: attendee.name });
        }
      }
      if (contacts.length > 0) this.databaseManager.upsertContacts(contacts);

      this.broadcastToWindows("acal-events-synced", {});
      this.reminderScheduler.scheduleNextMeeting();

      if (this._pendingConnect?.awaitingSnapshot) {
        const pending = this._pendingConnect;
        this._pendingConnect = null;
        pending.resolve({ success: true });
        this._broadcastConnectionChanged();
      }
    } catch (err) {
      debugLogger.error("Error applying calendar snapshot", { error: err.message }, "acal");
      if (this._pendingConnect) {
        const pending = this._pendingConnect;
        this._pendingConnect = null;
        pending.resolve({ success: false, reason: "snapshot-failed" });
      }
    }
  }

  _mapEvent(event) {
    const attendees = event.attendees || [];
    return {
      id: event.id,
      calendar_id: event.calendar_id,
      provider: "apple",
      summary: event.title || null,
      start_time: event.start,
      end_time: event.end,
      is_all_day: event.is_all_day,
      status: event.status,
      hangout_link:
        extractMeetingUrl([event.url, event.location, ...(event.notes_urls || [])]) ??
        // Generic fallback only for the event's own URL field
        (event.url?.startsWith("https://") ? event.url : null),
      conference_data: null,
      organizer_email: event.organizer_email || null,
      attendees_count: attendees.length,
      attendees: attendees.length
        ? JSON.stringify(
            attendees.map((a) => ({
              email: a.email || null,
              displayName: a.name || null,
              responseStatus: a.status || null,
              self: a.self || false,
            }))
          )
        : null,
    };
  }

  _broadcastConnectionChanged() {
    this.broadcastToWindows("acal-connection-changed", this.getConnectionStatus());
  }
}

module.exports = AppleCalendarManager;
