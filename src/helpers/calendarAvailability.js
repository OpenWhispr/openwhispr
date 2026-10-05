// ESM like meetingJoinUrl.js: this module is shared with the renderer, where
// Vite only handles ESM source files; main-process CJS callers load it via
// Node's require(esm) with module-syntax detection.
const MINUTE_MS = 60 * 1000;
export const MAX_AVAILABILITY_HORIZON_DAYS = 31;
export const PAST_START_TOLERANCE_MS = 5 * MINUTE_MS;
export const DEFAULT_MINIMUM_SLOT_MINUTES = 30;
export const DEFAULT_BUFFER_MINUTES = 0;
export const DEFAULT_MAX_RESULTS = 10;
export const MAX_BUFFER_MINUTES = 120;

// Shared with the renderer tool's JSON schema (calendarAvailabilityTool.ts) so
// the advertised bounds can never drift from what validation enforces.
export const MINIMUM_SLOT_MINUTES_BOUNDS = Object.freeze({ minimum: 5, maximum: 480 });
export const BUFFER_MINUTES_BOUNDS = Object.freeze({ minimum: 0, maximum: MAX_BUFFER_MINUTES });
export const MAX_RESULTS_BOUNDS = Object.freeze({ minimum: 1, maximum: 20 });

const REQUEST_KEYS = new Set(["start", "end", "minimumSlotMinutes", "bufferMinutes", "maxResults"]);

