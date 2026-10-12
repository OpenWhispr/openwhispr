// Gmail send and Google's OAuth token and revoke endpoints, with spec §6's
// failed/unknown classification. `failed` needs evidence that Google did not
// act; anything that may have reached Gmail and sent the email is `unknown`,
// because Gmail has no idempotency key and a retry could send it twice.
const { classifyHttpStatus, retryAfterMs } = require("./deliveryClassifier");
const { isPlainObject, readJson, formBody, createPost } = require("./providerHttp");
const { MAX_RAW_BYTES } = require("./gmailMime");

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 5000;
const FORM = "application/x-www-form-urlencoded";

// Gmail's 403 reasons (error.errors[0].reason) that get their own message.
// Every other 403 is a plain refusal; all of them mean nothing was sent.
const FORBIDDEN_REASONS = new Map([
  ["dailyLimitExceeded", "daily_limit"],
  ["userRateLimitExceeded", "rate_limited"],
  ["rateLimitExceeded", "rate_limited"],
  ["domainPolicy", "domain_policy"],
  ["insufficientPermissions", "reconnect_needed"],
]);

function createGmailApi({
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const post = createPost({ fetchImpl, timeoutMs });

  async function sendOnce(accessToken, raw) {
    const { response, failure } = await post(
      GMAIL_SEND_URL,
      { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      JSON.stringify({ raw })
    );
    if (!response) return { result: failure, retryAfterMs: null };
    const { status } = response;
    const failed = (errorCode) => ({ ok: false, outcome: "failed", errorCode, status });
    // A 429 means Gmail refused the request, so it sent nothing.
    if (status === 429) {
      return {
        result: failed("rate_limited"),
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    }
    const body = await readJson(response);
    let result;
    if (status >= 200 && status < 300) {
      result =
        isPlainObject(body) && typeof body.id === "string" && body.id
          ? {
              ok: true,
              id: body.id,
              threadId: typeof body.threadId === "string" ? body.threadId : null,
            }
          : { ok: false, outcome: "unknown", errorCode: "bad_response", status };
    } else if (status === 400) {
      result = failed("invalid_message");
    } else if (status === 413) {
      result = failed("too_long");
    } else if (status === 401) {
      // The connector refreshes the same login and retries once.
      result = failed("unauthorized");
    } else if (status === 403) {
      const reason = body?.error?.errors?.[0]?.reason;
      result = failed((typeof reason === "string" && FORBIDDEN_REASONS.get(reason)) || "refused");
    } else {
      result = {
        ok: false,
        outcome: classifyHttpStatus(status),
        errorCode: `http_${status}`,
        status,
      };
    }
    return { result, retryAfterMs: null };
  }

  // One retry, only for a 429 that asks for 5 s or less.
  async function sendMessage({ accessToken, raw }) {
    if (typeof raw !== "string" || raw === "") {
      return { ok: false, outcome: "failed", errorCode: "invalid_message" };
    }
    if (raw.length > MAX_RAW_BYTES) {
      return { ok: false, outcome: "failed", errorCode: "too_long" };
    }
    const first = await sendOnce(accessToken, raw);
    if (typeof first.retryAfterMs === "number" && first.retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await sleep(first.retryAfterMs);
      return (await sendOnce(accessToken, raw)).result;
    }
    return first.result;
  }

  // errorCode is Google's OAuth `error` when the body has one
  // (invalid_grant, invalid_client, …); error_description is never kept.
  async function exchangeToken(params) {
    const { response, failure } = await post(
      GOOGLE_TOKEN_URL,
      { "Content-Type": FORM },
      formBody(params)
    );
    if (!response) return failure;
    const body = await readJson(response);
    if (response.status >= 200 && response.status < 300) {
      return isPlainObject(body)
        ? { ok: true, data: body }
        : { ok: false, outcome: "unknown", errorCode: "bad_response" };
    }
    const oauthError = isPlainObject(body) && typeof body.error === "string" ? body.error : "";
    const outcome = classifyHttpStatus(response.status);
    return {
      ok: false,
      outcome,
      errorCode: oauthError || `http_${response.status}`,
      // Google answered and said no (a 4xx with an OAuth error), as opposed to
      // a network failure or an outage, which may pass.
      ...(oauthError && outcome === "failed" ? { refused: true } : {}),
    };
  }

  // Google answers a successful revoke with 200 and an empty body, so the
  // body is never parsed. Best effort: never throws.
  async function revokeToken(token) {
    if (typeof token !== "string" || token === "") return { ok: false };
    const { response } = await post(
      GOOGLE_REVOKE_URL,
      { "Content-Type": FORM },
      formBody({ token })
    );
    return { ok: Boolean(response) && response.status >= 200 && response.status < 300 };
  }

  return { sendMessage, exchangeToken, revokeToken };
}

module.exports = {
  createGmailApi,
  GMAIL_SEND_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_REVOKE_URL,
  MAX_RETRY_AFTER_MS,
};
