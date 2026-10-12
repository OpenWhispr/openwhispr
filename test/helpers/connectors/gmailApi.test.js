const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fakeGoogleFetch,
  json,
  httpStatus,
  reset,
  offline,
  GOOGLE_REVOKE_OK,
} = require("./gmailFixtures");

const load = () => import("../../../src/helpers/connectors/gmailApi.js");

const SEND = "/gmail/v1/users/me/messages/send";
const TOKEN = "/token";
const REVOKE = "/revoke";
const RAW = Buffer.from("From: you@example.test\r\n\r\nSGk=").toString("base64url");

async function api(script, options = {}) {
  const { createGmailApi } = await load();
  const google = fakeGoogleFetch(script);
  const sleeps = [];
  const client = createGmailApi({
    fetchImpl: google.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client, google, sleeps };
}

async function send(script) {
  const { client, google, sleeps } = await api({ [SEND]: script });
  const result = await client.sendMessage({ accessToken: "access-1", raw: RAW });
  return { result, google, sleeps };
}

// Gmail's JSON error envelope for a 4xx with a reason code.
const gmailError = (status, reason) =>
  json(
    {
      error: {
        code: status,
        message: "Synthetic error",
        errors: [{ domain: "usageLimits", reason, message: "Synthetic error" }],
        status: "PERMISSION_DENIED",
      },
    },
    status
  );

const throwing = (error) => ({ throw: error });

test("a 200 with an id is sent: one POST with the bearer token and the raw message", async () => {
  const { GMAIL_SEND_URL } = await load();
  assert.equal(GMAIL_SEND_URL, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");

  const { result, google } = await send([
    json({ id: "msg-1", threadId: "thread-1", labelIds: ["SENT"] }),
  ]);

  assert.deepEqual(result, { ok: true, id: "msg-1", threadId: "thread-1" });
  assert.equal(google.calls.length, 1);
  assert.equal(google.calls[0].path, SEND);
  assert.equal(google.calls[0].authorization, "Bearer access-1");
  assert.deepEqual(google.calls[0].json, { raw: RAW });
});

test("a 200 without an id, or one that can't be read, is unknown and never failed", async () => {
  const replies = [
    json({}),
    json({ threadId: "thread-1" }),
    json({ id: 42 }),
    json({ id: "" }),
    json(["msg-1"]),
    { status: 200, rawBody: "<html>oops</html>" },
    { status: 200, rawBody: "" },
  ];
  for (const reply of replies) {
    const { result } = await send([reply]);
    assert.deepEqual(
      result,
      { ok: false, outcome: "unknown", errorCode: "bad_response", status: 200 },
      JSON.stringify(reply)
    );
  }
});

test("a 400 is failed invalid_message; a 401 is failed unauthorized with no retry here", async () => {
  const badRequest = await send([gmailError(400, "invalidArgument")]);
  assert.deepEqual(badRequest.result, {
    ok: false,
    outcome: "failed",
    errorCode: "invalid_message",
    status: 400,
  });

  const unauthorized = await send([httpStatus(401), json({ id: "msg-1" })]);
  assert.deepEqual(unauthorized.result, {
    ok: false,
    outcome: "failed",
    errorCode: "unauthorized",
    status: 401,
  });
  assert.equal(unauthorized.google.calls.length, 1, "the connector, not the api, retries a 401");
});

test("a 403 is failed, with its code chosen by Gmail's reason", async () => {
  const expected = {
    dailyLimitExceeded: "daily_limit",
    userRateLimitExceeded: "rate_limited",
    rateLimitExceeded: "rate_limited",
    domainPolicy: "domain_policy",
    insufficientPermissions: "reconnect_needed",
    forbidden: "refused",
    toString: "refused",
  };
  for (const [reason, errorCode] of Object.entries(expected)) {
    const { result, google } = await send([gmailError(403, reason)]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode, status: 403 }, reason);
    assert.equal(google.calls.length, 1, reason);
  }

  const unreadable = await send([{ status: 403, rawBody: "Forbidden" }]);
  assert.deepEqual(unreadable.result, {
    ok: false,
    outcome: "failed",
    errorCode: "refused",
    status: 403,
  });
});

test("other 4xx are failed; every 5xx is unknown because Gmail may have sent it", async () => {
  for (const status of [404, 409]) {
    const { result } = await send([httpStatus(status)]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode: `http_${status}`, status });
  }
  // A 413 is a message Gmail found too large, with its own copy.
  assert.deepEqual((await send([httpStatus(413)])).result, {
    ok: false,
    outcome: "failed",
    errorCode: "too_long",
    status: 413,
  });
  for (const status of [500, 502, 503, 504]) {
    const { result, google } = await send([httpStatus(status), json({ id: "msg-1" })]);
    assert.deepEqual(result, {
      ok: false,
      outcome: "unknown",
      errorCode: `http_${status}`,
      status,
    });
    assert.equal(google.calls.length, 1, `a ${status} is never retried`);
  }
});

