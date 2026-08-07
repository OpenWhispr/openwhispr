const { net } = require("electron");
const debugLogger = require("./debugLogger");
const MicrosoftCalendarOAuth = require("./microsoftCalendarOAuth");
const CalendarSyncInterval = require("./calendarSyncInterval");
const { extractMeetingUrl } = require("./meetingJoinUrl");
const { broadcastToWindows } = require("./windowBroadcast");

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

// Graph's deltaLink permanently encodes the calendarView window it was created
// with — it never rolls forward. Sync a 14-day window and discard the token
// after 7 days so coverage never drops below the app's 7-day lookahead.
const DELTA_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DELTA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RESPONSE_STATUS_BY_GRAPH = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
};

// Graph returns "2026-07-20T17:00:00.0000000" — no offset, 7-digit fraction —
// which SQLite's datetime() cannot parse. Events are requested in UTC
// (Prefer: outlook.timezone), so trim the fraction and append "Z".
function normalizeGraphDateTime({ dateTime }) {
  return `${dateTime.slice(0, 19)}Z`;
}

class MicrosoftCalendarManager {
  constructor(databaseManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new MicrosoftCalendarOAuth(databaseManager);
    this.accounts = new Map();
    this.primaryOnly = true;
    this.syncRunner = new CalendarSyncInterval(
      () => this.syncEvents().then(() => this.reminderScheduler.scheduleNextMeeting()),
      { intervalMs: 2 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000, logScope: "mcal" }
    );
  }

