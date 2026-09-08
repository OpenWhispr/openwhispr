const ENDPOINTS = {
  openai: "https://api.openai.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  xai: "https://api.x.ai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  corti: "https://ai.eu.corti.app/v1/models",
  tinfoil: "https://inference.tinfoil.sh/v1/models",
};

// Renderers translate errorCode via onboarding.rehaul.provider.errors.*; the
// English `error` string stays for logs and older callers.
class ConnectionTestError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

// --- CommonJS mirror of the URL helpers in src/config/constants.ts ---
// This file runs in the main process, which cannot import that Vite/TS
// module (it reads import.meta.env). Keep these in sync with
// normalizeBaseUrl / getModelListBaseCandidates over there.

// Mirror of isPrivateHost/parseIPv4Literal in src/utils/urlUtils.ts (same
// main-process constraint as above): the runtime refuses plain HTTP on public
// hosts via isSecureHttpEndpoint, so the connection test must refuse the same
// URLs or a passing test commits a config every real request rejects.

function parseIPv4Literal(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return octets;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }

  const isIPv6 = h.includes(":");
  if (isIPv6 && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".ts.net")) return true;

  return false;
}

function splitUrlDecorators(value) {
  let path = value;
  let hash = "";
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    hash = path.slice(hashIndex);
    path = path.slice(0, hashIndex);
  }
  let query = "";
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    query = path.slice(queryIndex);
    path = path.slice(0, queryIndex);
  }
  return { path, query, hash };
}

function joinUrlDecorators(path, query, hash) {
  return `${path}${query}${hash}`;
}

function normalizeBaseUrl(value) {
  if (!value) return "";

  const trimmed = String(value).trim();
  if (!trimmed) return "";

  const { path: rawPath, query, hash } = splitUrlDecorators(trimmed);
  let normalized = rawPath;

  const suffixReplacements = [
    [/\/v1\/chat\/completions$/i, "/v1"],
    [/\/chat\/completions$/i, ""],
    [/\/v1\/responses$/i, "/v1"],
    [/\/responses$/i, ""],
    [/\/v1\/models$/i, "/v1"],
    [/\/models$/i, ""],
    [/\/v1\/audio\/transcriptions$/i, "/v1"],
    [/\/audio\/transcriptions$/i, ""],
    [/\/v1\/audio\/translations$/i, "/v1"],
    [/\/audio\/translations$/i, ""],
  ];

  for (const [pattern, replacement] of suffixReplacements) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, replacement).replace(/\/+$/, "");
    }
  }

  return joinUrlDecorators(normalized.replace(/\/+$/, ""), query, hash);
}

// Reference: getModelListBaseCandidates in src/config/constants.ts.
// Self-hosted servers (LM Studio, Ollama, vLLM) serve the API under /v1 even
// when users enter the bare origin, and LM Studio's native REST base
// (/api/v1 or /api/v0) has its OpenAI-compatible sibling at /v1.
function getModelListBaseCandidates(base) {
  const normalized = normalizeBaseUrl(base);
  if (!normalized) return [];
  const { path, query, hash } = splitUrlDecorators(normalized);
  const nativeApiMatch = path.match(/^(.+?)\/api\/v[01]$/i);
  if (nativeApiMatch) {
    return [normalized, joinUrlDecorators(`${nativeApiMatch[1]}/v1`, query, hash)];
  }
  if (path.endsWith("/v1")) return [normalized];
  return [normalized, joinUrlDecorators(`${path}/v1`, query, hash)];
}

function buildModelEndpoints(base) {
  return getModelListBaseCandidates(base).map((candidate) => {
    const { path, query, hash } = splitUrlDecorators(candidate);
    return joinUrlDecorators(`${path}/models`, query, hash);
  });
}

