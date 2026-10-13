const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/providerHttpErrors.js");

const classify = async (args) =>
  (await load()).providerHttpError({ provider: "Mistral", surface: "transcription", ...args });

test("401 is an auth failure that points at Speech-to-Text settings", async () => {
  const c = await classify({ status: 401, body: '{"detail":"Invalid API Key"}' });
  assert.equal(c.code, "PROVIDER_AUTH_FAILED");
  assert.equal(c.messageKey, "providerErrors.authFailed");
  assert.deepEqual(c.messageParams, { provider: "Mistral" });
  assert.equal(c.settingsTarget, "speechToText");
  assert.equal(c.surface, "transcription");
});

test("LLM surface points fixable errors at Language Models settings", async () => {
  const c = await classify({ status: 401, body: "", surface: "llm" });
  assert.equal(c.settingsTarget, "llms");
});

test("400 or 403 carrying an invalid-key signal is an auth failure (Gemini API_KEY_INVALID)", async () => {
  const gemini = await classify({
    provider: "Gemini",
    status: 400,
    body: { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } },
  });
  assert.equal(gemini.code, "PROVIDER_AUTH_FAILED");
  const forbidden = await classify({ status: 403, body: "invalid x-api-key" });
  assert.equal(forbidden.code, "PROVIDER_AUTH_FAILED");
});

test("other 403s are access denied", async () => {
  const c = await classify({ status: 403, body: '{"error":"model not allowed for this project"}' });
  assert.equal(c.code, "PROVIDER_ACCESS_DENIED");
  assert.equal(c.settingsTarget, "speechToText");
});

test("402 and billing-flavoured 400/429 are quota exhaustion", async () => {
  assert.equal((await classify({ status: 402, body: "" })).code, "PROVIDER_QUOTA_EXHAUSTED");
  const openai = await classify({
    provider: "OpenAI",
    status: 429,
    body: {
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
      },
    },
  });
  assert.equal(openai.code, "PROVIDER_QUOTA_EXHAUSTED");
  const anthropic = await classify({
    provider: "Anthropic",
    status: 400,
    surface: "llm",
    body: {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    },
  });
  assert.equal(anthropic.code, "PROVIDER_QUOTA_EXHAUSTED");
});

test("self-hosted quota exhaustion gets its own sentence instead of \"Your Your server account\"", async () => {
  const { providerHttpError } = await load();
  const err = providerHttpError({
    provider: "self-hosted",
    selfHosted: true,
    status: 402,
    body: "",
    surface: "llm",
  });
  assert.equal(err.code, "PROVIDER_QUOTA_EXHAUSTED");
  assert.equal(err.messageKey, "providerErrors.selfHosted.quotaExhausted");
  assert.equal(err.message, "Your server says the account is out of credit.");
  assert.equal(err.message.includes("Your Your server"), false);
});

// Real bodies: both mention quota and billing, but only ask the user to wait.
const GEMINI_RATE_LIMIT_BODY = {
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.5-flash\nPlease retry in 52.4s.",
    status: "RESOURCE_EXHAUSTED",
  },
};
const GROQ_RATE_LIMIT_BODY = {
  error: {
    message:
      "Rate limit reached for model `whisper-large-v3-turbo` in organization `org_01` service tier `on_demand` on seconds of audio per hour (ASPH): Limit 7200, Used 7190, Requested 30. Please try again in 10s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
    type: "seconds",
    code: "rate_limit_exceeded",
  },
};

test("a Gemini free-tier quota 429 stays a rate limit", async () => {
  const c = await classify({ provider: "Gemini", status: 429, body: GEMINI_RATE_LIMIT_BODY });
  assert.equal(c.code, "PROVIDER_RATE_LIMITED");
  assert.equal(c.messageKey, "hooks.audioRecording.errorDescriptions.providerRateLimited");
  assert.equal(c.settingsTarget, undefined);
});

test("a Groq 429 that links to its billing page stays a rate limit", async () => {
  const c = await classify({ provider: "Groq", status: 429, body: GROQ_RATE_LIMIT_BODY });
  assert.equal(c.code, "PROVIDER_RATE_LIMITED");
  assert.equal(c.settingsTarget, undefined);
});

