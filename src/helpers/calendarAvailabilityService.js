const {
  MAX_AVAILABILITY_HORIZON_DAYS,
  validateCalendarAvailabilityRequest,
  calculateCalendarAvailability,
} = require("./calendarAvailability");

function connectedCalendarProviders(calendarProviders) {
  return calendarProviders.filter(({ manager }) => manager?.isConnected?.());
}

async function getFreshCalendarAvailability({
  request,
  databaseManager,
  calendarProviders,
  clock = () => new Date(),
}) {
  // Reject malformed or over-broad input before it can trigger provider I/O.
  const normalized = validateCalendarAvailabilityRequest(request, clock());
  const connectedProviders = connectedCalendarProviders(calendarProviders);
  if (connectedProviders.length === 0) throw new Error("No calendar is connected");

  await Promise.all(
    connectedProviders.map(({ manager }) => {
      if (typeof manager.refreshAvailability !== "function") {
        throw new Error("A connected calendar provider cannot refresh availability");
      }
      return manager.refreshAvailability();
    })
  );

  // A refresh can reveal that the provider set changed (for example, EventKit
  // can return an empty snapshot after access is revoked). Never calculate
  // against a different set than the one whose refreshes just completed.
  const refreshedConnectedProviders = connectedCalendarProviders(calendarProviders);
  const connectionsChanged =
    refreshedConnectedProviders.length !== connectedProviders.length ||
    refreshedConnectedProviders.some(
      (entry) =>
        !connectedProviders.some(
          (initialEntry) =>
            initialEntry.provider === entry.provider && initialEntry.manager === entry.manager
        )
    );
  if (connectionsChanged) {
    throw new Error("Calendar connections changed while refreshing");
  }

  // Provider refreshes may take long enough that the requested start is now in
  // the past. Re-anchor the effective half-open range at completion time so no
  // returned slot is already unusable.
  const completedAt = clock();
  if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
    throw new TypeError("Calendar availability clock must return a valid Date");
  }
  const endMs = Date.parse(normalized.end);
  const effectiveStartMs = Math.max(Date.parse(normalized.start), completedAt.getTime());
  if (endMs <= effectiveStartMs) {
    throw new RangeError("The requested range ended while calendars were refreshing");
  }
  const effectiveRequest = {
    ...normalized,
    start: new Date(effectiveStartMs).toISOString(),
  };

  const bufferMs = effectiveRequest.bufferMinutes * 60 * 1000;
  const queryStart = new Date(effectiveStartMs - bufferMs).toISOString();
  const queryEnd = new Date(endMs + bufferMs).toISOString();
  const events = databaseManager.getCalendarEventsInRange(
    queryStart,
    queryEnd,
    connectedProviders.map(({ provider }) => provider)
  );
  const availability = calculateCalendarAvailability(events, effectiveRequest, completedAt);

  return {
    range: { start: effectiveRequest.start, end: effectiveRequest.end },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ...availability,
    coverage: {
      source: "local-calendar-cache",
      lookaheadDays: MAX_AVAILABILITY_HORIZON_DAYS,
    },
  };
}

module.exports = { getFreshCalendarAvailability };
