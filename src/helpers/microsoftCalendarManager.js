const { net } = require("electron");
const debugLogger = require("./debugLogger");
const MicrosoftCalendarOAuth = require("./microsoftCalendarOAuth");
const CalendarSyncInterval = require("./calendarSyncInterval");
const { MAX_BUFFER_MINUTES } = require("./calendarAvailability");
const { extractMeetingUrl } = require("./meetingJoinUrl");
const { broadcastToWindows } = require("./windowBroadcast");

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

const SERIES_MASTER_FIELDS =
  "subject,isAllDay,isCancelled,showAs,responseStatus,onlineMeeting,onlineMeetingUrl,location,bodyPreview,organizer,attendees";

// Graph's deltaLink permanently encodes the calendarView window it was created
// with — it never rolls forward. A 15-day window discarded after 7 days leaves
// a full 8 days of forward coverage for seven local days across DST plus the
// maximum availability buffer.
const DELTA_WINDOW_MS = 15 * 24 * 60 * 60 * 1000;
const DELTA_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUFFER_COVERAGE_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const LOOKBACK_SAFETY_MS = 24 * 60 * 60 * 1000;
const AVAILABILITY_REFRESH_TTL_MS = 30 * 1000;
const CONNECTION_CHANGED_CODE = "CALENDAR_CONNECTION_CHANGED";
const AVAILABILITY_CHANGED_CODE = "CALENDAR_AVAILABILITY_CHANGED";

const RESPONSE_STATUS_BY_GRAPH = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
};

const AVAILABILITY_STATUS_BY_GRAPH = {
  free: "free",
  workingElsewhere: "free",
  tentative: "tentative",
  busy: "busy",
  oof: "unavailable",
};

// Graph returns "2026-07-20T17:00:00.0000000" — no offset, 7-digit fraction —
// which SQLite's datetime() cannot parse. Events are requested in UTC
// (Prefer: outlook.timezone), so trim the fraction and append "Z".
function normalizeGraphDateTime({ dateTime }) {
  return `${dateTime.slice(0, 19)}Z`;
}

// calendarView/delta can return recurring-series occurrences as bare
// { id, type, seriesMasterId, start, end } stubs — no subject, attendees,
// or meeting link. Those fields live on the series master.
function isStrippedOccurrence(item) {
  return item.subject === undefined && Boolean(item.seriesMasterId);
}

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

function normalizeGraphResponseStatus(status) {
  return RESPONSE_STATUS_BY_GRAPH[status] || "needsAction";
}

class MicrosoftCalendarManager {
  constructor(databaseManager, reminderScheduler) {
    this.databaseManager = databaseManager;
    this.reminderScheduler = reminderScheduler;
    this.oauth = new MicrosoftCalendarOAuth(databaseManager);
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
      { intervalMs: 2 * 60 * 1000, maxIntervalMs: 30 * 60 * 1000, logScope: "mcal" }
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
    this._invalidateAvailabilityRefresh();
  }