test("OpenAI's real out-of-quota 429 shares Gemini's wording but is quota exhaustion", async () => {
  const c = await classify({
    provider: "OpenAI",
    status: 429,
    body: {
      error: {
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    },
  });
  assert.equal(c.code, "PROVIDER_QUOTA_EXHAUSTED");
});

test("rate-limit 429s from Gemini and Groq are still retried on the AI-model path", async () => {
  const { providerHttpError } = await load();
  const { createApiRetryStrategy } = await import("../../src/utils/retry.ts");
  const { shouldRetry } = createApiRetryStrategy();
  for (const [provider, body] of [
    ["Gemini", GEMINI_RATE_LIMIT_BODY],
    ["Groq", GROQ_RATE_LIMIT_BODY],
  ]) {
    const error = providerHttpError({ provider, status: 429, body, surface: "llm" });
    assert.equal(shouldRetry(error), true, `${provider} rate limit should retry`);
  }
});

test("404 and model-not-found 400 name the model", async () => {
  const notFound = await classify({ status: 404, body: "", model: "voxtral-max" });
  assert.equal(notFound.code, "PROVIDER_MODEL_NOT_FOUND");
  assert.equal(notFound.messageKey, "providerErrors.modelNotFound");
  assert.deepEqual(notFound.messageParams, { provider: "Mistral", model: "voxtral-max" });
  const badModel = await classify({
    provider: "OpenAI",
    status: 400,
    body: { error: { message: "The model `gpt-9` does not exist", code: "model_not_found" } },
  });
  assert.equal(badModel.code, "PROVIDER_MODEL_NOT_FOUND");
  assert.equal(badModel.messageKey, "providerErrors.modelNotFoundNoModel");
});

test("a self-hosted 404 without a model signal is a generic error, not a model error", async () => {
  const c = await classify({ status: 404, body: "<html>Not Found</html>", selfHosted: true });
  assert.equal(c.code, "PROVIDER_ERROR");
  assert.equal(c.messageKey, "providerErrors.selfHosted.unknown");
  assert.equal(c.messageParams.provider, "Your server");
});

test("413, other 4xx, timeouts, 5xx and unknown statuses", async () => {
  assert.equal((await classify({ status: 413, body: "" })).code, "PROVIDER_PAYLOAD_TOO_LARGE");
  for (const status of [400, 415, 422]) {
    assert.equal((await classify({ status, body: "bad audio" })).code, "PROVIDER_BAD_REQUEST");
  }
  for (const status of [408, 504]) {
    assert.equal((await classify({ status, body: "" })).code, "PROVIDER_TIMEOUT");
  }
  for (const status of [500, 502, 503, 529]) {
    assert.equal((await classify({ status, body: "" })).code, "PROVIDER_UNAVAILABLE");
  }
  assert.equal((await classify({ status: 418, body: "" })).code, "PROVIDER_ERROR");
});

test("technical details carry provider, status, request id and a trimmed body", async () => {
  const headers = new Headers({ "x-request-id": "req_123" });
  const c = await classify({ status: 500, body: "x".repeat(800), headers });
  assert.equal(c.technicalDetails.provider, "Mistral");
  assert.equal(c.technicalDetails.status, 500);
  assert.equal(c.technicalDetails.requestId, "req_123");
  assert.equal(c.technicalDetails.underlyingError.length, 501); // 500 chars + ellipsis
  const plain = await classify({ status: 500, body: "", headers: { "Request-Id": "abc" } });
  assert.equal(plain.technicalDetails.requestId, "abc");
  assert.equal(plain.technicalDetails.underlyingError, undefined);
});

test("HTML bodies collapse to a marker", async () => {
  const c = await classify({ status: 502, body: "<!DOCTYPE html><html><body>Bad gateway</body></html>" });
  assert.equal(c.technicalDetails.underlyingError, "<HTML response>");
});

test("keys echoed back in a body are redacted", async () => {
  const { redactProviderBody } = await load();
  const out = redactProviderBody(
    "Incorrect API key provided: sk-proj-ab***xyz. Also sk-ant-api03-zzzz gsk_abcd1234 AIzaSyA1234 xai-qwerty Authorization: Bearer eyJhbGciOi.abc"
  );
  for (const leaked of ["sk-proj-ab", "sk-ant-api03", "gsk_abcd", "AIzaSy", "xai-qwerty", "eyJhbGciOi"]) {
    assert.equal(out.includes(leaked), false, `${leaked} leaked: ${out}`);
  }
  assert.ok(out.includes("Bearer [redacted]"));
});

test("providerHttpError builds an Error carrying the classification and a short English message", async () => {
  const { providerHttpError } = await load();
  const err = providerHttpError({ provider: "Mistral", status: 401, body: "{}", surface: "transcription" });
  assert.ok(err instanceof Error);
  assert.equal(err.message, "Mistral rejected your API key.");
  assert.equal(err.code, "PROVIDER_AUTH_FAILED");
  assert.equal(err.status, 401);
  assert.equal(err.messageKey, "providerErrors.authFailed");
  assert.equal(err.settingsTarget, "speechToText");
  assert.equal(err.message.includes("{}"), false);
});

test("providerError builds key-missing errors per surface", async () => {
  const { providerError } = await load();
  const stt = providerError("API_KEY_MISSING", { provider: "Mistral", surface: "transcription" });
  assert.equal(stt.code, "API_KEY_MISSING");
  assert.equal(stt.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
  assert.equal(stt.settingsTarget, "speechToText");
  const llm = providerError("API_KEY_MISSING", { provider: "Anthropic", surface: "llm" });
  assert.equal(llm.messageKey, "providerErrors.keyMissing");
  assert.deepEqual(llm.messageParams, { provider: "Anthropic" });
  assert.equal(llm.settingsTarget, "llms");
});

test("asProviderError classifies AI SDK APICallError and RetryError", async () => {
  const { asProviderError } = await load();
  const apiCallError = Object.assign(new Error("Incorrect API key provided"), {
    name: "AI_APICallError",
    statusCode: 401,
    responseBody: '{"error":{"message":"Incorrect API key provided: sk-abcd1234"}}',
    responseHeaders: { "x-request-id": "r1" },
  });
  const direct = asProviderError(apiCallError, { provider: "OpenAI", model: "gpt-5.5", surface: "llm" });
  assert.equal(direct.code, "PROVIDER_AUTH_FAILED");
  assert.equal(direct.technicalDetails.requestId, "r1");
  assert.equal(direct.technicalDetails.underlyingError.includes("sk-abcd1234"), false);
  assert.equal(direct.cause, apiCallError);
  const retryError = Object.assign(new Error("Failed after 3 attempts"), {
    name: "AI_RetryError",
    lastError: Object.assign(new Error("overloaded"), { statusCode: 529, responseBody: "" }),
  });
  assert.equal(asProviderError(retryError, { provider: "Anthropic", surface: "llm" }).code, "PROVIDER_UNAVAILABLE");
});

test("asProviderError classifies timeouts and network failures", async () => {
  const { asProviderError } = await load();
  const ctx = { provider: "Groq", surface: "llm" };
  assert.equal(asProviderError(Object.assign(new Error("t"), { code: "LLM_REQUEST_TIMEOUT" }), ctx).code, "PROVIDER_TIMEOUT");
  assert.equal(asProviderError(Object.assign(new Error("t"), { name: "TimeoutError" }), ctx).code, "PROVIDER_TIMEOUT");
  const notFound = asProviderError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), ctx);
  assert.equal(notFound.code, "PROVIDER_UNREACHABLE");
  assert.equal(notFound.technicalDetails.underlyingError, "ENOTFOUND");
  const refused = asProviderError(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }), ctx);
  assert.equal(refused.code, "PROVIDER_UNREACHABLE");
  assert.equal(refused.technicalDetails.underlyingError, "ECONNREFUSED");
  const fetchFailed = asProviderError(new TypeError("fetch failed"), ctx);
  assert.equal(fetchFailed.code, "PROVIDER_UNREACHABLE");
  assert.deepEqual(fetchFailed.technicalDetails, { provider: "Groq" });
});

