// Brave Search API client for the chat agent's `web_search` tool.
//
// Replaces the hosted /api/agent/web-search proxy: the user brings their own
// Brave Search API key (free tier available at https://brave.com/search/api/),
// so search works without an OpenWhispr account.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

// Brave rejects count > 20 outright, and the agent only ever needs a handful.
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 5;

// The agent awaits this inside its tool-call loop, so an unbounded request
// would hang the chat with no user-facing recovery. Matches the timeout
// convention used by the other proxied calls in ipcHandlers.
const REQUEST_TIMEOUT_MS = 12_000;

/** Snippets are HTML-ish (Brave bolds query terms); the model wants plain text. */
function stripHtml(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function clampResultCount(numResults) {
  const n = Number(numResults);
  if (!Number.isFinite(n)) return DEFAULT_RESULTS;
  return Math.min(MAX_RESULTS, Math.max(1, Math.floor(n)));
}

function buildBraveSearchUrl(query, numResults) {
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(clampResultCount(numResults)));
  return url.toString();
}

/**
 * Normalise a Brave payload to the shape webSearchTool already consumes,
 * so the renderer-side tool is unchanged by the provider swap.
 */
function mapBraveResults(payload) {
  const results = payload?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    title: stripHtml(r?.title),
    url: typeof r?.url === "string" ? r.url : "",
    text: stripHtml(r?.description),
    publishedDate: r?.page_age || r?.age || null,
  }));
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.numResults]
 * @param {string} opts.apiKey     Brave Search subscription token
 * @param {Function} opts.fetchImpl  net.fetch in the app; injectable for tests
 */
async function braveWebSearch({ query, numResults, apiKey, fetchImpl }) {
  if (typeof query !== "string" || !query.trim()) {
    return { success: false, error: "Search query is required" };
  }
  if (!apiKey) {
    return {
      success: false,
      error: "No Brave Search API key configured",
      code: "API_KEY_MISSING",
    };
  }

  let response;
  try {
    response = await fetchImpl(buildBraveSearchUrl(query.trim(), numResults), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      // Custom headers are NOT stripped on a cross-origin redirect the way
      // Authorization is, so following one would replay the subscription token
      // to whatever host Brave pointed us at. Fail closed instead.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return { success: false, error: "Brave Search timed out", code: "TIMEOUT" };
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: "Brave Search API key rejected", code: "INVALID_KEY" };
    }
    if (response.status === 429) {
      return {
        success: false,
        error: "Brave Search rate limit reached",
        code: "PROVIDER_RATE_LIMITED",
      };
    }
    return { success: false, error: `Brave Search error: ${response.status}` };
  }

  const data = await response.json();
  return { success: true, results: mapBraveResults(data) };
}

module.exports = {
  BRAVE_SEARCH_URL,
  MAX_RESULTS,
  DEFAULT_RESULTS,
  REQUEST_TIMEOUT_MS,
  buildBraveSearchUrl,
  clampResultCount,
  mapBraveResults,
  braveWebSearch,
  stripHtml,
};
