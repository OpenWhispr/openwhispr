const { net } = require("electron");
const debugLogger = require("./debugLogger");
const GoogleCalendarOAuth = require("./googleCalendarOAuth");
const CalendarSyncInterval = require("./calendarSyncInterval");
const { MAX_BUFFER_MINUTES } = require("./calendarAvailability");
const { extractMeetingUrl } = require("./meetingJoinUrl");
const { broadcastToWindows } = require("./windowBroadcast");

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const SYNC_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const SYNC_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUFFER_COVERAGE_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const ALL_DAY_TIMEZONE_PADDING_MS = 48 * 60 * 60 * 1000;
const AVAILABILITY_REFRESH_TTL_MS = 30 * 1000;
const CONNECTION_CHANGED_CODE = "CALENDAR_CONNECTION_CHANGED";
const AVAILABILITY_CHANGED_CODE = "CALENDAR_AVAILABILITY_CHANGED";

const GOOGLE_RESPONSE_STATUSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

function scopedError(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${scope}: ${message}`);
  wrapped.cause = error;
  return wrapped;
}

function appendErrors(target, error) {
  if (error instanceof AggregateError) target.push(...error.errors);
  else target.push(error);
}

function isConnectionGenerationError(error) {
  return error?.code === CONNECTION_CHANGED_CODE;
}

function normalizeGoogleResponseStatus(status) {
  return GOOGLE_RESPONSE_STATUSES.has(status) ? status : "needsAction";
}

class GoogleCalendarManager {
  constructor(databaseManager, windowManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new GoogleCalendarOAuth(databaseManager);
    this.accounts = new Map();
    this.primaryOnly = true;
    this._connectionGeneration = 0;
    this._availabilityRefreshEpoch = 0;
    this._lastSuccessfulAvailabilityRefreshAt = 0;
    this._availabilityRefreshInFlight = null;
    this._calendarMutationInFlight = null;
    this._syncInFlight = null;
    this.syncRunner = new CalendarSyncInterval(
      () => {
        const generation = this._connectionGeneration;
        return this.syncEvents().then(() => {
          this._assertConnectionGeneration(generation);
          this.reminderScheduler.scheduleNextMeeting();
        });
      },
      { intervalMs: 2 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000, logScope: "gcal" }
    );
  }

  start() {
    this._loadAccounts();
    if (this.accounts.size === 0) return;
    const generation = this._connectionGeneration;

    this.refreshAvailability()
      .then(() => {
        this._assertConnectionGeneration(generation);
        this.reminderScheduler.scheduleNextMeeting();
      })
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
    this._invalidateAvailabilityRefresh();
  }

  removeAccount(email) {
    this._connectionGeneration++;
    this._invalidateAvailabilityRefresh();
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
    const generation = this._connectionGeneration;
    const result = await this.oauth.startOAuthFlow({
      shouldPersist: () => this._connectionGeneration === generation,
    });
    this._assertConnectionGeneration(generation);

    return this._runCalendarMutation(generation, async () => {
      this.addAccount(result.email);
      this._assertConnectionGeneration(generation);
      this._broadcastAccountsChanged();
      this.syncRunner.start();

      const failures = [];

      try {
        await this.fetchCalendars(result.email, generation);
        this._assertConnectionGeneration(generation);
      } catch (error) {
        if (isConnectionGenerationError(error)) throw error;
        appendErrors(failures, error);
      }

      try {
        await this._runEventSync(generation);
        this._assertConnectionGeneration(generation);
      } catch (error) {
        if (isConnectionGenerationError(error)) throw error;
        appendErrors(failures, error);
      }

      this._assertConnectionGeneration(generation);
      this.reminderScheduler.scheduleNextMeeting();

      if (failures.length === 0) return result;

      const syncWarning = failures
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ");
      debugLogger.warn(
        "Google Calendar connected with an incomplete initial sync",
        { email: result.email, error: syncWarning },
        "gcal"
      );
      return result;
    });
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
      this._connectionGeneration++;
      this._invalidateAvailabilityRefresh();
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

  async fetchCalendars(accountEmail = null, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    this._lastSuccessfulAvailabilityRefreshAt = 0;
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars = [];
    const failures = [];

    for (const email of emails) {
      try {
        const calendars = [];
        let pageToken = null;
        do {
          const params = new URLSearchParams();
          if (pageToken) params.set("pageToken", pageToken);
          const query = params.size > 0 ? `?${params.toString()}` : "";
          const data = await this._apiGet(`/users/me/calendarList${query}`, email, generation);
          this._assertConnectionGeneration(generation);
          calendars.push(
            ...(data.items || []).map((item) => ({
              id: item.id,
              summary: item.summary,
              description: item.description || null,
              background_color: item.backgroundColor || null,
              is_primary: item.primary === true,
            }))
          );
          pageToken = data.nextPageToken || null;
        } while (pageToken);

        this._assertConnectionGeneration(generation);
        this.databaseManager.saveGoogleCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        debugLogger.error("Error fetching calendars", { email, error: err.message }, "gcal");
        failures.push(scopedError(`Google account ${email}`, err));
      }
    }

    this._assertConnectionGeneration(generation);
    this.databaseManager.applyPrimaryOnlyToSelection(this.primaryOnly);
    this._assertConnectionGeneration(generation);
    this.databaseManager.removeEventsFromDeselectedCalendars("google");
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to fetch ${failures.length} Google account(s)`);
    }
    return allCalendars;
  }

  syncEvents() {
    // A calendar-list refresh can change selection and delete cached rows. Let
    // its private sync finish before accepting an interval/focus sync so an
    // older selection snapshot cannot write deselected events back afterward.
    if (this._availabilityRefreshInFlight) return this._availabilityRefreshInFlight;
    if (this._calendarMutationInFlight) return this._calendarMutationInFlight;
    if (this._syncInFlight) return this._syncInFlight;

    const generation = this._connectionGeneration;
    const sync = this._runEventSync(generation)
      .catch((error) => {
        this._lastSuccessfulAvailabilityRefreshAt = 0;
        throw error;
      })
      .finally(() => {
        if (this._syncInFlight === sync) this._syncInFlight = null;
      });
    this._syncInFlight = sync;
    return sync;
  }

  async _runEventSync(generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const selectedCalendars = this.databaseManager.getSelectedCalendars();
    if (selectedCalendars.length === 0) return;
    const failures = [];

    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar, generation);
        this._assertConnectionGeneration(generation);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: err.message },
          "gcal"
        );
        failures.push(scopedError(`Google calendar ${calendar.id}`, err));
      }
    }

    this._assertConnectionGeneration(generation);
    broadcastToWindows("gcal-events-synced", {});
    this._assertConnectionGeneration(generation);
    this.reminderScheduler.scheduleNextMeeting();
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to sync ${failures.length} Google calendar(s)`);
    }
  }

  refreshAvailability() {
    if (this._availabilityRefreshInFlight) return this._availabilityRefreshInFlight;

    const now = Date.now();
    const refreshAge = now - this._lastSuccessfulAvailabilityRefreshAt;
    if (refreshAge >= 0 && refreshAge < AVAILABILITY_REFRESH_TTL_MS) {
      return Promise.resolve();
    }

    const generation = this._connectionGeneration;
    const refreshEpoch = this._availabilityRefreshEpoch;
    const refresh = this._runAvailabilityRefresh(generation)
      .then(() => {
        this._assertConnectionGeneration(generation);
        if (this._availabilityRefreshEpoch !== refreshEpoch) {
          const error = new Error("Google Calendar settings changed during availability refresh");
          error.code = AVAILABILITY_CHANGED_CODE;
          throw error;
        }
        this._lastSuccessfulAvailabilityRefreshAt = Date.now();
      })
      .finally(() => {
        if (this._availabilityRefreshInFlight === refresh) {
          this._availabilityRefreshInFlight = null;
        }
      });
    this._availabilityRefreshInFlight = refresh;
    return refresh;
  }

  async _runAvailabilityRefresh(generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const failures = [];

    // Finish an older interval/focus sync before changing the saved calendar
    // list. Its failure is superseded by the fresh sync below.
    const priorWork = this._calendarMutationInFlight || this._syncInFlight;
    if (priorWork) {
      try {
        await priorWork;
      } catch {
        // Continue with the authoritative list refresh and a fresh sync.
      }
      this._assertConnectionGeneration(generation);
    }

    try {
      await this.fetchCalendars(null, generation);
      this._assertConnectionGeneration(generation);
    } catch (err) {
      if (isConnectionGenerationError(err)) throw err;
      appendErrors(failures, err);
    }

    // Keep successful accounts and previously selected calendars current even
    // when one account's list request failed; the aggregate rejection still
    // tells the caller that the resulting cache is only partially fresh.
    try {
      await this._runEventSync(generation);
      this._assertConnectionGeneration(generation);
    } catch (err) {
      if (isConnectionGenerationError(err)) throw err;
      appendErrors(failures, err);
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Google availability refresh had ${failures.length} failure(s)`
      );
    }
  }

  async _syncCalendar(calendar, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const accountEmail = calendar.account_email;

    const buildFullParams = () =>
      new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        // DATE-only events are filtered in the calendar's timezone but stored
        // as local dates. Two padded days on both edges cover extreme timezone
        // differences in addition to the availability overlap buffer.
        timeMin: new Date(
          Date.now() - BUFFER_COVERAGE_MS - ALL_DAY_TIMEZONE_PADDING_MS
        ).toISOString(),
        timeMax: new Date(Date.now() + SYNC_WINDOW_MS + ALL_DAY_TIMEZONE_PADDING_MS).toISOString(),
      });

    const hasFreshToken = calendar.sync_token && calendar.sync_token_expires_at > Date.now();
    let isFullSync = !hasFreshToken;
    let baseParams = isFullSync
      ? buildFullParams()
      : new URLSearchParams({
          singleEvents: "true",
          syncToken: calendar.sync_token,
        });
    let tokenExpiresAt = hasFreshToken
      ? calendar.sync_token_expires_at
      : Date.now() + SYNC_TOKEN_TTL_MS;
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
          accountEmail,
          generation
        );
        this._assertConnectionGeneration(generation);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        // 410 Gone means syncToken is invalid; fall back to full sync
        if (err.statusCode === 410 && !pageToken && !isFullSync) {
          isFullSync = true;
          baseParams = buildFullParams();
          tokenExpiresAt = Date.now() + SYNC_TOKEN_TTL_MS;
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
        self_response_status: selfAttendee
          ? normalizeGoogleResponseStatus(selfAttendee.responseStatus)
          : null,
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
      this._assertConnectionGeneration(generation);
      this.databaseManager.removeStaleCalendarEvents(
        "google",
        calendar.id,
        toUpsert.map((event) => event.id)
      );
    }
    if (toUpsert.length > 0) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.upsertCalendarEvents(toUpsert);
    }
    if (toRemove.length > 0) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.removeCalendarEvents(toRemove);
    }
    if (nextSyncToken) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.updateCalendarSyncToken(calendar.id, nextSyncToken, tokenExpiresAt);
    }
    if (contactsToUpsert.length > 0) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.upsertContacts(contactsToUpsert);
    }
  }

  onWakeFromSleep() {
    this._invalidateAvailabilityRefresh();
    const generation = this._connectionGeneration;
    this.syncEvents()
      .then(() => {
        this._assertConnectionGeneration(generation);
        this.syncRunner.notifySuccess();
      })
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
    const generation = this._connectionGeneration;
    await this._runCalendarMutation(generation, async () => {
      this.databaseManager.updateCalendarSelection(calendarId, isSelected);
      this._assertConnectionGeneration(generation);
      this.databaseManager.removeEventsFromDeselectedCalendars("google");
      await this._runEventSync(generation);
      this._assertConnectionGeneration(generation);
      this.syncRunner.notifySuccess();
      this._assertConnectionGeneration(generation);
      this.reminderScheduler.scheduleNextMeeting();
    });
  }

  async setPrimaryOnly(value) {
    if (this.primaryOnly === value && !this._calendarMutationInFlight) return;
    if (!this.isConnected() && !this._calendarMutationInFlight) {
      this.primaryOnly = value;
      this._invalidateAvailabilityRefresh();
      return;
    }

    const generation = this._connectionGeneration;
    await this._runCalendarMutation(generation, async () => {
      if (this.primaryOnly === value) return;
      this.primaryOnly = value;
      this._invalidateAvailabilityRefresh();
      if (!this.isConnected()) return;
      await this.fetchCalendars(null, generation);
      this._assertConnectionGeneration(generation);
      this.reminderScheduler.reset("google");
      await this._runEventSync(generation);
      this._assertConnectionGeneration(generation);
      this.reminderScheduler.scheduleNextMeeting();
      this._assertConnectionGeneration(generation);
      broadcastToWindows("gcal-events-synced", {});
    });
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

  _invalidateAvailabilityRefresh() {
    this._availabilityRefreshEpoch++;
    this._lastSuccessfulAvailabilityRefreshAt = 0;
  }

  _assertConnectionGeneration(generation) {
    if (generation === this._connectionGeneration) return;
    const error = new Error("Google Calendar connection changed during the operation");
    error.code = CONNECTION_CHANGED_CODE;
    throw error;
  }

  _runCalendarMutation(generation, operation) {
    this._assertConnectionGeneration(generation);
    this._invalidateAvailabilityRefresh();
    const blockers = [
      this._availabilityRefreshInFlight,
      this._calendarMutationInFlight,
      this._syncInFlight,
    ].filter(Boolean);
    const mutation = Promise.allSettled(blockers)
      .then(() => {
        this._assertConnectionGeneration(generation);
        return operation();
      })
      .then((result) => {
        this._assertConnectionGeneration(generation);
        return result;
      })
      .finally(() => {
        if (this._calendarMutationInFlight === mutation) {
          this._calendarMutationInFlight = null;
        }
      });
    this._calendarMutationInFlight = mutation;
    return mutation;
  }

  _broadcastAccountsChanged() {
    const accounts = this.getAccounts();
    broadcastToWindows("gcal-connection-changed", { accounts });
  }

  async _apiGet(path, accountEmail = null, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    this._assertConnectionGeneration(generation);
    const urlString = path.startsWith("http") ? path : `${CALENDAR_API_BASE}${path}`;

    const response = await net.fetch(urlString, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    });
    this._assertConnectionGeneration(generation);
    const text = await response.text();
    this._assertConnectionGeneration(generation);
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
