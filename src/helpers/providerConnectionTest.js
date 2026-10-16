const ENDPOINTS = {
  openai: "https://api.openai.com/v1/models",
  groq: "https://api.groq.com/openai/v1/models",
  xai: "https://api.x.ai/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  // The largest page each API allows, so a valid but older model is still listed.
  anthropic: "https://api.anthropic.com/v1/models?limit=1000",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  openrouter: "https://openrouter.ai/api/v1/models",
  corti: "https://ai.eu.corti.app/v1/models",
  tinfoil: "https://inference.tinfoil.sh/v1/models",
  // Deepgram's model list answers without a key, so it cannot vouch for one. This is
  // Deepgram's documented key check.
  deepgram: "https://api.deepgram.com/v1/auth/token",
  // AssemblyAI exposes no model list; listing transcripts is its 200-vs-401 probe.
  assemblyai: "https://api.assemblyai.com/v2/transcript?limit=1",
};
// Listing the key's projects proves the key too: used only if Deepgram retires the route above.
const DEEPGRAM_PROJECTS_ENDPOINT = "https://api.deepgram.com/v1/projects";

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
  // A hosted provider's fixed endpoint never redirects. Following one would carry
  // x-api-key or x-goog-api-key to whichever host it names (fetch drops only
  // Authorization across origins), so a redirect fails the check instead. Custom
  // servers may redirect within themselves, such as adding a trailing slash.
  let redirect = "error";

  if (provider === "openai") {
    const override = normalizeBaseUrl(
      process.env.OPENWHISPR_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL
    );
    if (override) {
      endpoints = buildModelEndpoints(override);
      redirect = "follow";
    }
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
    redirect = "follow";
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
    } else if (provider === "deepgram") {
      headers.Authorization = `Token ${apiKey}`;
    } else if (provider === "assemblyai") {
      headers.Authorization = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  return { endpoint: endpoints[0], endpoints, headers, redirect };
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

const MODEL_NOT_FOUND = {
  errorCode: "modelNotFound",
  error: "The selected model is not available from this provider.",
};
const TIMEOUT_FAILURE = { errorCode: "timeout", error: "The connection test timed out." };
const NETWORK_FAILURE = { errorCode: "network", error: "The provider could not be reached." };

// An empty or non-JSON body reads as undefined. A body that never arrives (the 12 s cap
// firing, a dropped connection) is not an answer, so its error goes on to probe's catch.
async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// Gemini, xAI and Corti answer a made-up key with a 400, which on its own can also
// mean a malformed request. Their error bodies say which it was.
const KEY_REJECTED_BY_BODY = {
  gemini: (_, body) =>
    Array.isArray(body?.error?.details) &&
    body.error.details.some((detail) => detail?.reason === "API_KEY_INVALID"),
  xai: (status, body) =>
    status === 400 && typeof body?.error === "string" && /incorrect api key/i.test(body.error),
  // Corti's gateway turns an unknown key away before routing, with no body at all.
  corti: (status, body) => status === 400 && body === undefined,
};

async function describeResponseFailure(response, provider) {
  const failure = describeStatusFailure(response.status, provider);
  const keyRejected = KEY_REJECTED_BY_BODY[provider];
  // A 401 or 403 already says the key was refused; only a vaguer status needs the body.
  if (
    failure.errorCode !== "credentialsRejected" &&
    keyRejected &&
    keyRejected(response.status, await readJson(response))
  ) {
    return { ...describeStatusFailure(401, provider), status: response.status };
  }
  return failure;
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

// Anthropic resolves an alias (claude-haiku-4-5) to a dated snapshot and lists only the
// snapshot (claude-haiku-4-5-20251001). Other servers match ids exactly.
function isDatedSnapshot(id, model) {
  return id.startsWith(model) && /^-\d{8}$/.test(id.slice(model.length));
}

async function responseOffersModel(response, model, provider) {
  if (!model) return true;
  try {
    const payload = await response.json();
    const selected = normalizeModelId(model);
    return responseModelIds(payload).some(
      (id) => id === selected || (provider === "anthropic" && isDatedSnapshot(id, selected))
    );
  } catch {
    return false;
  }
}

// One GET under the 12 s cap. `judge` reads the response inside that window, so a body
// that stalls cannot hold the check past the cap. It returns null when the check passes.
async function probe(endpoint, request, fetchImpl, judge) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: request.headers,
      redirect: request.redirect,
      signal: controller.signal,
    });
    return await judge(response);
  } catch (error) {
    return error?.name === "AbortError" ? TIMEOUT_FAILURE : NETWORK_FAILURE;
  } finally {
    clearTimeout(timeout);
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
  if (provider === "deepgram") return testDeepgramKey(request, fetchImpl);

  const model = String(config?.model || "").trim();
  let failure = null;
  for (const endpoint of request.endpoints) {
    const next = await probe(endpoint, request, fetchImpl, async (response) => {
      if (!response.ok) return describeResponseFailure(response, provider);
      // AssemblyAI's probe lists transcripts, not models, so a 200 is the whole signal.
      if (provider === "assemblyai" || (await responseOffersModel(response, model, provider))) {
        return null;
      }
      return MODEL_NOT_FOUND;
    });
    if (!next) return { success: true };
    failure = pickFailure(failure, next);
  }
  return { success: false, ...failure };
}

// Deepgram is checked by key alone, since its model names don't match the app's model ids.
// A 404 means the key route was retired, not that the key is wrong, so the project list
// stands in.
async function testDeepgramKey(request, fetchImpl) {
  let retired = false;
  const failure = await probe(request.endpoint, request, fetchImpl, async (response) => {
    if (response.ok) return null;
    retired = response.status === 404;
    return describeStatusFailure(response.status, "deepgram");
  });
  if (!retired) return failure ? { success: false, ...failure } : { success: true };
  const fallback = await probe(DEEPGRAM_PROJECTS_ENDPOINT, request, fetchImpl, async (response) => {
    if (!response.ok) return describeStatusFailure(response.status, "deepgram");
    // No errorCode: the step shows its generic "could not be verified".
    return Array.isArray((await readJson(response))?.projects) ? null : {};
  });
  return fallback ? { success: false, ...fallback } : { success: true };
}

module.exports = { resolveProviderRequest, testProviderConnection };
