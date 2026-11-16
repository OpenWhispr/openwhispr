// Linear's GraphQL API and its OAuth token and revoke endpoints, with the
// Linear spec §6.3 classification. `failed` needs evidence that Linear did
// not act; anything that may have reached Linear and changed something is
// `unknown`, because a lookup that misses proves nothing and a retry could
// post it twice.
//
// Every value marked "Checked live" was confirmed against a real Linear
// workspace. Each lives in one constant, so a change on Linear's side
// changes a constant, not the logic.
const { classifyHttpStatus, retryAfterMs } = require("./deliveryClassifier");
const { isPlainObject, readJson, formBody, createPost } = require("./providerHttp");

// Checked live: the endpoints.
const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRY_AFTER_MS = 5000;
const FORM = "application/x-www-form-urlencoded";

// Checked live: GraphQL error codes that mean Linear refused the
// request before acting, each with the code this module reports. An error
// answer counts as a refusal only when every error in it is listed; any
// other code may follow a partial write, so it is `unknown` (graphql_error).
// Linear reported INPUT_ERROR (not ENTITY_NOT_FOUND)
// for a missing issue and for a repeated create id, and lowercase-worded
// `extensions.type` values ("invalid input", "authentication error");
// INPUT_ERROR is reclassified by its message below (see
// INPUT_ERROR_MESSAGE_OVERRIDES) before this map is consulted.
const LINEAR_PRE_SEND_REJECTIONS = new Map([
  ["INVALID_INPUT", "invalid_input"],
  ["InvalidInput", "invalid_input"],
  ["FORBIDDEN", "forbidden"],
  ["Forbidden", "forbidden"],
  ["ENTITY_NOT_FOUND", "not_found"],
  ["EntityNotFound", "not_found"],
  ["RATELIMITED", "rate_limited"],
  ["AUTHENTICATION_ERROR", "unauthorized"],
  ["INPUT_ERROR", "invalid_input"],
  ["invalid input", "invalid_input"],
  ["authentication error", "unauthorized"],
]);
// Checked live: where an error carries its code. The first string
// found decides, so an unlisted `code` is never overridden by its `type`.
const ERROR_CODE_FIELDS = ["code", "type"];
// Checked live: Linear reports both "missing issue" and
// "the client id already exists" as INPUT_ERROR, told apart only by the
// message. A missing entity is a genuine refusal (the connector's lookups
// rely on errorCode === "not_found"); a create-id conflict means the entity already
// exists, so the create must be settled by its lookup, never reported as
// failed — an `errorCode` of null here means "not a listed refusal" (falls
// through to unknown/graphql_error), not a reported code.
const INPUT_ERROR_MESSAGE_OVERRIDES = [
  { prefix: "Entity not found", errorCode: "not_found" },
  { prefix: "conflict on insert", errorCode: null },
];
// The header that says how long to wait after a rate limit, in whole
// seconds. Without it nothing is retried and the result is rate_limited.
// Not checked live: Linear's docs describe `X-RateLimit-*-Reset` headers
// for its own limiter and may not send `Retry-After` at all, in which case
// this stays safe (no retry, rate_limited) rather than wrong.
const RETRY_AFTER_HEADER = "retry-after";
// Checked live: how a token is revoked: in the form body, as Linear's docs
// describe (a bearer header is their legacy form).
function revokeRequest(token) {
  return {
    headers: { "Content-Type": FORM },
    body: new URLSearchParams({ token }).toString(),
  };
}
// A throttled or timed-out token request can pass whatever its body says, so
// it is never a verdict on the login.
const TRANSIENT_TOKEN_STATUSES = new Set([408, 429]);

// The listed field value ("code", else "type") found on this error, or
// undefined if neither is a non-empty string.
function fieldValue(extensions) {
  return ERROR_CODE_FIELDS.map((field) => extensions[field]).find(
    (candidate) => typeof candidate === "string" && candidate
  );
}

// The reported code for this error, or null when it is not a listed refusal.
function codeOf(error) {
  const extensions = isPlainObject(error?.extensions) ? error.extensions : {};
  const field = fieldValue(extensions);
  if (field === undefined) return null;
  if (field === "INPUT_ERROR") {
    const message = typeof error?.message === "string" ? error.message : "";
    const override = INPUT_ERROR_MESSAGE_OVERRIDES.find((entry) =>
      message.startsWith(entry.prefix)
    );
    if (override) return override.errorCode;
  }
  return LINEAR_PRE_SEND_REJECTIONS.has(field) ? LINEAR_PRE_SEND_REJECTIONS.get(field) : null;
}

