// GitHub's REST API and its device-flow login endpoints, with spec §6.3's
// failed/unknown classification. `failed` needs evidence that GitHub did not
// act; anything that may have reached GitHub and created an issue or comment
// is `unknown`, because GitHub has no idempotency key and a retry could post
// twice.
const {
  classifyTransportError,
  classifyHttpStatus,
  transportErrorCode,
  retryAfterMs,
} = require("./deliveryClassifier");
const { isPlainObject, readJson, formBody } = require("./providerHttp");

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "OpenWhispr";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 5000;
const FORM = "application/x-www-form-urlencoded";

// Unverified until plan Task 3: GitHub documents that a secondary rate limit
// answers 403 or 429 with a message naming it, sometimes without retry-after
// or x-ratelimit-* headers, and says to wait at least a minute then.
const SECONDARY_RATE_LIMIT_MESSAGE = /secondary rate limit/i;
const SECONDARY_RATE_LIMIT_WAIT_MS = 60 * 1000;

// Statuses whose meaning is the same on every endpoint the connector calls.
// All of them are GitHub refusing the request before acting.
const STATUS_CODES = new Map([
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [410, "issues_disabled"],
  [422, "invalid"],
]);

// A throttled or timed-out OAuth request can pass whatever its body says, and
// so can the OAuth errors that mean "ask again later" (RFC 6749 §5.2 and
// §4.1.2.1): none of them is a verdict on the login or the device code.
const TRANSIENT_OAUTH_STATUSES = new Set([408, 429]);
const TRANSIENT_OAUTH_ERRORS = new Set(["temporarily_unavailable", "server_error"]);

// Waits `ms`, or less when `signal` aborts first. Never rejects: the caller
// checks the signal afterwards.
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function transportFailure(error) {
  return {
    ok: false,
    outcome: classifyTransportError(error),
    errorCode: transportErrorCode(error),
  };
}

// The URL of a Link header's rel="next" entry, or null.
function nextLink(header) {
  if (typeof header !== "string") return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match && match[2].split(/\s+/).includes("next")) return match[1];
  }
  return null;
}

