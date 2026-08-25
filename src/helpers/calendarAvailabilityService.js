const {
  MAX_AVAILABILITY_HORIZON_DAYS,
  validateCalendarAvailabilityRequest,
  calculateCalendarAvailability,
} = require("./calendarAvailability");

function connectedCalendarProviders(calendarProviders) {
  return calendarProviders.filter(
    ({ provider, manager }) =>
      (provider !== "apple" || process.platform === "darwin") && manager?.isConnected?.()
  );
}

function getCalendarAvailability({
  request,
  databaseManager,
  calendarProviders,
  clock = () => new Date(),
}) {
  const now = clock();
  const normalized = validateCalendarAvailabilityRequest(request, now);
  const connectedProviders = connectedCalendarProviders(calendarProviders);
  if (connectedProviders.length === 0) throw new Error("No calendar is connected");

  const endMs = Date.parse(normalized.end);
  const startMs = Date.parse(normalized.start);
  const bufferMs = normalized.bufferMinutes * 60 * 1000;
  const queryStart = new Date(startMs - bufferMs).toISOString();
  const queryEnd = new Date(endMs + bufferMs).toISOString();
  const events = databaseManager.getCalendarEventsInRange(
    queryStart,
    queryEnd,
    connectedProviders.map(({ provider }) => provider)
  );
  const availability = calculateCalendarAvailability(events, normalized, now);

  return {
    range: { start: normalized.start, end: normalized.end },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ...availability,
    coverage: {
      source: "local-calendar-cache",
      lookaheadDays: MAX_AVAILABILITY_HORIZON_DAYS,
    },
  };
}

module.exports = { getCalendarAvailability };