// Chromium reports a CORS-blocked HTTP error as "Failed to fetch" too: OpenAI's
// 401 for a bad sk- key carries no CORS header in the dictation window.
test("an online \"Failed to fetch\" points at the key and connection; offline it stays unreachable", async (t) => {
  const { asProviderError } = await load();
  const ctx = { provider: "OpenAI", surface: "transcription" };
  t.after(() => delete navigator.onLine);

  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const online = asProviderError(new TypeError("Failed to fetch"), ctx);
  assert.equal(online.code, "PROVIDER_NO_RESPONSE");
  assert.equal(online.message, "Couldn't get a response from OpenAI. Check your API key and connection.");
  assert.equal(online.settingsTarget, "speechToText");
  assert.deepEqual(online.technicalDetails, { provider: "OpenAI" }, "nothing beyond the message");

  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const offline = asProviderError(new TypeError("Failed to fetch"), ctx);
  assert.equal(offline.code, "PROVIDER_UNREACHABLE");
  assert.equal(offline.settingsTarget, undefined);
});

test("rate limits name the provider on the LLM surface and keep the dictation copy on transcription", async () => {
  const en = require("../../src/locales/en/translation.json");
  const llm = await classify({ provider: "Anthropic", status: 429, body: "", surface: "llm" });
  assert.equal(llm.code, "PROVIDER_RATE_LIMITED");
  assert.equal(llm.messageKey, "providerErrors.rateLimited");
  assert.deepEqual(llm.messageParams, { provider: "Anthropic" });
  const transcription = await classify({ status: 429, body: "", surface: "transcription" });
  assert.equal(transcription.messageKey, "hooks.audioRecording.errorDescriptions.providerRateLimited");
  const { providerHttpError } = await load();
  const error = providerHttpError({ provider: "Anthropic", status: 429, body: "", surface: "llm" });
  assert.equal(error.message, en.providerErrors.rateLimited.replace("{{provider}}", "Anthropic"));
});

