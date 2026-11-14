// OpenCode's live model list, fetched in main: opencode.ai answers no CORS
// preflight, so the renderer can't read it. Each product has at most one
// request in flight, and a failed request isn't retried for a minute.

const debugLogger = require("./debugLogger");
const { getOpencodeProvider } = require("./opencodeProviderConfig");
const {
  isSelectableOpencodeModel,
  parseOpencodeModels,
} = require("../config/opencodeModelPolicy.js");

const MODELS_PATH = "/models";
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const catalogs = new Map();

async function fetchCatalog(providerId, { apiKey, fetch }) {
  const provider = getOpencodeProvider(providerId);
  // The key picks the subscription, so its list can differ from the public one.
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(`${provider.baseUrl}${MODELS_PATH}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenCode models request failed: ${response.status}`);
  }
  const payload = await response.json();
  const models = parseOpencodeModels(payload);
  const unnamed = Array.isArray(payload?.data)
    ? payload.data
        .filter(
          (entry) =>
            isSelectableOpencodeModel(entry) &&
            !(typeof entry.name === "string" && entry.name.trim())
        )
        .map((entry) => entry.id)
    : [];
  if (unnamed.length > 0) {
    // Warn, not debug: the picker falls back to the id, but a nameless model
    // from the server is an anomaly worth seeing in default logs.
    debugLogger.warn("OpenCode served models without display names; showing their ids", {
      provider: providerId,
      ids: unnamed,
    });
  }
  return models;
}

async function getOpencodeModels(providerId, { apiKey, fetch }) {
  getOpencodeProvider(providerId);
  let catalog = catalogs.get(providerId);
  if (!catalog) {
    catalog = { lastFailureAt: 0, inFlight: null };
    catalogs.set(providerId, catalog);
  }

  if (Date.now() - catalog.lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    throw new Error("OpenCode models unavailable");
  }

  if (!catalog.inFlight) {
    catalog.inFlight = fetchCatalog(providerId, { apiKey, fetch })
      .then((models) => {
        catalog.lastFailureAt = 0;
        return models;
      })
      .catch((error) => {
        catalog.lastFailureAt = Date.now();
        debugLogger.warn("Failed to fetch OpenCode models", {
          provider: providerId,
          error: error.message,
        });
        throw error;
      })
      .finally(() => {
        catalog.inFlight = null;
      });
  }

  return catalog.inFlight;
}

module.exports = { getOpencodeModels };
