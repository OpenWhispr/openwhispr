const {
  classifyTransportError,
  classifyHttpStatus,
  classifyProviderError,
  transportErrorCode,
  retryAfterMs,
} = require("./deliveryClassifier");

const SLACK_API_BASE = "https://slack.com/api/";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 5000;

// chat.postMessage error codes Slack documents as refusals made before
// anything is posted. The first eight are the spec's list; the rest are auth,
// channel-state and argument refusals from the same table. Every other
// ok:false code (internal_error, fatal_error, codes added later) may follow a
// partial success, so it stays "unknown".
const SLACK_PRE_SEND_REJECTIONS = new Set([
  "channel_not_found",
  "not_in_channel",
  "invalid_auth",
  "not_authed",
  "missing_scope",
  "no_text",
  "msg_too_long",
  "ratelimited",
  "token_expired",
  "token_revoked",
  "account_inactive",
  "is_archived",
  "restricted_action",
  "restricted_action_read_only_channel",
  "ekm_access_denied",
  "markdown_text_conflict",
  "invalid_arguments",
  "rate_limited",
]);

function createSlackApi({
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  async function once(method, params, token) {
    // Slack warns "superfluous_charset" when a form body names a charset.
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${SLACK_API_BASE}${method}`, {
        method: "POST",
        headers,
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        source: "network",
        outcome: classifyTransportError(error),
        errorCode: transportErrorCode(error),
      };
    }
    // A 429 means Slack did not act.
    if (response.status === 429) {
      return {
        ok: false,
        source: "http",
        status: 429,
        outcome: "failed",
        errorCode: "rate_limited",
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    }
    const httpOutcome = classifyHttpStatus(response.status);
    if (httpOutcome !== "ok") {
      return {
        ok: false,
        source: "http",
        status: response.status,
        outcome: httpOutcome,
        errorCode: `http_${response.status}`,
      };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      return {
        ok: false,
        source: "http",
        status: response.status,
        outcome: "unknown",
        errorCode: "bad_response",
      };
    }
    if (data.ok === true) return { ok: true, data };
    const code = typeof data.error === "string" ? data.error : "unknown_error";
    return {
      ok: false,
      source: "slack",
      status: response.status,
      outcome: classifyProviderError(code, SLACK_PRE_SEND_REJECTIONS),
      errorCode: code,
    };
  }

  // One retry, only for a 429 that asks for 5 s or less: Slack refused the
  // first request, so repeating it cannot post twice.
  async function call(method, params = {}, { token } = {}) {
    const first = await once(method, params, token);
    const retryAfter = first.ok ? null : first.retryAfterMs;
    if (typeof retryAfter === "number" && retryAfter <= MAX_RETRY_AFTER_MS) {
      await sleep(retryAfter);
      return once(method, params, token);
    }
    return first;
  }

  return { call };
}

module.exports = { createSlackApi, SLACK_PRE_SEND_REJECTIONS, MAX_RETRY_AFTER_MS };
