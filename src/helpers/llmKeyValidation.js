const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_KEY_LENGTH = 16 * 1024;
const TINFOIL_VALIDATION_MODEL = "nomic-embed-text";
const TINFOIL_VALIDATION_INPUT = ".";

const HTTP_VALIDATORS = Object.freeze({
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (key) => ({
      "X-API-Key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: (key) => ({ "x-goog-api-key": key }),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  mistral: {
    url: "https://api.mistral.ai/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  corti: {
    url: "https://ai.eu.corti.app/v1/models",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
  },
});

const SUPPORTED_LLM_KEY_PROVIDERS = Object.freeze([...Object.keys(HTTP_VALIDATORS), "tinfoil"]);

const ERROR_MESSAGES = Object.freeze({
  INVALID_KEY: "The provider rejected this API key.",
  PERMISSION_DENIED: "This API key does not have the required permissions.",
  BILLING_REQUIRED: "This account needs billing or available credits before it can be used.",
  RATE_LIMITED: "The provider rate-limited the validation request. Try again shortly.",
  TIMEOUT: "The provider did not respond in time.",
  NETWORK_ERROR: "The provider could not be reached. Check your connection and try again.",
  PROVIDER_UNAVAILABLE: "The provider is temporarily unavailable. Try again shortly.",
  INVALID_ENDPOINT: "Enter a valid HTTP or HTTPS endpoint before testing the key.",
  UNSUPPORTED_PROVIDER: "This provider does not support API-key validation.",
  INVALID_REQUEST: "Enter a valid API key.",
  PERSISTENCE_FAILED: "The API key could not be saved securely.",
  VALIDATION_FAILED: "The API key could not be validated.",
});

function failure(provider, code, options = {}) {
  return {
    success: false,
    provider,
    verified: false,
    code,
    error: options.error || ERROR_MESSAGES[code] || ERROR_MESSAGES.VALIDATION_FAILED,
    retryable: options.retryable === true,
  };
}

function verified(provider) {
  return { success: true, provider, verified: true };
}

function unverified(provider, code, options = {}) {
  return {
    success: true,
    provider,
    verified: false,
    code,
    warning: options.warning || ERROR_MESSAGES[code] || ERROR_MESSAGES.VALIDATION_FAILED,
    retryable: options.retryable === true,
  };
}

function normalizeKey(key) {
  return typeof key === "string" ? key.trim() : "";
}

function classifyStatus(provider, status) {
  if (status === 401) {
    return failure(provider, "INVALID_KEY");
  }
  if (status === 402) {
    return unverified(provider, "BILLING_REQUIRED");
  }
  if (status === 403) {
    return unverified(provider, "PERMISSION_DENIED");
  }
  if (status === 408 || status === 504) {
    return unverified(provider, "TIMEOUT", { retryable: true });
  }
  if (status === 429) {
    return unverified(provider, "RATE_LIMITED", { retryable: true });
  }
  if (status >= 500) {
    return unverified(provider, "PROVIDER_UNAVAILABLE", { retryable: true });
  }
  return unverified(provider, "VALIDATION_FAILED");
}

function classifyThrownError(provider, error) {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status) && status > 0) {
    return classifyStatus(provider, status);
  }

  const name = error?.name || "";
  const message = String(error?.message || "");
  if (name === "AbortError" || name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) {
    return unverified(provider, "TIMEOUT", { retryable: true });
  }

  return unverified(provider, "NETWORK_ERROR", { retryable: true });
}

async function readStructuredError(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function isProviderInvalidKeyResponse(provider, response) {
  if (provider !== "gemini" && provider !== "xai") return false;

  const body = await readStructuredError(response);
  if (provider === "gemini") {
    return (
      Array.isArray(body?.error?.details) &&
      body.error.details.some((detail) => detail?.reason === "API_KEY_INVALID")
    );
  }

  return (
    body?.code === "invalid-argument" &&
    typeof body?.error === "string" &&
    /^incorrect api key provided\b/i.test(body.error)
  );
}

async function classifyResponse(provider, response) {
  if (response.ok) return verified(provider);
  if (response.status === 401 || (await isProviderInvalidKeyResponse(provider, response))) {
    return failure(provider, "INVALID_KEY");
  }
  return classifyStatus(provider, response.status);
}

function resolveCustomModelsUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim() || baseUrl.length > 2048) {
    return null;
  }
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    return url.toString();
  } catch {
    return null;
  }
}