test("no connection before the write is failed; a reset after it is unknown", async () => {
  const beforeWrite = [
    [offline(), "ENOTFOUND"],
    [
      throwing(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      "ECONNREFUSED",
    ],
    [throwing(new Error("net::ERR_INTERNET_DISCONNECTED")), "ERR_INTERNET_DISCONNECTED"],
    [throwing(new Error("net::ERR_NAME_NOT_RESOLVED")), "ERR_NAME_NOT_RESOLVED"],
  ];
  for (const [reply, errorCode] of beforeWrite) {
    const { result } = await send([reply]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode }, errorCode);
  }

  const afterWrite = [
    [reset(), "ECONNRESET"],
    [throwing(new Error("net::ERR_CONNECTION_RESET")), "ERR_CONNECTION_RESET"],
    [throwing(new Error("something odd")), "network_error"],
  ];
  for (const [reply, errorCode] of afterWrite) {
    const { result, google } = await send([reply, json({ id: "msg-1" })]);
    assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode }, errorCode);
    assert.equal(google.calls.length, 1, errorCode);
  }
});

test("a request that times out after it was written is unknown timeout", async () => {
  const { createGmailApi } = await load();
  let calls = 0;
  const client = createGmailApi({
    timeoutMs: 20,
    fetchImpl: (url, init) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    },
  });

  const result = await client.sendMessage({ accessToken: "access-1", raw: RAW });

  assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode: "timeout" });
  assert.equal(calls, 1);
});

test("a 429 asking for 5 s or less is retried once after that wait", async () => {
  const { MAX_RETRY_AFTER_MS } = await load();
  assert.equal(MAX_RETRY_AFTER_MS, 5000);

  const short = await send([httpStatus(429, { "retry-after": "2" }), json({ id: "msg-1" })]);
  assert.deepEqual(short.result, { ok: true, id: "msg-1", threadId: null });
  assert.deepEqual(short.sleeps, [2000]);
  assert.equal(short.google.calls.length, 2);

  const edge = await send([httpStatus(429, { "retry-after": "5" }), json({ id: "msg-2" })]);
  assert.equal(edge.result.ok, true);
  assert.deepEqual(edge.sleeps, [5000]);
});

