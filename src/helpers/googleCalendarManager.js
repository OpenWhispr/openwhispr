const { net } = require("electron");
const debugLogger = require("./debugLogger");
const GoogleCalendarOAuth = require("./googleCalendarOAuth");
const CalendarSyncInterval = require("./calendarSyncInterval");
const { MAX_BUFFER_MINUTES } = require("./calendarAvailability");
const { extractMeetingUrl } = require("./meetingJoinUrl");
const { broadcastToWindows } = require("./windowBroadcast");

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const BUFFER_COVERAGE_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const ALL_DAY_TIMEZONE_PADDING_MS = 48 * 60 * 60 * 1000;

// Sync tokens pin the full sync's timeMin/timeMax window, so discard them
// after a day to keep the lookahead covering the 31-day availability horizon.
const SYNC_LOOKAHEAD_MS = 33 * 24 * 60 * 60 * 1000;
const SYNC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_RESPONSE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

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
      this.reminderScheduler.reset("google");
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
      this.reminderScheduler.reset("google");
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

    broadcastToWindows("gcal-events-synced", {});
    this.reminderScheduler.scheduleNextMeeting();
  }

  async _syncCalendar(calendar) {
    const accountEmail = calendar.account_email;

    const buildFullParams = () =>
      new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: new Date(
          Date.now() - BUFFER_COVERAGE_MS - ALL_DAY_TIMEZONE_PADDING_MS
        ).toISOString(),
        timeMax: new Date(
          Date.now() + SYNC_LOOKAHEAD_MS + ALL_DAY_TIMEZONE_PADDING_MS
        ).toISOString(),
      });

    const hasFreshToken = Boolean(
      calendar.sync_token && calendar.sync_token_expires_at > Date.now()
    );
    let isFullSync = !hasFreshToken;
    let tokenExpiresAt = hasFreshToken
      ? calendar.sync_token_expires_at
      : Date.now() + SYNC_TOKEN_TTL_MS;
    let baseParams = isFullSync
      ? buildFullParams()
      : new URLSearchParams({
          singleEvents: "true",
          syncToken: calendar.sync_token,
        });
    let pageToken = null;
    let nextSyncToken = null;
    const allItems = [];

    while (true) {
      const params = new URLSearchParams(baseParams);
      if (pageToken) params.set("pageToken", pageToken);

      let data;
      try {
        data = await this._apiGet(
          `/calendars/${encodeURIComponent(calendar.id)}/events?${params.toString()}`,
          accountEmail
        );
      } catch (err) {
        // 410 Gone means syncToken is invalid; fall back to full sync
        if (err.statusCode === 410 && !pageToken && !isFullSync) {
          isFullSync = true;
          tokenExpiresAt = Date.now() + SYNC_TOKEN_TTL_MS;
          baseParams = buildFullParams();
          continue;
        }
        throw err;
      }

      if (data.items) {
        allItems.push(...data.items);
      }
      pageToken = data.nextPageToken || null;
      if (data.nextSyncToken) {
        nextSyncToken = data.nextSyncToken;
      }

      if (!pageToken) break;
    }

    const toUpsert = [];
    const toRemove = [];
    const contactsToUpsert = [];

    for (const item of allItems) {
      if (item.status === "cancelled") {
        toRemove.push(item.id);
        continue;
      }

      const isAllDay = !item.start?.dateTime;
      const selfAttendee = item.attendees?.find((attendee) => attendee.self === true);
      toUpsert.push({
        id: item.id,
        calendar_id: calendar.id,
        provider: "google",
        summary: item.summary || null,
        start_time: item.start?.dateTime || item.start?.date,
        end_time: item.end?.dateTime || item.end?.date,
        is_all_day: isAllDay,
        status: item.status || "confirmed",
        availability_status: item.transparency === "transparent" ? "free" : "busy",
        self_response_status: GOOGLE_RESPONSE_STATUSES.has(selfAttendee?.responseStatus)
          ? selfAttendee.responseStatus
          : "unknown",
        hangout_link: item.hangoutLink || extractMeetingUrl([item.location, item.description]),
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

      if (item.attendees) {
        for (const a of item.attendees) {
          if (a.email)
            contactsToUpsert.push({ email: a.email, displayName: a.displayName || null });
        }
      }
    }

    // A full sync has no incremental baseline, so deletions that happened
    // while the sync token was invalid never arrive as cancelled items —
    // prune what the fresh snapshot no longer contains.
    if (isFullSync) {
      this.databaseManager.removeStaleCalendarEvents(
        "google",
        calendar.id,
        toUpsert.map((event) => event.id)
      );
    }
    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (nextSyncToken) {
      this.databaseManager.updateCalendarSyncToken(calendar.id, nextSyncToken, tokenExpiresAt);
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
    this.reminderScheduler.reset("google");
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    broadcastToWindows("gcal-events-synced", {});
  }

  async getUpcomingEvents(windowMinutes) {
    return this.databaseManager.getUpcomingEvents(windowMinutes);
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
    broadcastToWindows("gcal-connection-changed", { accounts });
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
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Error statuses can arrive with empty or non-JSON bodies; surface the
      // status below instead of masking it as a parse failure.
    }
    if (response.status >= 400) {
      const err = new Error(parsed?.error?.message || `API error ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }
    if (parsed === null) {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
    return parsed;
  }
}

module.exports = GoogleCalendarManager;