function createGithubApi({
  fetchImpl,
  sleep = abortableSleep,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  async function send(url, init, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      return { response };
    } catch (error) {
      return { response: null, failure: transportFailure(error) };
    }
  }

  // How long a rate-limited answer asks us to wait, or null when the answer
  // isn't a rate limit. retry-after wins over x-ratelimit-reset (GitHub's
  // documented order).
  function rateLimitWaitMs(status, headers, body) {
    if (status !== 403 && status !== 429) return null;
    const retryAfter = retryAfterMs(headers.get("retry-after"));
    if (retryAfter !== null) return retryAfter;
    if (headers.get("x-ratelimit-remaining") === "0") {
      const resetSeconds = Number(headers.get("x-ratelimit-reset"));
      return Number.isFinite(resetSeconds) && resetSeconds > 0
        ? Math.max(0, resetSeconds * 1000 - now())
        : SECONDARY_RATE_LIMIT_WAIT_MS;
    }
    const message = isPlainObject(body) && typeof body.message === "string" ? body.message : "";
    if (status === 429 || SECONDARY_RATE_LIMIT_MESSAGE.test(message)) {
      return SECONDARY_RATE_LIMIT_WAIT_MS;
    }
    return null;
  }

  async function restOnce(method, url, { token, body, signal }) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const { response, failure } = await send(url, init, signal);
    if (!response) return failure;
    const { status } = response;
    if (status >= 200 && status < 300) {
      const responseHeaders = Object.fromEntries(response.headers.entries());
      if (status === 204) return { ok: true, data: null, status, headers: responseHeaders };
      const data = await readJson(response);
      return data !== null && typeof data === "object"
        ? { ok: true, data, status, headers: responseHeaders }
        : { ok: false, outcome: "unknown", errorCode: "bad_response", status };
    }
    const errorBody = await readJson(response);
    const waitMs = rateLimitWaitMs(status, response.headers, errorBody);
    if (waitMs !== null) {
      // GitHub refused the request, so it acted on nothing.
      return {
        ok: false,
        outcome: "failed",
        errorCode: "rate_limited",
        status,
        retryAfterMs: waitMs,
      };
    }
    if (STATUS_CODES.has(status)) {
      return { ok: false, outcome: "failed", errorCode: STATUS_CODES.get(status), status };
    }
    return { ok: false, outcome: classifyHttpStatus(status), errorCode: `http_${status}`, status };
  }

  // One retry, only for a rate limit that asks for 5 s or less: GitHub
  // refused the first request, so repeating it cannot post twice.
  async function restWithRetry(method, url, options) {
    const first = await restOnce(method, url, options);
    if (
      !first.ok &&
      typeof first.retryAfterMs === "number" &&
      first.retryAfterMs <= MAX_RETRY_AFTER_MS
    ) {
      await sleep(first.retryAfterMs, options.signal);
      // Cancelled while waiting: the same answer as a request it cut short.
      if (options.signal?.aborted) return transportFailure(options.signal.reason);
      return restOnce(method, url, options);
    }
    return first;
  }

  // `path` is always a literal API path ("/user/installations"). Anything
  // else could send the token to another host.
  function rest(method, path, { token, query, body, signal } = {}) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new TypeError("githubApi.rest needs a path that starts with a single /");
    }
    const search = query ? formBody(query) : "";
    const url = `${GITHUB_API_BASE}${path}${search ? `?${search}` : ""}`;
    return restWithRetry(method, url, { token, body, signal });
  }

  // Every page of a list endpoint, following Link rel="next" for up to
  // `maxPages` pages. The list is the body itself, or `body[key]`.
  async function restAll(path, { token, query, key, maxPages = 10, signal } = {}) {
    const items = [];
    let result = await rest("GET", path, { token, query, signal });
    for (let page = 1; ; page += 1) {
      if (!result.ok) return result;
      const list = key ? result.data?.[key] : result.data;
      if (!Array.isArray(list)) {
        return { ok: false, outcome: "unknown", errorCode: "bad_response", status: result.status };
      }
      items.push(...list);
      const next = nextLink(result.headers.link);
      if (!next) return { ok: true, items, truncated: false, status: result.status };
      // GitHub's own links stay on api.github.com; any other host would
      // receive the token.
      if (!next.startsWith(`${GITHUB_API_BASE}/`)) {
        return { ok: false, outcome: "unknown", errorCode: "bad_response", status: result.status };
      }
      if (page >= maxPages) return { ok: true, items, truncated: true, status: result.status };
      result = await restWithRetry("GET", next, { token, signal });
    }
  }

  // errorCode is GitHub's OAuth `error` when the body has one. GitHub answers
  // these with HTTP 200, so a 2xx is only a success without `error`.
  // error_description is never kept.
  async function oauthPost(url, params, signal) {
    const { response, failure } = await send(
      url,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": FORM, "User-Agent": USER_AGENT },
        body: formBody(params),
      },
      signal
    );
    if (!response) return failure;
    const body = await readJson(response);
    const { status } = response;
    // A 429 is a throttle whatever its body says: asking again at once only
    // prolongs it, so callers wait instead of retrying.
    const rateLimited = status === 429 ? { rateLimited: true } : {};
    const oauthError = isPlainObject(body) && typeof body.error === "string" ? body.error : "";
    if (oauthError) {
      const outcome = status >= 500 ? "unknown" : "failed";
      const interval = Number(body.interval);
      const transient =
        TRANSIENT_OAUTH_STATUSES.has(status) || TRANSIENT_OAUTH_ERRORS.has(oauthError);
      return {
        ok: false,
        outcome,
        errorCode: oauthError,
        // GitHub answered and said no, as opposed to a network failure, an
        // outage or a throttle, which may pass (gmailApi's `refused`).
        ...(outcome === "failed" && !transient ? { refused: true } : {}),
        ...rateLimited,
        // slow_down carries GitHub's new minimum interval, in seconds.
        ...(Number.isFinite(interval) && interval > 0 ? { intervalMs: interval * 1000 } : {}),
      };
    }
    if (status >= 200 && status < 300) {
      return isPlainObject(body)
        ? { ok: true, data: body }
        : { ok: false, outcome: "unknown", errorCode: "bad_response" };
    }
    return {
      ok: false,
      outcome: classifyHttpStatus(status),
      errorCode: `http_${status}`,
      ...rateLimited,
    };
  }

  // `signal` lets a cancelled connect end a request that is in flight.
  function deviceCode(params, { signal } = {}) {
    return oauthPost(GITHUB_DEVICE_CODE_URL, params, signal);
  }

  function accessToken(params, { signal } = {}) {
    return oauthPost(GITHUB_ACCESS_TOKEN_URL, params, signal);
  }

  return { rest, restAll, deviceCode, accessToken };
}

module.exports = {
  createGithubApi,
  abortableSleep,
  GITHUB_API_BASE,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_API_VERSION,
  MAX_RETRY_AFTER_MS,
  SECONDARY_RATE_LIMIT_MESSAGE,
  SECONDARY_RATE_LIMIT_WAIT_MS,
};
