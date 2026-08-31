// ESM like calendarAvailability.js: this module is shared with the renderer,
// where Vite only handles ESM source files; main-process CJS callers load it
// via Node's require(esm) with module-syntax detection.
const DAY_MS = 86_400_000;

export function countSpokenWords(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function modeFromSettings({ useLocalWhisper, transcriptionMode, cloudTranscriptionMode }) {
  if (useLocalWhisper || transcriptionMode === "local") return "local";
  if (transcriptionMode === "self-hosted") return "self_hosted";
  if (transcriptionMode === "enterprise") return "enterprise";
  if (cloudTranscriptionMode === "openwhispr" || transcriptionMode === "openwhispr") {
    return "openwhispr_cloud";
  }
  if (transcriptionMode === "providers") return "byok";
  return "unknown";
}

function modeFromStoredProvider(provider) {
  if (!provider) return "unknown";
  if (provider.startsWith("local")) return "local";
  if (provider === "openwhispr") return "openwhispr_cloud";
  if (provider.includes("self-hosted") || provider === "lan") return "self_hosted";
  return "byok";
}

// The provider that actually ran wins when it names a concrete engine or ends
// in "-fallback", which proves the selected route never ran. Streaming provider
// names ("deepgram-streaming") are too coarse to tell BYOK from OpenWhispr
// Cloud, so everything else defers to the selected settings.
export function resolveAnalyticsMode(settings, provider) {
  const providerMode = modeFromStoredProvider(provider);
  if (providerMode === "local" || providerMode === "self_hosted") return providerMode;
  if (provider?.endsWith("-fallback")) return providerMode;
  const selected = modeFromSettings(settings);
  return selected === "unknown" ? providerMode : selected;
}

function dayNumber(value) {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
}

export function calculateStreaks(ascendingDays, today) {
  const days = [...new Set(ascendingDays)].sort();
  if (days.length === 0) return { currentStreakDays: 0, longestStreakDays: 0 };

  let run = 1;
  let longestStreakDays = 1;
  for (let index = 1; index < days.length; index += 1) {
    run = dayNumber(days[index]) - dayNumber(days[index - 1]) === 1 ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
  }

  if (dayNumber(today) - dayNumber(days[days.length - 1]) > 1) {
    return { currentStreakDays: 0, longestStreakDays };
  }

  let currentStreakDays = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (dayNumber(days[index]) - dayNumber(days[index - 1]) !== 1) break;
    currentStreakDays += 1;
  }
  return { currentStreakDays, longestStreakDays };
}

export function summarizeAnalyticsEvents(events, today = localDateKey()) {
  const buckets = new Map();
  let totalWords = 0;
  let totalSpokenDurationMs = 0;
  let coveredWords = 0;

  for (const event of events) {
    const words = Number(event.word_count) || 0;
    const duration = Number(event.spoken_duration_ms) || 0;
    totalWords += words;
    if (duration > 0) {
      totalSpokenDurationMs += duration;
      coveredWords += words;
    }
    const existing = buckets.get(event.local_date) || {
      date: event.local_date,
      words: 0,
      dictations: 0,
      spokenDurationMs: 0,
    };
    existing.words += words;
    existing.dictations += 1;
    existing.spokenDurationMs += duration;
    buckets.set(event.local_date, existing);
  }

  const daily = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    totalWords,
    totalDictations: events.length,
    totalSpokenDurationMs,
    averageWpm:
      totalSpokenDurationMs > 0
        ? Math.round((coveredWords * 60_000) / totalSpokenDurationMs)
        : null,
    ...calculateStreaks(
      daily.map((bucket) => bucket.date),
      today
    ),
    wpmCoveragePercent: totalWords > 0 ? Math.round((coveredWords / totalWords) * 100) : 0,
    daily: daily.slice(-366),
  };
}
