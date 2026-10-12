// ESM like emailCompose.js: imported by the renderer and loaded by the main
// process through require(esm). Pure on purpose (no electron, no logger) so
// both sides classify a provider failure the same way.

import { LLM_REQUEST_TIMEOUT_CODE } from "./llmRequestTimeout.js";

export const PROVIDER_ERROR_CODES = Object.freeze({
  AUTH_FAILED: "PROVIDER_AUTH_FAILED",
  ACCESS_DENIED: "PROVIDER_ACCESS_DENIED",
  QUOTA_EXHAUSTED: "PROVIDER_QUOTA_EXHAUSTED",
  RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  MODEL_NOT_FOUND: "PROVIDER_MODEL_NOT_FOUND",
  PAYLOAD_TOO_LARGE: "PROVIDER_PAYLOAD_TOO_LARGE",
  BAD_REQUEST: "PROVIDER_BAD_REQUEST",
  UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  TIMEOUT: "PROVIDER_TIMEOUT",
  UNREACHABLE: "PROVIDER_UNREACHABLE",
  NO_RESPONSE: "PROVIDER_NO_RESPONSE",
  ERROR: "PROVIDER_ERROR",
  KEY_MISSING: "API_KEY_MISSING",
});

const C = PROVIDER_ERROR_CODES;

const PROVIDER_SETTINGS_TARGETS = Object.freeze(["speechToText", "llms"]);

export const isProviderSettingsTarget = (value) => PROVIDER_SETTINGS_TARGETS.includes(value);

const SETTINGS_TARGET_BY_SURFACE = { transcription: "speechToText", llm: "llms" };

// Only failures the user fixes in Settings get the deep link.
const FIXABLE = new Set([
  C.AUTH_FAILED,
  C.ACCESS_DENIED,
  C.QUOTA_EXHAUSTED,
  C.MODEL_NOT_FOUND,
  C.NO_RESPONSE,
  C.KEY_MISSING,
]);

const MESSAGE_KEYS = {
  [C.AUTH_FAILED]: "providerErrors.authFailed",
  [C.ACCESS_DENIED]: "providerErrors.accessDenied",
  [C.QUOTA_EXHAUSTED]: "providerErrors.quotaExhausted",
  [C.RATE_LIMITED]: "hooks.audioRecording.errorDescriptions.providerRateLimited",
  [C.MODEL_NOT_FOUND]: "providerErrors.modelNotFound",
  [C.PAYLOAD_TOO_LARGE]: "providerErrors.payloadTooLarge",
  [C.BAD_REQUEST]: "providerErrors.badRequest",
  [C.UNAVAILABLE]: "providerErrors.unavailable",
  [C.TIMEOUT]: "providerErrors.timeout",
  [C.UNREACHABLE]: "providerErrors.unreachable",
  [C.NO_RESPONSE]: "providerErrors.noResponse",
  [C.ERROR]: "providerErrors.unknown",
};

// English twins of the en locale strings, by message key: Error.message is what
// History rows, logs and key-less surfaces show, so it reads as a sentence, not
// a status dump. The transcription-only hooks keys say "your transcription
// provider"; their twins name it, since History has no other place to.
const ENGLISH = {
  "providerErrors.authFailed": "{{provider}} rejected your API key.",
  "providerErrors.accessDenied": "{{provider}} denied access. Your key may not include this model.",
  "providerErrors.quotaExhausted": "Your {{provider}} account is out of credit.",
  "providerErrors.rateLimited":
    "{{provider}} rate-limited the request. Wait a moment and try again.",
  "providerErrors.modelNotFound": "{{provider}} doesn't recognize the model “{{model}}”.",
  "providerErrors.modelNotFoundNoModel": "{{provider}} doesn't recognize the selected model.",
  "providerErrors.payloadTooLarge": "This recording is too large for {{provider}}.",
  "providerErrors.requestTooLarge": "This request is too large for {{provider}}.",
  "providerErrors.badRequest": "{{provider}} couldn't process this request.",
  "providerErrors.unavailable": "{{provider}} is having problems right now. Try again shortly.",
  "providerErrors.timeout": "{{provider}} took too long to respond.",
  "providerErrors.unreachable": "Couldn't reach {{provider}}. Check your connection.",
  "providerErrors.noResponse":
    "Couldn't get a response from {{provider}}. Check your API key and connection.",
  "providerErrors.unknown": "{{provider}} returned an unexpected error.",
  "providerErrors.keyMissing":
    "No API key is set for {{provider}}. Add it in Settings → Language Models.",
  "providerErrors.selfHosted.authFailed": "Your server rejected the API key.",
  "providerErrors.selfHosted.accessDenied":
    "Your server denied access. The key may not include this model.",
  "providerErrors.selfHosted.quotaExhausted": "Your server says the account is out of credit.",
  "providerErrors.selfHosted.rateLimited":
    "Your server rate-limited the request. Wait a moment and try again.",
  "providerErrors.selfHosted.modelNotFound": "Your server doesn't recognize the model “{{model}}”.",
  "providerErrors.selfHosted.modelNotFoundNoModel":
    "Your server doesn't recognize the selected model.",
  "providerErrors.selfHosted.payloadTooLarge": "This recording is too large for your server.",
  "providerErrors.selfHosted.requestTooLarge": "This request is too large for your server.",
  "providerErrors.selfHosted.badRequest": "Your server couldn't process this request.",
  "providerErrors.selfHosted.unavailable":
    "Your server is having problems right now. Try again shortly.",
  "providerErrors.selfHosted.timeout": "Your server took too long to respond.",
  "providerErrors.selfHosted.unreachable": "Couldn't reach your server. Check that it's running.",
  "providerErrors.selfHosted.noResponse":
    "Couldn't get a response from your server. Check its API key and that it's running.",
  "providerErrors.selfHosted.unknown": "Your server returned an unexpected error.",
  "hooks.audioRecording.errorDescriptions.providerRateLimited":
    "{{provider}} rate-limited the request. Wait a moment and try again.",
  "hooks.audioRecording.errorDescriptions.providerKeyMissing":
    "No API key is set for {{provider}}.",
};