test("asProviderError classifies Electron net::ERR_* rejections and leaves net::ERR_ABORTED alone", async () => {
  const { asProviderError } = await load();
  const ctx = { provider: "OpenAI", surface: "transcription" };
  for (const message of [
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_CONNECTION_REFUSED",
  ]) {
    const raw = new Error(message);
    const classified = asProviderError(raw, ctx);
    assert.equal(classified.code, "PROVIDER_UNREACHABLE", message);
    assert.equal(classified.messageKey, "providerErrors.unreachable");
    assert.equal(classified.cause, raw);
    // Main serialises only the message, so Copy details is the one place the code survives.
    assert.equal(classified.technicalDetails.underlyingError, message);
  }
  for (const message of ["net::ERR_TIMED_OUT", "net::ERR_CONNECTION_TIMED_OUT"]) {
    const timeout = asProviderError(new Error(message), ctx);
    assert.equal(timeout.code, "PROVIDER_TIMEOUT", message);
    assert.equal(timeout.technicalDetails.underlyingError, message);
  }
  const aborted = new Error("net::ERR_ABORTED");
  assert.equal(asProviderError(aborted, ctx), aborted);
});

test("asProviderError leaves classified, cancelled and unrelated errors untouched", async () => {
  const { asProviderError } = await load();
  const ctx = { provider: "OpenAI", surface: "llm" };
  const truncated = Object.assign(new Error("Model output was truncated"), {
    messageKey: "hooks.audioRecording.errorDescriptions.cleanupTruncated",
  });
  assert.equal(asProviderError(truncated, ctx), truncated);
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(asProviderError(abort, ctx), abort);
  const plain = new Error("something else");
  assert.equal(asProviderError(plain, ctx), plain);
  assert.equal(asProviderError(null, ctx), null);
});

