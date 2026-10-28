// ESM like calendarAvailability.js: shared with the renderer, where Vite only
// handles ESM source files; main-process CJS callers load it via Node's
// require(esm) with module-syntax detection.
// Every provider keeps this much history so a note can be linked to a recent
// past meeting from the local cache, offline and without a live API call.
export const CALENDAR_LOOKBACK_DAYS = 3;
export const CALENDAR_LOOKBACK_MS = CALENDAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
