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

function resolveProviderRequest(config) {
  const provider = String(config?.provider || "").toLowerCase();
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
  let endpoint = ENDPOINTS[provider];

  if (provider === "custom") {
    const raw = String(config?.baseUrl || "").trim();
    if (!raw) throw new Error("Enter an endpoint URL before testing.");
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new Error("The endpoint must use HTTP or HTTPS.");
    }
    endpoint = `${parsed.toString().replace(/\/$/, "")}/models`;
  }

  if (!endpoint) throw new Error("Connection testing is not available for this provider.");
  if (!apiKey && provider !== "custom") throw new Error("Add an API key before testing.");

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

  return { endpoint, headers };
}

async function testProviderConnection(config, fetchImpl = fetch) {
  let request;
  try {
    request = resolveProviderRequest(config);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(request.endpoint, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    if (response.ok) return { success: true };
    if (response.status === 401 || response.status === 403) {
      return { success: false, error: "The provider rejected these credentials." };
    }
    if (response.status === 404 && config?.provider === "custom") {
      return {
        success: false,
        error: "The endpoint does not expose an OpenAI-compatible model list.",
      };
    }
    return { success: false, error: `The provider returned status ${response.status}.` };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { success: false, error: "The connection test timed out." };
    }
    return { success: false, error: "The provider could not be reached." };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { resolveProviderRequest, testProviderConnection };
