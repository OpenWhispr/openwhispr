const { net, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");
const GoogleCalendarOAuth = require("./googleCalendarOAuth");
const CalendarSyncInterval = require("./calendarSyncInterval");

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

class GoogleCalendarManager {
  constructor(databaseManager, windowManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new GoogleCalendarOAuth(databaseManager);
    this.accounts = new Map();
    this.primaryOnly = true;
    this.syncRunner = new CalendarSyncInterval(
      () => this.syncEvents().then(() => this.reminderScheduler.scheduleNextMeeting()),
      { intervalMs: 2 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000, logScope: "gcal" }
    );
  }

  start() {
    this._loadAccounts();
    if (this.accounts.size === 0) return;

    this.fetchCalendars()
      .then(() => this.syncEvents())
      .then(() => this.reminderScheduler.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Initial calendar sync failed", { error: err.message }, "gcal")
      );

    this.syncRunner.start();
  }

  stop() {
    this.syncRunner.stop();
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
      this.reminderScheduler.reset();
      this.reminderScheduler.scheduleNextMeeting();
    }
  }

  async startOAuth() {
    const result = await this.oauth.startOAuthFlow();
    this.addAccount(result.email);

    await this.fetchCalendars(result.email);
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    this.syncRunner.start();
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
      this.databaseManager.clearGoogleCalendarData();
      this.reminderScheduler.reset();
      this.reminderScheduler.scheduleNextMeeting();
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
          is_primary: item.primary === true,
        }));
        this.databaseManager.saveGoogleCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        debugLogger.error("Error fetching calendars", { email, error: err.message }, "gcal");
      }
    }

    this.databaseManager.applyPrimaryOnlyToSelection(this.primaryOnly);
    this.databaseManager.removeEventsFromDeselectedCalendars("google");
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
    this.reminderScheduler.scheduleNextMeeting();
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
        provider: "google",
        summary: item.summary || null,
        start_time: item.start?.dateTime || item.start?.date,
        end_time: item.end?.dateTime || item.end?.date,
        is_all_day: isAllDay,
        status: item.status || "confirmed",
        hangout_link: item.hangoutLink || null,
        conference_data: item.conferenceData ? JSON.stringify(item.conferenceData) : null,
        organizer_email: item.organizer?.email || null,
        attendees_count: item.attendees?.length || 0,
        attendees: item.attendees
          ? JSON.stringify(
              item.attendees.map((a) => ({
                email: a.email,
                displayName: a.displayName || null,
                responseStatus: a.responseStatus || null,
                self: a.self || false,
              }))
            )
          : null,
      });
    }

    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (data.nextSyncToken)
      this.databaseManager.updateCalendarSyncToken(calendar.id, data.nextSyncToken);

    const contactsToUpsert = [];
    for (const item of data.items || []) {
      if (item.attendees) {
        for (const a of item.attendees) {
          if (a.email)
            contactsToUpsert.push({ email: a.email, displayName: a.displayName || null });
        }
      }
    }
    if (contactsToUpsert.length > 0) this.databaseManager.upsertContacts(contactsToUpsert);
  }

  onWakeFromSleep() {
    this.syncEvents()
      .then(() => this.syncRunner.notifySuccess())
      .catch((err) => debugLogger.error("Post-wake sync failed", { error: err.message }, "gcal"));
  }

  syncOnFocus() {
    if (!this.isConnected()) return;
    this.syncRunner.syncOnFocus();
  }

  getCalendars() {
    return this.databaseManager.getGoogleCalendars();
  }

  async setCalendarSelection(calendarId, isSelected) {
    this.databaseManager.updateCalendarSelection(calendarId, isSelected);
    await this.syncEvents();
    this.syncRunner.notifySuccess();
    this.reminderScheduler.scheduleNextMeeting();
  }

  async setPrimaryOnly(value) {
    if (this.primaryOnly === value) return;
    this.primaryOnly = value;
    if (!this.isConnected()) return;

    await this.fetchCalendars();
    this.reminderScheduler.reset();
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    this.broadcastToWindows("gcal-events-synced", {});
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

  _broadcastAccountsChanged() {
    const accounts = this.getAccounts();
    this.broadcastToWindows("gcal-connection-changed", { accounts });
  }

  async _apiGet(path, accountEmail = null) {
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    const urlString = path.startsWith("http") ? path : `${CALENDAR_API_BASE}${path}`;

    const response = await net.fetch(urlString, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
    if (response.status >= 400) {
      const err = new Error(parsed.error?.message || `API error ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }
    return parsed;
  }
}

module.exports = GoogleCalendarManager;