async function defaultTinfoilValidator(key, timeoutMs, dependencies) {
  const createClient =
    dependencies.createTinfoilClient ||
    (async (options) => {
      const { TinfoilAI } = await import("tinfoil");
      return new TinfoilAI(options);
    });
  const client = await createClient({
    apiKey: key,
    maxRetries: 0,
    timeout: timeoutMs,
  });

  // Tinfoil's model catalog is public, so models.list() cannot authenticate a
  // key. A one-token embedding is the smallest SDK request that reaches an
  // authenticated inference endpoint while retaining enclave attestation.
  await client.embeddings.create({
    model: TINFOIL_VALIDATION_MODEL,
    input: TINFOIL_VALIDATION_INPUT,
  });
}

async function validateLlmApiKey(request, dependencies = {}) {
  const provider = typeof request?.provider === "string" ? request.provider.trim() : "";
  const key = normalizeKey(request?.key);
  const timeoutMs = dependencies.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!key || key.length > MAX_KEY_LENGTH) {
    return failure(provider, "INVALID_REQUEST");
  }

  if (provider === "tinfoil") {
    const validateTinfoil = dependencies.validateTinfoil || defaultTinfoilValidator;
    try {
      await validateTinfoil(key, timeoutMs, dependencies);
      return verified(provider);
    } catch (error) {
      return classifyThrownError(provider, error);
    }
  }

  const customUrl = provider === "custom" ? resolveCustomModelsUrl(request?.baseUrl) : null;
  if (provider === "custom" && !customUrl) {
    return failure(provider, "INVALID_ENDPOINT");
  }

  const config = HTTP_VALIDATORS[provider];
  if (!config && provider !== "custom") {
    return failure(provider, "UNSUPPORTED_PROVIDER");
  }

  const fetchImpl = dependencies.fetchImpl;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("validateLlmApiKey requires a fetch implementation");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(customUrl || config.url, {
      method: "GET",
      headers: provider === "custom" ? { Authorization: `Bearer ${key}` } : config.headers(key),
      redirect: "manual",
      signal: controller.signal,
    });

    return await classifyResponse(provider, response);
  } catch (error) {
    return classifyThrownError(provider, error);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function validateAndSaveLlmApiKey(request, dependencies = {}) {
  const provider = typeof request?.provider === "string" ? request.provider.trim() : "";
  const key = normalizeKey(request?.key);
  const saveKey = dependencies.saveKey;

  if (typeof saveKey !== "function") {
    throw new TypeError("validateAndSaveLlmApiKey requires a saveKey implementation");
  }
  if (!SUPPORTED_LLM_KEY_PROVIDERS.includes(provider)) {
    return failure(provider, "UNSUPPORTED_PROVIDER");
  }

  if (key) {
    const validation = await validateLlmApiKey({ ...request, provider, key }, dependencies);
    if (!validation.success) return validation;

    try {
      await saveKey(key);
      return validation;
    } catch {
      return failure(provider, "PERSISTENCE_FAILED", { retryable: true });
    }
  }

  try {
    await saveKey(key);
    return { success: true, provider, removed: true };
  } catch {
    return failure(provider, "PERSISTENCE_FAILED", { retryable: true });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HTTP_VALIDATORS,
  SUPPORTED_LLM_KEY_PROVIDERS,
  TINFOIL_VALIDATION_MODEL,
  TINFOIL_VALIDATION_INPUT,
  validateLlmApiKey,
  validateAndSaveLlmApiKey,
  resolveCustomModelsUrl,
};
