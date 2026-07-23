const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_KEY_LENGTH = 16 * 1024;

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
  PERSISTENCE_FAILED: "The API key was valid but could not be saved securely.",
  VALIDATION_FAILED: "The API key could not be validated.",
});

function failure(provider, code, options = {}) {
  return {
    success: false,
    provider,
    code,
    error: options.error || ERROR_MESSAGES[code] || ERROR_MESSAGES.VALIDATION_FAILED,
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
    return failure(provider, "BILLING_REQUIRED");
  }
  if (status === 403) {
    return failure(provider, "PERMISSION_DENIED");
  }
  if (status === 408 || status === 504) {
    return failure(provider, "TIMEOUT", { retryable: true });
  }
  if (status === 429) {
    return failure(provider, "RATE_LIMITED", { retryable: true });
  }
  if (status >= 500) {
    return failure(provider, "PROVIDER_UNAVAILABLE", { retryable: true });
  }
  return failure(provider, "VALIDATION_FAILED");
}

function classifyThrownError(provider, error) {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status) && status > 0) {
    return classifyStatus(provider, status);
  }

  const name = error?.name || "";
  const message = String(error?.message || "");
  if (name === "AbortError" || name === "TimeoutError" || /timed?\s*out|timeout/i.test(message)) {
    return failure(provider, "TIMEOUT", { retryable: true });
  }

  return failure(provider, "NETWORK_ERROR", { retryable: true });
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

async function defaultTinfoilValidator(key, timeoutMs) {
  const { TinfoilAI } = await import("tinfoil");
  const client = new TinfoilAI({
    apiKey: key,
    maxRetries: 0,
    timeout: timeoutMs,
  });
  await client.models.list();
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
      await validateTinfoil(key, timeoutMs);
      return { success: true, provider };
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

    if (response.ok) {
      return { success: true, provider };
    }

    return classifyStatus(provider, response.status);
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
  }

  try {
    await saveKey(key);
    return { success: true, provider, removed: key.length === 0 };
  } catch {
    return failure(provider, "PERSISTENCE_FAILED", { retryable: true });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HTTP_VALIDATORS,
  SUPPORTED_LLM_KEY_PROVIDERS,
  validateLlmApiKey,
  validateAndSaveLlmApiKey,
  resolveCustomModelsUrl,
};