// Time/connection-dependent failures the renderer tool relays verbatim so
// the model can correct the request; every other error stays generic.
export const USER_CORRECTABLE_ERRORS = Object.freeze({
  startTooFarInPast: "start cannot be more than 5 minutes in the past",
  endBeyondHorizon: `end plus buffer cannot extend beyond ${MAX_AVAILABILITY_HORIZON_DAYS} local calendar days from now`,
  endNotAfterNow: "end must be after the current time",
  noCalendarConnected: "No calendar is connected",
});
const RFC3339_WITH_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function hasValidDateParts(year, month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isExplicitOffsetRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = RFC3339_WITH_OFFSET_PATTERN.exec(value);
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  return (
    hasValidDateParts(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateIntegerOption(value, name, { minimum, maximum }) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function getLocalAvailabilityHorizonMs(now) {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + MAX_AVAILABILITY_HORIZON_DAYS);
  return horizon.getTime();
}

export function validateCalendarAvailabilityRequest(request, now = new Date()) {
  if (!isPlainObject(request)) {
    throw new TypeError("Calendar availability request must be a plain object");
  }

  const unknownKey = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unknownKey) throw new TypeError(`Unknown calendar availability option: ${unknownKey}`);

  if (!isExplicitOffsetRfc3339(request.start)) {
    throw new TypeError("start must be an RFC3339 timestamp with an explicit UTC offset");
  }
  if (!isExplicitOffsetRfc3339(request.end)) {
    throw new TypeError("end must be an RFC3339 timestamp with an explicit UTC offset");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const nowMs = now.getTime();
  const requestedStartMs = Date.parse(request.start);
  const endMs = Date.parse(request.end);
  const minimumSlotMinutes = validateIntegerOption(
    request.minimumSlotMinutes ?? DEFAULT_MINIMUM_SLOT_MINUTES,
    "minimumSlotMinutes",
    MINIMUM_SLOT_MINUTES_BOUNDS
  );
  const bufferMinutes = validateIntegerOption(
    request.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    "bufferMinutes",
    BUFFER_MINUTES_BOUNDS
  );
  const maxResults = validateIntegerOption(
    request.maxResults ?? DEFAULT_MAX_RESULTS,
    "maxResults",
    MAX_RESULTS_BOUNDS
  );

  if (endMs <= requestedStartMs) throw new RangeError("end must be after start");
  if (requestedStartMs < nowMs - PAST_START_TOLERANCE_MS) {
    throw new RangeError(USER_CORRECTABLE_ERRORS.startTooFarInPast);
  }
  if (endMs + bufferMinutes * MINUTE_MS > getLocalAvailabilityHorizonMs(now)) {
    throw new RangeError(USER_CORRECTABLE_ERRORS.endBeyondHorizon);
  }

  const startMs = Math.max(requestedStartMs, nowMs);
  if (endMs <= startMs) throw new RangeError(USER_CORRECTABLE_ERRORS.endNotAfterNow);

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    minimumSlotMinutes,
    bufferMinutes,
    maxResults,
  };
}

function parseLocalDateOnly(value) {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!hasValidDateParts(year, month, day)) return null;

  const date = new Date(year, month - 1, day);
  if (year >= 0 && year < 100) date.setFullYear(year);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseEventTime(value, isAllDay) {
  if (typeof value !== "string") return null;
  if (isAllDay && DATE_ONLY_PATTERN.test(value)) return parseLocalDateOnly(value);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDeclinedResponse(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "declined";
}

function isSelfDeclined(attendees) {
  let parsed = attendees;
  if (typeof attendees === "string") {
    try {
      parsed = JSON.parse(attendees);
    } catch {
      return false;
    }
  }
  if (!Array.isArray(parsed)) return false;

  return parsed.some(
    (attendee) =>
      attendee?.self === true &&
      isDeclinedResponse(attendee.responseStatus ?? attendee.response_status)
  );
}

function blocksTime(event) {
  const eventStatus = String(event.status ?? "").toLowerCase();
  if (eventStatus === "cancelled" || eventStatus === "canceled") return false;
  if (isDeclinedResponse(event.self_response_status)) return false;
  if (isSelfDeclined(event.attendees)) return false;
  return String(event.availability_status ?? "unknown").toLowerCase() !== "free";
}

function toIsoInterval(startMs, endMs) {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

// Expects a request already normalized by validateCalendarAvailabilityRequest,
// so callers that validated up front (calendarAvailabilityService.js needs the
// normalized window to query the cache first) don't pay for a second pass.
export function computeCalendarAvailability(events, normalizedRequest) {
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const windowStartMs = Date.parse(normalizedRequest.start);
  const windowEndMs = Date.parse(normalizedRequest.end);
  const bufferMs = normalizedRequest.bufferMinutes * MINUTE_MS;

  const intervals = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || !blocksTime(event)) continue;
    const isAllDay = event.is_all_day === true || event.is_all_day === 1;
    const eventStartMs = parseEventTime(event.start_time, isAllDay);
    const eventEndMs = parseEventTime(event.end_time, isAllDay);
    if (eventStartMs === null || eventEndMs === null || eventEndMs <= eventStartMs) continue;

    const startMs = Math.max(windowStartMs, eventStartMs - bufferMs);
    const endMs = Math.min(windowEndMs, eventEndMs + bufferMs);
    if (startMs < endMs) intervals.push({ startMs, endMs });
  }

  intervals.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }

  const minimumSlotMs = normalizedRequest.minimumSlotMinutes * MINUTE_MS;
  const allAvailableSlots = [];
  let cursorMs = windowStartMs;
  for (const interval of merged) {
    if (interval.startMs - cursorMs >= minimumSlotMs) {
      allAvailableSlots.push({ startMs: cursorMs, endMs: interval.startMs });
    }
    cursorMs = interval.endMs;
  }
  if (windowEndMs - cursorMs >= minimumSlotMs) {
    allAvailableSlots.push({ startMs: cursorMs, endMs: windowEndMs });
  }

  return {
    busy: merged.map(({ startMs, endMs }) => toIsoInterval(startMs, endMs)),
    availableSlots: allAvailableSlots
      .slice(0, normalizedRequest.maxResults)
      .map(({ startMs, endMs }) => ({
        ...toIsoInterval(startMs, endMs),
        durationMinutes: Math.floor((endMs - startMs) / MINUTE_MS),
      })),
    hasMore: allAvailableSlots.length > normalizedRequest.maxResults,
    isEntireRangeFree: merged.length === 0,
  };
}

export function calculateCalendarAvailability(events, request, now = new Date()) {
  return computeCalendarAvailability(events, validateCalendarAvailabilityRequest(request, now));
}