function resolveProviderRequest(config) {
  const provider = String(config?.provider || "").toLowerCase();
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  let endpoints = ENDPOINTS[provider] ? [ENDPOINTS[provider]] : [];

  if (provider === "openai") {
    const override = normalizeBaseUrl(
      process.env.OPENWHISPR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL
    );
    if (override) endpoints = buildModelEndpoints(override);
  }

  if (provider === "custom") {
    const raw = String(config?.baseUrl || "").trim();
    if (!raw) {
      throw new ConnectionTestError("endpointRequired", "Enter an endpoint URL before testing.");
    }
    let parsed;
    try {
      parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      throw new ConnectionTestError("invalidUrl", "The endpoint must be a valid URL.");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new ConnectionTestError("invalidUrl", "The endpoint must use HTTP or HTTPS.");
    }
    if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
      throw new ConnectionTestError(
        "httpsRequired",
        "Public endpoints must use HTTPS. HTTP is only allowed on private addresses."
      );
    }
    endpoints = buildModelEndpoints(parsed.toString());
  }

  if (endpoints.length === 0) {
    throw new ConnectionTestError(
      "unsupportedProvider",
      "Connection testing is not available for this provider."
    );
  }
  if (!apiKey && provider !== "custom") {
    throw new ConnectionTestError("apiKeyRequired", "Add an API key before testing.");
  }

  const headers = { Accept: "application/json" };
  if (apiKey) {
    if (provider === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  return { endpoint: endpoints[0], endpoints, headers };
}

// When several candidate endpoints fail, report the most actionable failure.
const FAILURE_PRIORITY = {
  credentialsRejected: 4,
  providerStatus: 3,
  modelNotFound: 2.5,
  endpointNotFound: 2,
  timeout: 1,
  network: 0,
};

function pickFailure(current, next) {
  if (!current) return next;
  return FAILURE_PRIORITY[next.errorCode] > FAILURE_PRIORITY[current.errorCode] ? next : current;
}

function describeStatusFailure(status, provider) {
  if (status === 401 || status === 403) {
    return {
      errorCode: "credentialsRejected",
      error: "The provider rejected these credentials.",
      status,
    };
  }
  if (status === 404 && provider === "custom") {
    return {
      errorCode: "endpointNotFound",
      error: "The endpoint does not expose an OpenAI-compatible model list.",
      status,
    };
  }
  return { errorCode: "providerStatus", error: `The provider returned status ${status}.`, status };
}

function normalizeModelId(value) {
  return String(value || "")
    .trim()
    .replace(/^models\//i, "");
}

function responseModelIds(payload) {
  const models = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

  return models
    .map((model) => (typeof model === "string" ? model : model?.id || model?.name))
    .map(normalizeModelId)
    .filter(Boolean);
}

async function responseOffersModel(response, model) {
  if (!model) return true;
  try {
    const payload = await response.json();
    return responseModelIds(payload).includes(normalizeModelId(model));
  } catch {
    return false;
  }
}

async function testProviderConnection(config, fetchImpl = fetch) {
  let request;
  try {
    request = resolveProviderRequest(config);
  } catch (error) {
    return {
      success: false,
      errorCode: error.errorCode || "invalidUrl",
      error: error.message,
    };
  }

  const provider = String(config?.provider || "").toLowerCase();
  const model = String(config?.model || "").trim();
  let failure = null;
  for (const endpoint of request.endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: request.headers,
        signal: controller.signal,
      });
      if (response.ok) {
        if (await responseOffersModel(response, model)) return { success: true };
        failure = pickFailure(failure, {
          errorCode: "modelNotFound",
          error: "The selected model is not available from this provider.",
        });
        continue;
      }
      failure = pickFailure(failure, describeStatusFailure(response.status, provider));
    } catch (error) {
      if (error?.name === "AbortError") {
        failure = pickFailure(failure, {
          errorCode: "timeout",
          error: "The connection test timed out.",
        });
      } else {
        failure = pickFailure(failure, {
          errorCode: "network",
          error: "The provider could not be reached.",
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  return { success: false, ...failure };
}

module.exports = { resolveProviderRequest, testProviderConnection };
