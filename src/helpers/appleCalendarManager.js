const { spawn } = require("child_process");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const { resolveBundledBinary } = require("./binaryResolver");
const { extractMeetingUrl } = require("./meetingJoinUrl");
const { broadcastToWindows } = require("./windowBroadcast");

const BINARY_NAME = "macos-calendar-listener";
const FOCUS_SYNC_THROTTLE_MS = 30 * 1000;
const HELPER_RESTART_BASE_MS = 1000;
const HELPER_RESTART_MAX_MS = 30 * 1000;

// Reads the local EventKit store (all accounts Calendar.app aggregates) via a
// bundled Swift helper that pushes calendars+events snapshots as line-delimited
// JSON. "Connected" means apple_calendars has rows — no tokens or settings.
class AppleCalendarManager {
  constructor(databaseManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this._helperProcess = null;
    this._pendingConnect = null;
    this._lastFocusSync = 0;
    this._restartTimer = null;
    this._restartAttempts = 0;
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
    this._restartAttempts = 0;
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
    this._clearStoredCalendarData();
    return { success: true };
  }

  stop() {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartAttempts = 0;
    this._stopHelperProcess();
  }

  _stopHelperProcess() {
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

  _requestSync() {
    try {
      this._helperProcess?.stdin.write("sync\n");
    } catch (err) {
      debugLogger.debug("Calendar listener sync request failed", { error: err.message }, "acal");
    }
  }

  _spawnHelper(requestAccess) {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._stopHelperProcess();

    const binaryPath = resolveBundledBinary(BINARY_NAME, "acal");
    if (!binaryPath) {
      debugLogger.warn("macos-calendar-listener binary not found", {}, "acal");
      return false;
    }

    let command = binaryPath;
    let args = requestAccess ? ["--request"] : [];
    if (!app.isPackaged) {
      // A terminal-launched dev app makes the terminal the helper's TCC
      // "responsible process", and its missing calendar usage strings abort
      // the permission prompt. The disclaim shim makes the helper responsible
      // for itself so its embedded Info.plist usage strings apply. Packaged
      // builds are self-responsible and keep OpenWhispr as the prompt source.
      const shimPath = resolveBundledBinary("macos-disclaim-exec", "acal");
      if (shimPath) {
        args = [binaryPath, ...args];
        command = shimPath;
      } else {
        debugLogger.warn(
          "macos-disclaim-exec not found; calendar permission prompt may not appear in dev",
          {},
          "acal"
        );
      }
    }

    try {
      // stdin stays open for "sync" requests; its EOF also ends the helper
      const child = spawn(command, args, {
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

    this._scheduleHelperRestart();
  }

  _scheduleHelperRestart() {
    if (process.platform !== "darwin" || this._restartTimer || this._helperProcess) return;

    try {
      if (!this.isConnected()) return;
    } catch (err) {
      debugLogger.warn(
        "Could not determine whether calendar listener should restart",
        { error: err.message },
        "acal"
      );
      return;
    }

    const delay = Math.min(
      HELPER_RESTART_BASE_MS * Math.pow(2, this._restartAttempts),
      HELPER_RESTART_MAX_MS
    );
    this._restartAttempts += 1;
    debugLogger.info(
      "Scheduling calendar listener restart",
      { delayMs: delay, attempt: this._restartAttempts },
      "acal"
    );

    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._spawnHelper(false)) this._scheduleHelperRestart();
    }, delay);
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
        if (this.isConnected()) this._clearStoredCalendarData();
        pending.resolve({ success: false, reason: "denied" });
      }
      return;
    }

    if (status !== "granted" && this.isConnected()) {
      // Access revoked in System Settings; a full re-connect is required
      debugLogger.warn("Calendar access no longer granted", { status }, "acal");
      this._clearStoredCalendarData();
    }
  }

  _applySnapshot({ calendars, events }) {
    try {
      this._restartAttempts = 0;
      this.databaseManager.saveAppleCalendars(calendars);
      this.databaseManager.replaceAppleCalendarEvents(events.map((event) => this._mapEvent(event)));

      const contacts = [];
      for (const event of events) {
        for (const attendee of event.attendees || []) {
          if (attendee.email) contacts.push({ email: attendee.email, displayName: attendee.name });
        }
      }
      if (contacts.length > 0) this.databaseManager.upsertContacts(contacts);

      broadcastToWindows("acal-events-synced", {});
      this.reminderScheduler.reconcileProvider("apple");
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
    broadcastToWindows("acal-connection-changed", this.getConnectionStatus());
  }

  _clearStoredCalendarData() {
    this.databaseManager.clearAppleCalendarData();
    this.reminderScheduler.reset("apple");
    this.reminderScheduler.scheduleNextMeeting();
    this._broadcastConnectionChanged();
    broadcastToWindows("acal-events-synced", {});
  }
}

module.exports = AppleCalendarManager;
