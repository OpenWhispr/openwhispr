// GitHub replies for the GitHub connector tests. The shapes follow GitHub's
// REST and device-flow documentation and the responses recorded in plan
// Task 3; ids, logins, codes and tokens are synthetic. Never paste a real
// token, id, login or repository name here.
//
// Assumptions Task 3 checks against the dev App (change the reply here, not
// the classification, when a recording differs):
// - rateLimited(): a primary limit is a 403 or 429 with
//   x-ratelimit-remaining "0" and x-ratelimit-reset in epoch seconds.
// - SECONDARY_RATE_LIMIT_BODY: a secondary limit's message names a
//   "secondary rate limit", with or without retry-after.
// - httpStatus(): REST errors are { message, documentation_url }.
// - OAuth errors (authorization_pending, slow_down, expired_token,
//   access_denied, bad_refresh_token, …) come back with HTTP 200.
const { NOW, memoryCredentials } = require("./slackFixtures");

const FORM = "application/x-www-form-urlencoded";
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const FIXTURES = {
  // POST https://github.com/login/device/code
  deviceCode: {
    device_code: "dc-test-1",
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  },
  // POST https://github.com/login/oauth/access_token, for the device code
  // and for a refresh (a refresh rotates the refresh token).
  token: {
    access_token: "ghu-1",
    expires_in: 28800,
    refresh_token: "ghr-1",
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
    scope: "",
  },
  refreshed: {
    access_token: "ghu-2",
    expires_in: 28800,
    refresh_token: "ghr-2",
    refresh_token_expires_in: 15897600,
    token_type: "bearer",
    scope: "",
  },
  // GET /user (only the fields the connector reads, plus a few it ignores).
  user: { id: 42, login: "dana", type: "User", name: "Dana Test" },
};

// A GitHub login as githubAuth saves it (plan Task 6). Pass it to
// memoryCredentials(CONNECTED, { connectorId: "github" }).
const CONNECTED = {
  accessToken: "ghu-1",
  refreshToken: "ghr-1",
  expiresAt: NOW + 60 * 60 * 1000,
  refreshExpiresAt: NOW + 15552000000,
  userId: 42,
  login: "dana",
  needsReconnect: false,
};

// What a pending GitHub action carries for CONNECTED in its slot at generation 1.
const BINDING = { ownerAccountId: "acct-1", accountId: "42", generation: 1 };

// A scripted GitHub: each "<METHOD> <pathname>" answers with its queued
// replies in order, and the last reply repeats. REST paths are on
// api.github.com ("GET /search/issues"); the OAuth ones on github.com
// ("POST /login/device/code", "POST /login/oauth/access_token").
function fakeGithubFetch(script) {
  const calls = [];
  const queues = new Map(Object.entries(script).map(([key, replies]) => [key, [...replies]]));
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const contentType = headers["Content-Type"] ?? null;
    calls.push({
      method,
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      form: contentType === FORM ? Object.fromEntries(new URLSearchParams(init.body)) : null,
      json: contentType === "application/json" ? JSON.parse(init.body) : null,
      authorization: headers.Authorization ?? null,
      headers,
    });
    const key = `${method} ${parsed.pathname}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) throw new Error(`unscripted GitHub call: ${key}`);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    // Lets a test change state while this request is in flight.
    if (typeof reply.during === "function") reply.during();
    if (reply.throw) throw reply.throw;
    if (reply.hang) {
      // Never answers: ends only when the request's signal aborts (a timeout
      // after the request was written, or a cancelled poll).
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    }
    const status = reply.status ?? 200;
    // A Response for 204 or 304 must have no body at all.
    const text = NULL_BODY_STATUSES.has(status)
      ? null
      : (reply.rawBody ?? JSON.stringify(reply.body ?? {}));
    return new Response(text, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...(reply.headers ?? {}) },
    });
  };
  return {
    fetchImpl,
    calls,
    requests: () => calls.map((call) => `${call.method} ${call.path}`),
  };
}

const json = (body, status = 200, headers = {}) => ({ body, status, headers });

// GitHub's REST error body: { message, documentation_url }.
const httpStatus = (status, headers = {}, message = "Synthetic error") => ({
  status,
  headers,
  body: { message, documentation_url: "https://docs.github.com/rest" },
});

// An OAuth error as GitHub's login endpoints return it: HTTP 200 with an
// `error` field. `extra` carries e.g. slow_down's new `interval` (seconds).
const oauthError = (error, extra = {}) => ({
  status: 200,
  body: {
    error,
    error_description: "Synthetic description",
    error_uri: "https://docs.github.com/developers/apps",
    ...extra,
  },
});

const SECONDARY_RATE_LIMIT_BODY = "You have exceeded a secondary rate limit. Please wait.";

// A rate-limited reply. Primary (default): x-ratelimit-remaining "0" and a
// reset `resetIn` seconds after NOW. Secondary: pass `retryAfter` (seconds)
// for a retry-after header, or `secondary: true` for the message alone.
function rateLimited({ status = 403, resetIn = 60, retryAfter, secondary = false } = {}) {
  if (retryAfter !== undefined || secondary) {
    return {
      status,
      headers: retryAfter !== undefined ? { "retry-after": String(retryAfter) } : {},
      body: { message: SECONDARY_RATE_LIMIT_BODY, documentation_url: "https://docs.github.com" },
    };
  }
  return {
    status,
    headers: {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-used": "5000",
      "x-ratelimit-reset": String(Math.floor(NOW / 1000) + resetIn),
      "x-ratelimit-resource": "core",
    },
    body: {
      message: "API rate limit exceeded for user ID 42.",
      documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
    },
  };
}

const reset = () => ({ throw: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const offline = () => ({
  throw: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }),
});
const hang = () => ({ hang: true });

module.exports = {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  SECONDARY_RATE_LIMIT_BODY,
  fakeGithubFetch,
  json,
  httpStatus,
  oauthError,
  rateLimited,
  reset,
  offline,
  hang,
  memoryCredentials,
};