  start() {
    this._loadAccounts();
    if (this.accounts.size === 0) return;

    this.fetchCalendars()
      .then(() => this.syncEvents())
      .then(() => this.reminderScheduler.scheduleNextMeeting())
      .catch((err) =>
        debugLogger.error("Initial calendar sync failed", { error: err.message }, "mcal")
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
    this.databaseManager.removeMicrosoftAccount(email);
    this._broadcastAccountsChanged();

    if (this.accounts.size === 0) {
      this.stop();
      this.reminderScheduler.reset("microsoft");
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

  // Microsoft has no public token-revocation endpoint for this flow; deleting
  // the local tokens severs access from our side.
  disconnect(email) {
    if (email) {
      this.removeAccount(email);
    } else {
      this.stop();
      this.accounts.clear();
      this.databaseManager.clearMicrosoftCalendarData();
      this.reminderScheduler.reset("microsoft");
      this.reminderScheduler.scheduleNextMeeting();
      this._broadcastAccountsChanged();
    }
  }

  getConnectionStatus() {
    const accounts = this.databaseManager.getMicrosoftAccounts();
    return { connected: accounts.length > 0, accounts };
  }

  getAccounts() {
    return this.databaseManager.getMicrosoftAccounts();
  }

  async fetchCalendars(accountEmail = null) {
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars = [];

    for (const email of emails) {
      try {
        const calendars = [];
        let url = "/me/calendars?$select=id,name,hexColor,isDefaultCalendar";
        while (url) {
          const data = await this._apiGet(url, email);
          for (const item of data.value || []) {
            calendars.push({
              id: item.id,
              summary: item.name,
              background_color: item.hexColor || null,
              is_primary: item.isDefaultCalendar === true,
            });
          }
          url = data["@odata.nextLink"] || null;
        }
        this.databaseManager.saveMicrosoftCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        debugLogger.error("Error fetching calendars", { email, error: err.message }, "mcal");
      }
    }

    this.databaseManager.applyMicrosoftPrimaryOnlyToSelection(this.primaryOnly);
    this.databaseManager.removeEventsFromDeselectedCalendars("microsoft");
    return allCalendars;
  }

  async syncEvents() {
    const selectedCalendars = this.databaseManager.getSelectedMicrosoftCalendars();
    if (selectedCalendars.length === 0) return;

    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar);
      } catch (err) {
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: err.message },
          "mcal"
        );
      }
    }

    broadcastToWindows("mcal-events-synced", {});
    this.reminderScheduler.scheduleNextMeeting();
  }

  async _syncCalendar(calendar) {
    const accountEmail = calendar.account_email;

    const toUpsert = [];
    const toRemove = [];
    const contactsToUpsert = [];
    let deltaLink = null;

    const hasFreshToken = calendar.sync_token && calendar.sync_token_expires_at > Date.now();
    let isFullSync = !hasFreshToken;
    let url = hasFreshToken ? calendar.sync_token : this._deltaUrl(calendar.id);
    let tokenExpiresAt = hasFreshToken
      ? calendar.sync_token_expires_at
      : Date.now() + DELTA_TOKEN_TTL_MS;

    while (url) {
      let data;
      try {
        data = await this._apiGet(url, accountEmail);
      } catch (err) {
        // 410 Gone means the delta token expired; fall back to a full sync
        if (err.statusCode === 410 && url === calendar.sync_token) {
          isFullSync = true;
          url = this._deltaUrl(calendar.id);
          tokenExpiresAt = Date.now() + DELTA_TOKEN_TTL_MS;
          continue;
        }
        throw err;
      }

      for (const item of data.value || []) {
        if (item["@removed"]) {
          toRemove.push(item.id);
          continue;
        }
        toUpsert.push(this._mapEvent(item, calendar));
        for (const a of item.attendees || []) {
          if (a.emailAddress?.address) {
            contactsToUpsert.push({
              email: a.emailAddress.address,
              displayName: a.emailAddress.name || null,
            });
          }
        }
      }

      deltaLink = data["@odata.deltaLink"] || deltaLink;
      url = data["@odata.nextLink"] || null;
    }

    // A full sync has no delta baseline, so deletions that happened while the
    // token was invalid never arrive as @removed — prune what the fresh
    // snapshot no longer contains.
    if (isFullSync) {
      this.databaseManager.removeStaleCalendarEvents(
        "microsoft",
        calendar.id,
        toUpsert.map((event) => event.id)
      );
    }
    if (toUpsert.length > 0) this.databaseManager.upsertCalendarEvents(toUpsert);
    if (toRemove.length > 0) this.databaseManager.removeCalendarEvents(toRemove);
    if (deltaLink) {
      this.databaseManager.updateMicrosoftCalendarSyncToken(calendar.id, deltaLink, tokenExpiresAt);
    }
    if (contactsToUpsert.length > 0) this.databaseManager.upsertContacts(contactsToUpsert);
  }

  _mapEvent(item, calendar) {
    const attendees = item.attendees || [];
    const accountEmail = (calendar.account_email || "").toLowerCase();
    return {
      id: item.id,
      calendar_id: calendar.id,
      provider: "microsoft",
      summary: item.subject || null,
      start_time: normalizeGraphDateTime(item.start),
      end_time: normalizeGraphDateTime(item.end),
      is_all_day: item.isAllDay,
      // showAs is deliberately ignored: unaccepted invitations arrive as
      // showAs=tentative and must still surface (Google keeps them confirmed).
      status: item.isCancelled ? "cancelled" : "confirmed",
      hangout_link:
        item.onlineMeeting?.joinUrl ||
        item.onlineMeetingUrl ||
        extractMeetingUrl([item.location?.displayName, item.bodyPreview]),
      conference_data: null,
      organizer_email: item.organizer?.emailAddress?.address || null,
      attendees_count: attendees.length,
      attendees: attendees.length
        ? JSON.stringify(
            attendees.map((a) => ({
              email: a.emailAddress?.address || null,
              displayName: a.emailAddress?.name || null,
              responseStatus: RESPONSE_STATUS_BY_GRAPH[a.status?.response] || "needsAction",
              self: (a.emailAddress?.address || "").toLowerCase() === accountEmail,
            }))
          )
        : null,
    };
  }

  onWakeFromSleep() {
    this.syncEvents()
      .then(() => this.syncRunner.notifySuccess())
      .catch((err) => debugLogger.error("Post-wake sync failed", { error: err.message }, "mcal"));
  }

  syncOnFocus() {
    if (!this.isConnected()) return;
    this.syncRunner.syncOnFocus();
  }

  async setPrimaryOnly(value) {
    if (this.primaryOnly === value) return;
    this.primaryOnly = value;
    if (!this.isConnected()) return;

    await this.fetchCalendars();
    this.reminderScheduler.reset("microsoft");
    await this.syncEvents();
    this.reminderScheduler.scheduleNextMeeting();
    broadcastToWindows("mcal-events-synced", {});
  }

  _loadAccounts() {
    const accounts = this.databaseManager.getMicrosoftAccounts();
    this.accounts.clear();
    for (const account of accounts) {
      this.accounts.set(account.email, { email: account.email });
    }
  }

  _getAccountEmails() {
    return Array.from(this.accounts.keys());
  }

  // calendarView/delta expands recurrences into occurrences and returns a
  // deltaLink for incremental syncs (stored in microsoft_calendars.sync_token).
  _deltaUrl(calendarId) {
    const params = new URLSearchParams({
      startDateTime: new Date().toISOString(),
      endDateTime: new Date(Date.now() + DELTA_WINDOW_MS).toISOString(),
    });
    return `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params.toString()}`;
  }

  _broadcastAccountsChanged() {
    const accounts = this.getAccounts();
    broadcastToWindows("mcal-connection-changed", { accounts });
  }

  async _apiGet(path, accountEmail) {
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    const urlString = path.startsWith("http") ? path : `${GRAPH_API_BASE}${path}`;

    const response = await net.fetch(urlString, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
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

module.exports = MicrosoftCalendarManager;
module.exports.normalizeGraphDateTime = normalizeGraphDateTime;
