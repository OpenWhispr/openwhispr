const https = require("https");
const { Notification, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");
const GoogleCalendarOAuth = require("./googleCalendarOAuth");

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

class GoogleCalendarManager {
  constructor(databaseManager, windowManager) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.oauth = new GoogleCalendarOAuth(databaseManager);
    this.accounts = new Map();
    this.syncInterval = null;
    this.nextMeetingTimer = null;
    this.meetingEndTimer = null;
    this.activeMeeting = null;
    this.notifiedMeetings = new Set();
    this.SYNC_INTERVAL_MS = 2 * 60 * 1000;
    this._consecutiveFailures = 0;
    this._lastFocusSync = 0;
  }

  start() {
    this._loadAccounts();
    if (this.accounts.size === 0) return;

    this.syncEvents()
      .then(() => {
        this.scheduleNextMeeting();
        this._consecutiveFailures = 0;
      })
      .catch((err) =>
        debugLogger.error("Initial calendar sync failed", { error: err.message }, "gcal")
      );

    this._startSyncInterval();
  }

  stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
    this.activeMeeting = null;
  }

  isConnected() {
    return this.accounts.size > 0;
  }

  addAccount(email) {
    this.accounts.set(email, { email });
  }

  removeAccount(email) {
    this.accounts.delete(email);
    this.databaseManager.removeGoogleAccount(email);
    this._broadcastAccountsChanged();

    if (this.accounts.size === 0) {
      this.stop();
      this.notifiedMeetings.clear();
    }
  }

  async startOAuth() {
    const result = await this.oauth.startOAuthFlow();
    this.addAccount(result.email);

    await this.fetchCalendars(result.email);
    await this.syncEvents();
    this._consecutiveFailures = 0;
    this.scheduleNextMeeting();
    this._startSyncInterval();
    this._broadcastAccountsChanged();

    return result;
  }

  async revokeAllTokens() {
    try {
      const allTokens = this.databaseManager.getAllGoogleTokens();
      await Promise.allSettled(allTokens.map((t) => this.oauth.revokeToken(t.access_token)));
    } catch (err) {
      debugLogger.error("Error revoking Google tokens", { error: err.message }, "gcal");
    }
    this.disconnect();
  }

  disconnect(email) {
    if (email) {
      this.removeAccount(email);
    } else {
      this.stop();
      this.accounts.clear();
      this.databaseManager.clearCalendarData();
      this.notifiedMeetings.clear();
      this._broadcastAccountsChanged();
    }
  }

  getConnectionStatus() {
    const accounts = this.databaseManager.getGoogleAccounts();
    return {
      connected: accounts.length > 0,
      accounts,
      // Backwards compat
      email: accounts[0]?.email || null,
    };
  }

  getAccounts() {
    return this.databaseManager.getGoogleAccounts();
  }

  async fetchCalendars(accountEmail = null) {
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars = [];

    for (const email of emails) {
      try {
        const data = await this._apiGet("/users/me/calendarList", email);
        const calendars = (data.items || []).map((item) => ({
          id: item.id,
          summary: item.summary,
          description: item.description || null,
          background_color: item.backgroundColor || null,
        }));
        this.databaseManager.saveGoogleCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        debugLogger.error("Error fetching calendars", { email, error: err.message }, "gcal");
      }
    }

    return allCalendars;
  }

  async syncEvents() {
    const selectedCalendars = this.databaseManager.getSelectedCalendars();
    if (selectedCalendars.length === 0) return;

    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar);
      } catch (err) {
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: err.message },
          "gcal"
        );
      }
    }

    this.broadcastToWindows("gcal-events-synced", {});
    this.scheduleNextMeeting();
  }

  async _syncCalendar(calendar) {
    const accountEmail = calendar.account_email;
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    if (calendar.sync_token) {
      params.delete("timeMin");
      params.delete("timeMax");
      params.delete("orderBy");
      params.set("syncToken", calendar.sync_token);
    }

    let data;
    try {
      data = await this._apiGet(
        `/calendars/${encodeURIComponent(calendar.id)}/events?${params.toString()}`,
        accountEmail
      );
    } catch (err) {
      // 410 Gone means syncToken is invalid; fall back to full sync
      if (err.statusCode === 410) {
        const fullParams = new URLSearchParams({
          singleEvents: "true",
          orderBy: "startTime",
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
        data = await this._apiGet(
          `/calendars/${encodeURIComponent(calendar.id)}/events?${fullParams.toString()}`,
          accountEmail
        );
      } else {
        throw err;
      }
    }

    const toUpsert = [];
    const toRemove = [];

    for (const item of data.items || []) {
      if (item.status === "cancelled") {
        toRemove.push(item.id);
        continue;
      }

      const isAllDay = !item.start?.dateTime;
      toUpsert.push({
        id: item.id,
        calendar_id: calendar.id,
        summary: item.summary || null,
        start_time: item.start?.dateTime || item.start?.date,
        end_time: item.end?.dateTime || item.end?.date,
        is_all_day: isAllDay,
        status: item.status || "confirmed",
        hangout_link: item.hangoutLink || null,
        conference_data: item.conferenceData ? JSON.stringify(item.conferenceData) : null,
        organizer_email: item.organizer?.email || null,
        attendees_count: item.attendees?.length || 0,
      });
    }

    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (data.nextSyncToken)
      this.databaseManager.updateCalendarSyncToken(calendar.id, data.nextSyncToken);
  }

  scheduleNextMeeting() {
    if (this.nextMeetingTimer) {
      clearTimeout(this.nextMeetingTimer);
      this.nextMeetingTimer = null;
    }

    const upcoming = this.databaseManager.getUpcomingEvents(1440);
    const next = upcoming.find((e) => !this.notifiedMeetings.has(e.id));
    if (!next) return;

    const delay = new Date(next.start_time).getTime() - Date.now();
    if (delay <= 0) {
      this.onMeetingStart(next);
      return;
    }

    this.nextMeetingTimer = setTimeout(() => {
      this.onMeetingStart(next);
    }, delay);
  }

  onMeetingStart(event) {
    const events = this.databaseManager.getActiveEvents();
    const stillExists =
      events.some((e) => e.id === event.id) ||
      this.databaseManager.getUpcomingEvents(1).some((e) => e.id === event.id);

    if (!stillExists) {
      this.scheduleNextMeeting();
      return;
    }

    this.activeMeeting = event;
    this.notifiedMeetings.add(event.id);

    const notif = new Notification({
      title: event.summary || "Meeting",
      body: "Meeting starting now",
    });
    notif.on("click", () => {
      this.broadcastToWindows("gcal-start-recording", { event });
    });
    notif.show();

    this.broadcastToWindows("gcal-meeting-starting", { event });

    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
    }
    const endDelay = new Date(event.end_time).getTime() - Date.now();
    if (endDelay > 0) {
      this.meetingEndTimer = setTimeout(() => {
        this.onMeetingEnd();
      }, endDelay);
    }

    this.scheduleNextMeeting();
  }

  onMeetingEnd() {
    this.broadcastToWindows("gcal-meeting-ended", { event: this.activeMeeting });
    this.activeMeeting = null;
    if (this.meetingEndTimer) {
      clearTimeout(this.meetingEndTimer);
      this.meetingEndTimer = null;
    }
    this.scheduleNextMeeting();
  }

  onWakeFromSleep() {
    const activeEvents = this.databaseManager.getActiveEvents();
    if (activeEvents.length > 0 && !this.activeMeeting) {
      this.onMeetingStart(activeEvents[0]);
    }
    this.scheduleNextMeeting();

    this.syncEvents()
      .then(() => {
        this._consecutiveFailures = 0;
        this._restartSyncInterval();
      })
      .catch((err) => debugLogger.error("Post-wake sync failed", { error: err.message }, "gcal"));
  }

  syncOnFocus() {
    if (!this.isConnected()) return;
    const now = Date.now();
    if (now - this._lastFocusSync < 30000) return;
    this._lastFocusSync = now;

    this.syncEvents()
      .then(() => {
        this.scheduleNextMeeting();
        if (this._consecutiveFailures > 0) {
          this._consecutiveFailures = 0;
          this._restartSyncInterval();
        }
      })
      .catch((err) =>
        debugLogger.error("Focus-triggered sync failed", { error: err.message }, "gcal")
      );
  }

  getActiveMeetingState() {
    return {
      activeMeeting: this.activeMeeting,
      activeEvents: this.databaseManager.getActiveEvents(),
      upcomingEvents: this.databaseManager.getUpcomingEvents(15),
    };
  }

  getCalendars() {
    return this.databaseManager.getGoogleCalendars();
  }

  async setCalendarSelection(calendarId, isSelected) {
    this.databaseManager.updateCalendarSelection(calendarId, isSelected);
    await this.syncEvents();
    this._consecutiveFailures = 0;
    this.scheduleNextMeeting();
  }

  async getUpcomingEvents(windowMinutes) {
    return this.databaseManager.getUpcomingEvents(windowMinutes);
  }

  broadcastToWindows(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }

  _loadAccounts() {
    const accounts = this.databaseManager.getGoogleAccounts();
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.email, { email: account.email });
    }
  }

  _getAccountEmails() {
    return Array.from(this.accounts.keys());
  }

  _startSyncInterval() {
    if (this.syncInterval) clearInterval(this.syncInterval);

    const interval = this._getSyncInterval();
    debugLogger.info(
      "Calendar sync scheduled",
      { intervalMs: interval, consecutiveFailures: this._consecutiveFailures },
      "gcal"
    );

    this.syncInterval = setInterval(() => {
      this.syncEvents()
        .then(() => {
          this.scheduleNextMeeting();
          if (this._consecutiveFailures > 0) {
            this._consecutiveFailures = 0;
            this._restartSyncInterval();
          }
        })
        .catch((err) => {
          this._consecutiveFailures++;
          debugLogger.error(
            "Calendar sync failed",
            {
              error: err.message,
              consecutiveFailures: this._consecutiveFailures,
              nextIntervalMs: this._getSyncInterval(),
            },
            "gcal"
          );
          this._restartSyncInterval();
        });
    }, interval);
  }

  _getSyncInterval() {
    if (this._consecutiveFailures === 0) return this.SYNC_INTERVAL_MS;
    return Math.min(this.SYNC_INTERVAL_MS * Math.pow(2, this._consecutiveFailures), 30 * 60 * 1000);
  }

  _restartSyncInterval() {
    this._startSyncInterval();
  }

  _broadcastAccountsChanged() {
    const accounts = this.getAccounts();
    this.broadcastToWindows("gcal-connection-changed", { accounts });
  }

  async _apiGet(path, accountEmail = null) {
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    const urlString = path.startsWith("http") ? path : `${CALENDAR_API_BASE}${path}`;
    const url = new URL(urlString);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode >= 400) {
                const err = new Error(parsed.error?.message || `API error ${res.statusCode}`);
                err.statusCode = res.statusCode;
                reject(err);
                return;
              }
              resolve(parsed);
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(10000, () => {
        req.destroy(new Error("Request timed out after 10s"));
      });
      req.end();
    });
  }
}

module.exports = GoogleCalendarManager;