test("isProviderSettingsTarget whitelists only the two sections", async () => {
  const { isProviderSettingsTarget } = await load();
  assert.equal(isProviderSettingsTarget("speechToText"), true);
  assert.equal(isProviderSettingsTarget("llms"), true);
  assert.equal(isProviderSettingsTarget("account"), false);
  assert.equal(isProviderSettingsTarget(undefined), false);
});

test("a 413 is a recording that's too large for transcription and a request that's too large for an AI model", async () => {
  const { providerHttpError } = await load();
  const recording = providerHttpError({ provider: "Mistral", status: 413, body: "", surface: "transcription" });
  assert.equal(recording.messageKey, "providerErrors.payloadTooLarge");
  assert.equal(recording.message, "This recording is too large for Mistral.");
  const request = providerHttpError({ provider: "Anthropic", status: 413, body: "", surface: "llm" });
  assert.equal(request.messageKey, "providerErrors.requestTooLarge");
  assert.equal(request.message, "This request is too large for Anthropic.");
  const selfHosted = providerHttpError({
    provider: "custom",
    selfHosted: true,
    status: 413,
    body: "",
    surface: "llm",
  });
  assert.equal(selfHosted.message, "This request is too large for your server.");
});

const en = require("../../src/locales/en/translation.json");
const LOCALES = ["en", "es", "fr", "de", "pt", "it", "ru", "zh-CN", "zh-TW", "ja", "ar"];
const lookup = (translation, key) => key.split(".").reduce((node, part) => node?.[part], translation);

// Every classification a provider failure can produce, on both surfaces, named and self-hosted.
async function everyClassification() {
  const { providerHttpError, providerError, PROVIDER_ERROR_CODES: C } = await load();
  const errors = [];
  for (const surface of ["transcription", "llm"]) {
    for (const selfHosted of [false, true]) {
      const base = { provider: "Mistral", surface, selfHosted };
      for (const status of [401, 403, 402, 429, 413, 400, 500, 504, 418]) {
        errors.push(providerHttpError({ ...base, status, body: "" }));
      }
      errors.push(providerHttpError({ ...base, status: 404, body: "model_not_found", model: "m-1" }));
      errors.push(providerHttpError({ ...base, status: 404, body: "model_not_found" }));
      for (const code of [
        C.TIMEOUT,
        C.UNREACHABLE,
        C.NO_RESPONSE,
        ...(selfHosted ? [] : [C.KEY_MISSING]),
      ]) {
        errors.push(providerError(code, base));
      }
    }
  }
  return errors;
}

test("each Error.message is the en translation of its messageKey", async () => {
  for (const error of await everyClassification()) {
    // The transcription-only hooks keys say "your transcription provider"; their twins name it.
    if (error.messageKey.startsWith("hooks.")) continue;
    const template = lookup(en, error.messageKey);
    assert.equal(typeof template, "string", `${error.messageKey} is missing from en`);
    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, name) => error.messageParams[name]);
    assert.equal(error.message, rendered, error.messageKey);
  }
});

test("self-hosted errors use sentences that name the server themselves, in every locale", async () => {
  const selfHostedKeys = new Set(
    (await everyClassification())
      .filter((error) => error.messageParams.provider === "Your server")
      .map((error) => error.messageKey)
      .filter((key) => key.startsWith("providerErrors."))
  );
  assert.ok(selfHostedKeys.size >= 10);
  for (const key of selfHostedKeys) {
    assert.match(key, /^providerErrors\.selfHosted\./);
    for (const locale of LOCALES) {
      const sentence = lookup(require(`../../src/locales/${locale}/translation.json`), key);
      assert.equal(typeof sentence, "string", `${locale}: ${key}`);
      // A substituted name can't take the case or article each sentence needs.
      assert.doesNotMatch(sentence, /\{\{provider\}\}/, `${locale}: ${key}`);
    }
  }
});

test("a model name is inserted literally, even with $ patterns", async () => {
  const { providerHttpError } = await load();
  const error = providerHttpError({
    provider: "OpenAI",
    status: 404,
    body: "",
    model: "we$&ird-$'model",
    surface: "llm",
  });
  assert.equal(error.message, "OpenAI doesn't recognize the model “we$&ird-$'model”.");
});
