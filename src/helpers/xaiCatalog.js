// xAI's chat catalog is live at GET /v1/language-models (not /v1/models, which
// also lists imagine/voice/STT). Main process so every window shares one request
// and the SuperGrok bearer never enters the renderer.
const debugLogger = require("./debugLogger");

const XAI_LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

let lastFailureAt = 0;
let inFlight = null;

function isLanguageModel(model) {
  if (!model || typeof model.id !== "string" || !model.id.trim()) return false;
  const id = model.id.trim();
  if (id === "latest") return false;
  if (/^grok-(imagine|voice|stt)\b/i.test(id)) return false;
  const outputs = model.output_modalities;
  return Array.isArray(outputs) && outputs.includes("text");
}

function displayName(id) {
  return id
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function toCatalogModel(model) {
  const inputs = Array.isArray(model.input_modalities) ? model.input_modalities : [];
  const contextLength = Number(model.context_length);
  return {
    id: model.id.trim(),
    name: displayName(model.id.trim()),
    description: Number.isFinite(contextLength) && contextLength > 0
      ? `${Math.round(contextLength / 1000)}k context`
      : "",
    supportsVision: inputs.includes("image"),
    supportsThinking: /reasoning/i.test(model.id),
  };
}

function parseLanguageModels(payload) {
  const models = payload?.models;
  if (!Array.isArray(models)) {
    throw new Error("Malformed models list");
  }
  return models
    .filter(isLanguageModel)
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))
    .map(toCatalogModel);
}

async function fetchLanguageModels({ getBearer, fetchImpl }) {
  const token = typeof getBearer === "function" ? await getBearer() : "";
  if (!token) {
    throw new Error("xAI credentials not configured");
  }
  const response = await fetchImpl(XAI_LANGUAGE_MODELS_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`xAI models request failed: ${response.status}`);
  }
  return parseLanguageModels(await response.json());
}

/**
 * Resolves to xAI chat models for the current SuperGrok/console bearer.
 * Rejects when the fetch fails so callers can keep the bundled fallback.
 */
async function getXaiLanguageModels({ getBearer, fetchImpl = fetch } = {}) {
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    throw new Error("xAI models unavailable");
  }

  if (!inFlight) {
    inFlight = fetchLanguageModels({ getBearer, fetchImpl })
      .then((models) => {
        lastFailureAt = 0;
        return models;
      })
      .catch((error) => {
        lastFailureAt = Date.now();
        debugLogger.warn("Failed to fetch xAI language models", { error: error.message });
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

module.exports = {
  getXaiLanguageModels,
  parseLanguageModels,
  XAI_LANGUAGE_MODELS_URL,
};