export const SELF_HOSTED_NAME = "Your server";

const INVALID_KEY_SIGNAL =
  /invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|api_key_invalid|authentication_error|unauthorized/i;
// Only signals that mean the account is out of credit. Rate-limit 429s use the
// broader words: Gemini's starts "You exceeded your current quota, please check
// your plan and billing details" and Groq's links to its /settings/billing page.
const QUOTA_SIGNAL =
  /insufficient_quota|credit balance|insufficient (credits|balance|funds)|out of credits|payment required/i;
const MODEL_SIGNAL =
  /model_not_found|model[^.\n]{0,80}(not found|does not exist|not available|is not supported)|(unknown|invalid|unsupported) model/i;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
]);

// Electron's net.fetch rejects with a plain Error whose message is the
// Chromium net error (no code). ERR_ABORTED is a cancellation, never a failure.
const ELECTRON_NET_ERROR = /net::ERR_[A-Z_]+/;
const ELECTRON_NET_TIMEOUTS = new Set(["net::ERR_TIMED_OUT", "net::ERR_CONNECTION_TIMED_OUT"]);

function electronNetError(err) {
  const match = typeof err.message === "string" ? err.message.match(ELECTRON_NET_ERROR) : null;
  return match && match[0] !== "net::ERR_ABORTED" ? match[0] : null;
}

const MAX_DETAIL_CHARS = 500;

const SECRET_PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [redacted]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_*.-]{4,}/g, "[redacted]"],
  [/\bgsk_[A-Za-z0-9*]{4,}/g, "[redacted]"],
  [/\bAIza[A-Za-z0-9_-]{4,}/g, "[redacted]"],
  [/\bxai-[A-Za-z0-9*]{4,}/g, "[redacted]"],
];

function bodyToText(body) {
  if (body == null) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

export function redactProviderBody(body) {
  let text = bodyToText(body);
  if (/<\s*(!doctype|html|body|head)\b/i.test(text)) return "<HTML response>";
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) || undefined;
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match ? headers[match] : undefined;
}

function requestIdFrom(headers) {
  return (
    readHeader(headers, "x-request-id") ||
    readHeader(headers, "request-id") ||
    readHeader(headers, "cf-ray")
  );
}

function codeForStatus(status, text, selfHosted) {
  if (status === 401) return C.AUTH_FAILED;
  if ((status === 400 || status === 403) && INVALID_KEY_SIGNAL.test(text)) return C.AUTH_FAILED;
  if (status === 402) return C.QUOTA_EXHAUSTED;
  if ([400, 403, 429].includes(status) && QUOTA_SIGNAL.test(text)) return C.QUOTA_EXHAUSTED;
  if (status === 403) return C.ACCESS_DENIED;
  if (status === 429) return C.RATE_LIMITED;
  if (status === 404) {
    // A self-hosted 404 is far more often a wrong URL than a wrong model.
    return selfHosted && !MODEL_SIGNAL.test(text) ? C.ERROR : C.MODEL_NOT_FOUND;
  }
  if (status === 400 && MODEL_SIGNAL.test(text)) return C.MODEL_NOT_FOUND;
  if (status === 413) return C.PAYLOAD_TOO_LARGE;
  if ([400, 415, 422].includes(status)) return C.BAD_REQUEST;
  if (status === 408 || status === 504) return C.TIMEOUT;
  if (status >= 500 && status < 600) return C.UNAVAILABLE;
  return C.ERROR;
}