// The reported code when every error is a listed refusal, else null.
function rejectionOf(errors) {
  const codes = errors.map(codeOf);
  return codes.every(Boolean) ? codes[0] : null;
}

// A 200 can carry data beside its errors (a partial success), e.g. an
// issueCreate that succeeded while one of its fields failed to resolve.
function hasPartialData(body) {
  return (
    isPlainObject(body?.data) &&
    Object.values(body.data).some((value) => value !== null && value !== undefined)
  );
}

function createLinearApi({
  fetchImpl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const post = createPost({ fetchImpl, timeoutMs });

  async function graphqlOnce(query, variables, token) {
    const { response, failure } = await post(
      LINEAR_GRAPHQL_URL,
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ query, variables })
    );
    if (!response) return failure;
    const { status } = response;
    const httpOutcome = classifyHttpStatus(status);
    // A 5xx may come after Linear acted, whatever its body says.
    if (httpOutcome === "unknown") {
      return { ok: false, outcome: "unknown", errorCode: `http_${status}`, status };
    }
    const body = await readJson(response);
    const errors =
      isPlainObject(body) && Array.isArray(body.errors) && body.errors.length > 0
        ? body.errors
        : null;
    const rejection = errors ? rejectionOf(errors) : null;
    const failed = (errorCode) => ({ ok: false, outcome: "failed", errorCode, status });
    // A rate limit (HTTP 429 or RATELIMITED) and a refused token (401, or
    // AUTHENTICATION_ERROR through the list) mean Linear did nothing.
    if (status === 429 || rejection === "rate_limited") {
      return {
        ...failed("rate_limited"),
        retryAfterMs: retryAfterMs(response.headers.get(RETRY_AFTER_HEADER)),
      };
    }
    if (status === 401) return failed("unauthorized");
    if (httpOutcome === "failed") return failed(rejection ?? `http_${status}`);
    // Listed errors beside data may follow a write, so they are unknown.
    if (errors) {
      return rejection && !hasPartialData(body)
        ? failed(rejection)
        : { ok: false, outcome: "unknown", errorCode: "graphql_error", status };
    }
    if (!isPlainObject(body) || !isPlainObject(body.data)) {
      return { ok: false, outcome: "unknown", errorCode: "bad_response", status };
    }
    return { ok: true, data: body.data };
  }

  // One retry, only for a rate limit that asks for 5 s or less: Linear
  // refused the first request, so repeating it can't act twice.
  async function graphql(query, variables = {}, { token } = {}) {
    // No request without a token: Linear would only refuse it.
    if (typeof token !== "string" || token === "") {
      return { ok: false, outcome: "failed", errorCode: "unauthorized" };
    }
    const first = await graphqlOnce(query, variables ?? {}, token);
    if (
      !first.ok &&
      first.errorCode === "rate_limited" &&
      typeof first.retryAfterMs === "number" &&
      first.retryAfterMs <= MAX_RETRY_AFTER_MS
    ) {
      await sleep(first.retryAfterMs);
      return graphqlOnce(query, variables ?? {}, token);
    }
    return first;
  }

  // errorCode is Linear's OAuth `error` when the body has one (invalid_grant,
  // invalid_client, …), else http_<status>; error_description is never kept.
  async function tokenRequest(params) {
    const { response, failure } = await post(
      LINEAR_TOKEN_URL,
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
      // Linear answered and said no (a 4xx with an OAuth error), as opposed
      // to a network failure or an outage, which may pass.
      ...(oauthError && outcome === "failed" && !TRANSIENT_TOKEN_STATUSES.has(response.status)
        ? { refused: true }
        : {}),
    };
  }

  // PKCE: no client secret. The caller passes code, client_id,
  // redirect_uri and code_verifier.
  function exchangeToken(params) {
    return tokenRequest({ ...params, grant_type: "authorization_code" });
  }

  // The caller passes client_id and refresh_token.
  function refreshToken(params) {
    return tokenRequest({ ...params, grant_type: "refresh_token" });
  }

  // Best effort: never throws, and never reads the body.
  async function revokeToken(token) {
    if (typeof token !== "string" || token === "") return { ok: false };
    const { headers, body } = revokeRequest(token);
    const { response } = await post(LINEAR_REVOKE_URL, headers, body);
    return { ok: Boolean(response) && response.status >= 200 && response.status < 300 };
  }

  return { graphql, exchangeToken, refreshToken, revokeToken };
}

module.exports = {
  createLinearApi,
  LINEAR_GRAPHQL_URL,
  LINEAR_TOKEN_URL,
  LINEAR_REVOKE_URL,
  LINEAR_AUTHORIZE_URL,
  LINEAR_PRE_SEND_REJECTIONS,
  MAX_RETRY_AFTER_MS,
};
