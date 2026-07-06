const DEFAULT_KEYWORDS = [
  "seo",
  "technical seo",
  "google algorithm update",
  "search console",
  "local seo",
  "ai seo",
];

function normalizePositiveNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeKeywords(value) {
  if (!Array.isArray(value)) return DEFAULT_KEYWORDS;
  const keywords = value.map((item) => String(item).trim()).filter(Boolean);
  return keywords.length > 0 ? [...new Set(keywords)] : DEFAULT_KEYWORDS;
}

function normalizeRadarConfig(input = {}) {
  return {
    enabled: Boolean(input.enabled),
    keywords: normalizeKeywords(input.keywords),
    lookbackHours: normalizePositiveNumber(input.lookbackHours, 72, { min: 1, max: 168 }),
    maxSearchResultsPerQuery: normalizePositiveNumber(input.maxSearchResultsPerQuery, 10, {
      min: 1,
      max: 25,
    }),
    maxVideosToProcess: normalizePositiveNumber(input.maxVideosToProcess, 5, { min: 1, max: 10 }),
    minDurationSeconds: normalizePositiveNumber(input.minDurationSeconds, 180, {
      min: 0,
      max: 86_400,
    }),
    excludeShorts: input.excludeShorts !== false,
    regionCode: String(input.regionCode || "US").trim().toUpperCase() || "US",
    language: String(input.language || "en").trim().toLowerCase() || "en",
    runHourLocal: normalizePositiveNumber(input.runHourLocal, 7, { min: 0, max: 23 }),
    localModelId: String(input.localModelId || "").trim(),
  };
}

function buildSearchQueries(config) {
  return normalizeRadarConfig(config).keywords.map((keyword) => `${keyword} SEO`);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates || []) {
    if (!candidate?.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function scoreVideoCandidate(video, nowMs = Date.now()) {
  const publishedMs = Date.parse(video?.publishedAt || "");
  const ageHours = Math.max(1, (nowMs - (Number.isFinite(publishedMs) ? publishedMs : nowMs)) / 3_600_000);
  const viewsPerHour = Math.round((Number(video?.viewCount) || 0) / ageHours);
  const engagement = (Number(video?.likeCount) || 0) * 0.5 + (Number(video?.commentCount) || 0) * 2;
  const durationPenalty = video?.durationSeconds && video.durationSeconds < 180 ? 500 : 0;
  return {
    videoId: video?.id,
    viewsPerHour,
    score: Math.round(viewsPerHour + engagement - durationPenalty),
  };
}

function buildLocalRelevancePrompt(video) {
  return [
    "You are filtering YouTube videos for an SEO operator.",
    "Return strict JSON with keys: relevanceScore, reason, reject.",
    "relevanceScore must be 0-100. reject must be true for spam, generic marketing, crypto, dropshipping, or non-SEO content.",
    "",
    `Title: ${video?.title || ""}`,
    `Channel: ${video?.channelTitle || ""}`,
    `Description: ${video?.description || ""}`,
  ].join("\n");
}

module.exports = {
  DEFAULT_KEYWORDS,
  normalizeRadarConfig,
  buildSearchQueries,
  dedupeCandidates,
  scoreVideoCandidate,
  buildLocalRelevancePrompt,
};