  removeAccount(email) {
    this._connectionGeneration++;
    this._invalidateAvailabilityRefresh();
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
        "Microsoft Calendar connected with an incomplete initial sync",
        { email: result.email, error: syncWarning },
        "mcal"
      );
      return result;
    });
  }

  // Microsoft has no public token-revocation endpoint for this flow; deleting
  // the local tokens severs access from our side.
  disconnect(email) {
    if (email) {
      this.removeAccount(email);
    } else {
      this._connectionGeneration++;
      this._invalidateAvailabilityRefresh();
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

  async fetchCalendars(accountEmail = null, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    this._lastSuccessfulAvailabilityRefreshAt = 0;
    const emails = accountEmail ? [accountEmail] : this._getAccountEmails();
    const allCalendars = [];
    const failures = [];

    for (const email of emails) {
      try {
        const calendars = [];
        let url = "/me/calendars?$select=id,name,hexColor,isDefaultCalendar";
        while (url) {
          const data = await this._apiGet(url, email, generation);
          this._assertConnectionGeneration(generation);
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
        this._assertConnectionGeneration(generation);
        this.databaseManager.saveMicrosoftCalendars(calendars, email);
        allCalendars.push(...calendars);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        debugLogger.error("Error fetching calendars", { email, error: err.message }, "mcal");
        failures.push(scopedError(`Microsoft account ${email}`, err));
      }
    }

    this._assertConnectionGeneration(generation);
    this.databaseManager.applyMicrosoftPrimaryOnlyToSelection(this.primaryOnly);
    this._assertConnectionGeneration(generation);
    this.databaseManager.removeEventsFromDeselectedCalendars("microsoft");
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to fetch ${failures.length} Microsoft account(s)`);
    }
    return allCalendars;
  }

  syncEvents() {
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
    const selectedCalendars = this.databaseManager.getSelectedMicrosoftCalendars();
    if (selectedCalendars.length === 0) return;
    const failures = [];

    for (const calendar of selectedCalendars) {
      try {
        await this._syncCalendar(calendar, generation);
        this._assertConnectionGeneration(generation);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        this._invalidateAvailabilityRefresh();
        debugLogger.error(
          "Error syncing calendar",
          { calendarId: calendar.id, error: err.message },
          "mcal"
        );
        failures.push(scopedError(`Microsoft calendar ${calendar.id}`, err));
      }
    }

    this._assertConnectionGeneration(generation);
    broadcastToWindows("mcal-events-synced", {});
    this._assertConnectionGeneration(generation);
    this.reminderScheduler.scheduleNextMeeting();
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to sync ${failures.length} Microsoft calendar(s)`);
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
          const error = new Error(
            "Microsoft Calendar settings changed during availability refresh"
          );
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

    // Successful account snapshots and existing selections can still improve
    // the partial cache. Preserve their work, then reject the aggregate below.
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
        `Microsoft availability refresh had ${failures.length} failure(s)`
      );
    }
  }

  async _syncCalendar(calendar, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const accountEmail = calendar.account_email;

    const items = [];
    const toRemove = [];
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
        data = await this._apiGet(url, accountEmail, generation);
        this._assertConnectionGeneration(generation);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
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
        if (item["@removed"]) toRemove.push(item.id);
        else items.push(item);
      }

      deltaLink = data["@odata.deltaLink"] || deltaLink;
      url = data["@odata.nextLink"] || null;
    }

    const events = await this._backfillStrippedOccurrences(items, accountEmail, generation);
    this._assertConnectionGeneration(generation);

    const toUpsert = [];
    const contactsToUpsert = [];
    for (const item of events) {
      // An occurrence still stripped after backfill (master fetch failed) has no
      // subject, attendees, or join link. Overwriting a row a previous sync
      // stored in full would demote that meeting to an untitled time block, so
      // keep the stored row and only insert bare stubs we've never seen.
      if (isStrippedOccurrence(item) && this.databaseManager.getCalendarEventById(item.id)) {
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

    // A full sync has no delta baseline, so deletions that happened while the
    // token was invalid never arrive as @removed — prune what the fresh
    // snapshot no longer contains (kept stripped rows included).
    if (isFullSync) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.removeStaleCalendarEvents(
        "microsoft",
        calendar.id,
        events.map((event) => event.id)
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
    if (deltaLink) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.updateMicrosoftCalendarSyncToken(calendar.id, deltaLink, tokenExpiresAt);
    }
    if (contactsToUpsert.length > 0) {
      this._assertConnectionGeneration(generation);
      this.databaseManager.upsertContacts(contactsToUpsert);
    }
  }

  // Merges each stripped occurrence with its series master (fetched once per
  // series); the occurrence's own id/start/end win. A failed master fetch
  // leaves its occurrences bare instead of failing the calendar's sync;
  // _syncCalendar decides whether a bare stub may be written.
  async _backfillStrippedOccurrences(items, accountEmail, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const masterIds = new Set(
      items.filter(isStrippedOccurrence).map((item) => item.seriesMasterId)
    );
    if (masterIds.size === 0) return items;

    const masters = new Map();
    for (const id of masterIds) {
      try {
        const master = await this._apiGet(
          `/me/events/${encodeURIComponent(id)}?$select=${SERIES_MASTER_FIELDS}`,
          accountEmail,
          generation
        );
        this._assertConnectionGeneration(generation);
        masters.set(id, master);
      } catch (err) {
        if (isConnectionGenerationError(err)) throw err;
        this._invalidateAvailabilityRefresh();
        debugLogger.error(
          "Error fetching series master",
          { seriesMasterId: id, error: err.message },
          "mcal"
        );
      }
    }

    this._assertConnectionGeneration(generation);
    return items.map((item) => {
      const master = isStrippedOccurrence(item) ? masters.get(item.seriesMasterId) : null;
      return master ? { ...master, ...item } : item;
    });
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
      // Keep lifecycle status independent from showAs: unaccepted invitations
      // arrive as tentative availability and must still surface as events.
      status: item.isCancelled ? "cancelled" : "confirmed",
      availability_status: AVAILABILITY_STATUS_BY_GRAPH[item.showAs] || "unknown",
      self_response_status: item.responseStatus?.response
        ? normalizeGraphResponseStatus(item.responseStatus.response)
        : null,
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
              responseStatus: normalizeGraphResponseStatus(a.status?.response),
              self: (a.emailAddress?.address || "").toLowerCase() === accountEmail,
            }))
          )
        : null,
    };
  }

  onWakeFromSleep() {
    this._invalidateAvailabilityRefresh();
    const generation = this._connectionGeneration;
    this.syncEvents()
      .then(() => {
        this._assertConnectionGeneration(generation);
        this.syncRunner.notifySuccess();
      })
      .catch((err) => debugLogger.error("Post-wake sync failed", { error: err.message }, "mcal"));
  }

  syncOnFocus() {
    if (!this.isConnected()) return;
    this.syncRunner.syncOnFocus();
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
      this.reminderScheduler.reset("microsoft");
      await this._runEventSync(generation);
      this._assertConnectionGeneration(generation);
      this.reminderScheduler.scheduleNextMeeting();
      this._assertConnectionGeneration(generation);
      broadcastToWindows("mcal-events-synced", {});
    });
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

  _invalidateAvailabilityRefresh() {
    this._availabilityRefreshEpoch++;
    this._lastSuccessfulAvailabilityRefreshAt = 0;
  }

  _assertConnectionGeneration(generation) {
    if (generation === this._connectionGeneration) return;
    const error = new Error("Microsoft Calendar connection changed during the operation");
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

  // calendarView/delta expands recurrences into occurrences and returns a
  // deltaLink for incremental syncs (stored in microsoft_calendars.sync_token).
  _deltaUrl(calendarId) {
    const params = new URLSearchParams({
      // A slow on-demand refresh must still see events overlapping the maximum
      // pre-window buffer; retain a full extra day as a conservative margin.
      startDateTime: new Date(Date.now() - LOOKBACK_SAFETY_MS - BUFFER_COVERAGE_MS).toISOString(),
      endDateTime: new Date(Date.now() + DELTA_WINDOW_MS).toISOString(),
    });
    return `/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params.toString()}`;
  }

  _broadcastAccountsChanged() {
    const accounts = this.getAccounts();
    broadcastToWindows("mcal-connection-changed", { accounts });
  }

  async _apiGet(path, accountEmail, generation = this._connectionGeneration) {
    this._assertConnectionGeneration(generation);
    const accessToken = await this.oauth.getValidAccessToken(accountEmail);
    this._assertConnectionGeneration(generation);
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

module.exports = MicrosoftCalendarManager;
module.exports.normalizeGraphDateTime = normalizeGraphDateTime;