function buildClassification(code, { provider, model, surface, selfHosted, technicalDetails }) {
  const providerName = selfHosted ? SELF_HOSTED_NAME : provider;
  const messageParams = { provider: providerName };
  let messageKey = MESSAGE_KEYS[code];
  if (code === C.MODEL_NOT_FOUND) {
    if (model) messageParams.model = model;
    else messageKey = "providerErrors.modelNotFoundNoModel";
  }
  if (code === C.KEY_MISSING) {
    messageKey =
      surface === "transcription"
        ? "hooks.audioRecording.errorDescriptions.providerKeyMissing"
        : "providerErrors.keyMissing";
  }
  if (surface === "llm") {
    // The transcription keys are the dictation pill's established copy; LLM
    // surfaces name the provider and send text, not a recording.
    if (code === C.RATE_LIMITED) messageKey = "providerErrors.rateLimited";
    if (code === C.PAYLOAD_TOO_LARGE) messageKey = "providerErrors.requestTooLarge";
  }
  // "Your server" takes a different case or article in each sentence in many
  // languages (Russian, German), so self-hosted errors have their own sentences.
  if (selfHosted && messageKey.startsWith("providerErrors.")) {
    messageKey = messageKey.replace("providerErrors.", "providerErrors.selfHosted.");
  }
  const settingsTarget = FIXABLE.has(code) ? SETTINGS_TARGET_BY_SURFACE[surface] : undefined;
  return {
    code,
    messageKey,
    messageParams,
    surface,
    ...(settingsTarget ? { settingsTarget } : {}),
    technicalDetails: { provider: providerName, ...(technicalDetails || {}) },
  };
}

function englishMessage({ messageKey, messageParams }) {
  return ENGLISH[messageKey].replace(/\{\{(\w+)\}\}/g, (_, name) => messageParams[name] ?? "");
}

function toError(classification, extra = {}) {
  return Object.assign(new Error(englishMessage(classification)), classification, extra);
}

export function providerHttpError(args) {
  const { provider, status, body, headers, model, surface, selfHosted = false } = args;
  const text = bodyToText(body);
  const underlyingError = redactProviderBody(text);
  const requestId = requestIdFrom(headers);
  return toError(
    buildClassification(codeForStatus(status, text, selfHosted), {
      provider,
      model,
      surface,
      selfHosted,
      technicalDetails: {
        status,
        ...(requestId ? { requestId } : {}),
        ...(underlyingError ? { underlyingError } : {}),
      },
    }),
    { status }
  );
}

export function providerError(code, ctx) {
  return toError(buildClassification(code, ctx), { provider: ctx.provider });
}

export function asProviderError(err, ctx) {
  if (!err || typeof err !== "object" || err.messageKey || err.name === "AbortError") return err;
  const inner = err.name === "AI_RetryError" && err.lastError ? err.lastError : err;
  const netError = electronNetError(inner);
  const nodeCode = [inner.code, inner.cause?.code].find((code) => NETWORK_CODES.has(code));
  let classified = null;
  if (typeof inner.statusCode === "number") {
    classified = providerHttpError({
      ...ctx,
      status: inner.statusCode,
      body: inner.responseBody ?? inner.message,
      headers: inner.responseHeaders,
    });
  } else if (inner.code === LLM_REQUEST_TIMEOUT_CODE || inner.name === "TimeoutError") {
    classified = providerError(C.TIMEOUT, ctx);
  } else if (netError) {
    classified = providerError(ELECTRON_NET_TIMEOUTS.has(netError) ? C.TIMEOUT : C.UNREACHABLE, {
      ...ctx,
      technicalDetails: { underlyingError: netError },
    });
  } else if (
    nodeCode ||
    (inner instanceof TypeError && /fetch failed|network/i.test(inner.message))
  ) {
    classified = providerError(C.UNREACHABLE, {
      ...ctx,
      ...(nodeCode ? { technicalDetails: { underlyingError: nodeCode } } : {}),
    });
  } else if (inner instanceof TypeError && /failed to fetch/i.test(inner.message)) {
    // Chromium's fetch also reports a CORS-blocked HTTP error this way (OpenAI
    // answers a bad sk- key with a 401 that has no CORS header), so online it
    // may be the key. Main never sees this message.
    classified = providerError(
      globalThis.navigator?.onLine === false ? C.UNREACHABLE : C.NO_RESPONSE,
      ctx
    );
  }
  if (!classified) return err;
  classified.cause = err;
  return classified;
}