test("a longer, missing or date Retry-After, or a second 429, is failed rate_limited", async () => {
  const rateLimited = { ok: false, outcome: "failed", errorCode: "rate_limited", status: 429 };
  for (const headers of [
    { "retry-after": "6" },
    {},
    { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
  ]) {
    const { result, google, sleeps } = await send([
      httpStatus(429, headers),
      json({ id: "msg-1" }),
    ]);
    assert.deepEqual(result, rateLimited, JSON.stringify(headers));
    assert.equal(google.calls.length, 1, JSON.stringify(headers));
    assert.deepEqual(sleeps, [], JSON.stringify(headers));
  }

  const twice = await send([
    httpStatus(429, { "retry-after": "1" }),
    httpStatus(429, { "retry-after": "1" }),
    json({ id: "msg-1" }),
  ]);
  assert.deepEqual(twice.result, rateLimited);
  assert.equal(twice.google.calls.length, 2);
  assert.deepEqual(twice.sleeps, [1000]);
});

test("an oversized or empty raw message is refused before any network call", async () => {
  const { MAX_RAW_BYTES } = await import("../../../src/helpers/connectors/gmailMime.js");
  const { client, google } = await api({ [SEND]: [json({ id: "msg-1" })] });

  const oversized = await client.sendMessage({
    accessToken: "access-1",
    raw: "A".repeat(MAX_RAW_BYTES + 1),
  });
  const empty = await client.sendMessage({ accessToken: "access-1", raw: "" });

  assert.deepEqual(oversized, { ok: false, outcome: "failed", errorCode: "too_long" });
  assert.deepEqual(empty, { ok: false, outcome: "failed", errorCode: "invalid_message" });
  assert.equal(google.calls.length, 0);
});

test("exchangeToken posts the params as a form to Google's token endpoint", async () => {
  const { GOOGLE_TOKEN_URL } = await load();
  assert.equal(GOOGLE_TOKEN_URL, "https://oauth2.googleapis.com/token");
  const tokens = {
    access_token: "access-2",
    expires_in: 3599,
    scope: "openid https://www.googleapis.com/auth/gmail.send",
    token_type: "Bearer",
  };
  const { client, google } = await api({ [TOKEN]: [json(tokens)] });

  const result = await client.exchangeToken({
    client_id: "client-1",
    client_secret: "secret-1",
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
    code_verifier: undefined,
  });

  assert.deepEqual(result, { ok: true, data: tokens });
  assert.deepEqual(google.calls[0].form, {
    client_id: "client-1",
    client_secret: "secret-1",
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
  });
  assert.equal(google.calls[0].authorization, null);
});

test("token endpoint failures are distinguishable: login gone, bad client, busy, 5xx, offline", async () => {
  const cases = [
    [
      json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        400
      ),
      { ok: false, outcome: "failed", errorCode: "invalid_grant", refused: true },
    ],
    [
      json({ error: "invalid_client", error_description: "The OAuth client was not found." }, 401),
      { ok: false, outcome: "failed", errorCode: "invalid_client", refused: true },
    ],
    [
      json({ error: "unauthorized_client" }, 400),
      { ok: false, outcome: "failed", errorCode: "unauthorized_client", refused: true },
    ],
    [
      json({ error: "temporarily_unavailable" }, 503),
      { ok: false, outcome: "unknown", errorCode: "temporarily_unavailable" },
    ],
    [
      { status: 500, rawBody: "<html>Server Error</html>" },
      { ok: false, outcome: "unknown", errorCode: "http_500" },
    ],
    [
      { status: 429, rawBody: "" },
      { ok: false, outcome: "failed", errorCode: "http_429" },
    ],
    [
      { status: 200, rawBody: "not json" },
      { ok: false, outcome: "unknown", errorCode: "bad_response" },
    ],
    [offline(), { ok: false, outcome: "failed", errorCode: "ENOTFOUND" }],
    [reset(), { ok: false, outcome: "unknown", errorCode: "ECONNRESET" }],
  ];
  const seen = new Set();
  for (const [reply, expected] of cases) {
    const { client } = await api({ [TOKEN]: [reply] });
    const result = await client.exchangeToken({ grant_type: "refresh_token" });
    assert.deepEqual(result, expected, JSON.stringify(reply));
    seen.add(`${result.outcome}:${result.errorCode}`);
  }
  assert.equal(seen.size, cases.length, "every failure must be told apart");
});

test("revokeToken posts the token as a form; Google's 200 is success", async () => {
  const { GOOGLE_REVOKE_URL } = await load();
  assert.equal(GOOGLE_REVOKE_URL, "https://oauth2.googleapis.com/revoke");
  const { client, google } = await api({ [REVOKE]: [GOOGLE_REVOKE_OK] });

  assert.deepEqual(await client.revokeToken("refresh-1"), { ok: true });
  assert.deepEqual(google.calls[0].form, { token: "refresh-1" });
});

test("revokeToken reports a refusal or a network error as not ok, and never throws", async () => {
  const refused = await api({ [REVOKE]: [json({ error: "invalid_token" }, 400)] });
  assert.deepEqual(await refused.client.revokeToken("access-1"), { ok: false });

  const down = await api({ [REVOKE]: [offline()] });
  assert.deepEqual(await down.client.revokeToken("refresh-1"), { ok: false });

  const serverError = await api({ [REVOKE]: [httpStatus(503)] });
  assert.deepEqual(await serverError.client.revokeToken("refresh-1"), { ok: false });

  const none = await api({ [REVOKE]: [GOOGLE_REVOKE_OK] });
  assert.deepEqual(await none.client.revokeToken(""), { ok: false });
  assert.deepEqual(await none.client.revokeToken(null), { ok: false });
  assert.equal(none.google.calls.length, 0);
});

test("the fixtures' idToken is a three-part JWT whose payload decodes back", async () => {
  const { idToken, CONNECTED, BINDING, NOW } = require("./gmailFixtures");
  const payload = { sub: "sub-1", email: "you@example.test", email_verified: true };

  const parts = idToken(payload).split(".");

  assert.equal(parts.length, 3);
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")), payload);
  assert.equal(BINDING.accountId, CONNECTED.sub);
  assert.ok(CONNECTED.expiresAt > NOW);
});
