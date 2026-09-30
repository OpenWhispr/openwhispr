const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  fakeLinearFetch,
  gql,
  gqlError,
  httpStatus,
  reset,
  offline,
} = require("./linearFixtures");

const load = () => import("../../../src/helpers/connectors/linearApi.js");

const GRAPHQL = "/graphql";
const TOKEN = "/oauth/token";
const REVOKE = "/oauth/revoke";
const IDENTITY = "query LinearIdentity { viewer { id name } organization { id name urlKey } }";
const CREATE =
  "mutation LinearIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }";
const CREATED = { issueCreate: { success: true, issue: { id: "i-1", identifier: "ENG-1" } } };

async function api(script, options = {}) {
  const { createLinearApi } = await load();
  const linear = fakeLinearFetch(script);
  const sleeps = [];
  const client = createLinearApi({
    fetchImpl: linear.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { client, linear, sleeps };
}

// One issueCreate against a scripted answer.
async function create(replies) {
  const { client, linear, sleeps } = await api({ [GRAPHQL]: { LinearIssueCreate: replies } });
  const result = await client.graphql(
    CREATE,
    { input: { title: "Login fails" } },
    { token: "access-1" }
  );
  return { result, linear, sleeps };
}

const throwing = (error) => ({ throw: error });

test("a 200 with data is ok: one POST with the bearer token, the query and its variables", async () => {
  const { LINEAR_GRAPHQL_URL } = await load();
  assert.equal(LINEAR_GRAPHQL_URL, "https://api.linear.app/graphql");

  const { client, linear } = await api({
    [GRAPHQL]: { LinearIdentity: [gql(FIXTURES.identity)] },
  });
  const result = await client.graphql(IDENTITY, {}, { token: "access-1" });

  assert.deepEqual(result, { ok: true, data: FIXTURES.identity });
  assert.deepEqual(linear.calls, [
    {
      path: GRAPHQL,
      operation: "LinearIdentity",
      variables: {},
      form: null,
      authorization: "Bearer access-1",
    },
  ]);
});

test("no token means no request", async () => {
  const { client, linear } = await api({ [GRAPHQL]: { LinearIdentity: [gql({})] } });
  for (const token of [undefined, null, ""]) {
    assert.deepEqual(await client.graphql(IDENTITY, {}, { token }), {
      ok: false,
      outcome: "failed",
      errorCode: "unauthorized",
    });
  }
  assert.deepEqual(linear.calls, []);
});

test("a 200 that can't be read, or has no data, is unknown and never failed", async () => {
  const replies = [
    { status: 200, rawBody: "<html>oops</html>" },
    { status: 200, rawBody: "" },
    { status: 200, body: [CREATED] },
    { status: 200, body: {} },
    { status: 200, body: { data: null } },
    { status: 200, body: { data: "ENG-1" } },
  ];
  for (const reply of replies) {
    const { result, linear } = await create([reply]);
    assert.deepEqual(
      result,
      { ok: false, outcome: "unknown", errorCode: "bad_response", status: 200 },
      JSON.stringify(reply)
    );
    assert.equal(linear.calls.length, 1, JSON.stringify(reply));
  }
});

test("a GraphQL error Linear lists as a refusal is failed, with its own code", async () => {
  const expected = [
    ["INVALID_INPUT", "invalid_input"],
    ["FORBIDDEN", "forbidden"],
    ["ENTITY_NOT_FOUND", "not_found"],
  ];
  for (const [code, errorCode] of expected) {
    const { result, linear } = await create([gqlError(code), gql(CREATED)]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode, status: 200 }, code);
    assert.equal(linear.calls.length, 1, `${code} is never retried`);
  }

  // The code can arrive in extensions.type instead.
  for (const [type, errorCode] of [
    ["InvalidInput", "invalid_input"],
    ["Forbidden", "forbidden"],
    ["EntityNotFound", "not_found"],
  ]) {
    const { result } = await create([gqlError(null, { extensions: { type } })]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode, status: 200 }, type);
  }

  // A root field that came back null is no data: still a refusal.
  const { result } = await create([gqlError("INVALID_INPUT", { data: { issueCreate: null } })]);
  assert.deepEqual(result, {
    ok: false,
    outcome: "failed",
    errorCode: "invalid_input",
    status: 200,
  });
});

test("any other GraphQL error in a 200 is unknown, even beside a listed one or with partial data", async () => {
  const unlisted = [
    gqlError("INTERNAL_SERVER_ERROR"),
    gqlError("SOMETHING_NEW"),
    gqlError(null, { extensions: {} }),
    { status: 200, body: { data: null, errors: [{ message: "no extensions" }] } },
    // An unlisted code is never overridden by a listed type.
    gqlError(null, { extensions: { code: "INTERNAL_SERVER_ERROR", type: "InvalidInput" } }),
    // Partial data beside an error: the write may have happened.
    gqlError("INTERNAL_SERVER_ERROR", { data: CREATED }),
    // Even a listed refusal beside data: the create itself went through.
    gqlError("INPUT_ERROR", { data: CREATED, message: "Entity not found: Issue" }),
    gqlError("INVALID_INPUT", {
      data: { commentCreate: { success: true, comment: null } },
    }),
    {
      status: 200,
      body: {
        data: null,
        errors: [
          { message: "a", extensions: { code: "INVALID_INPUT" } },
          { message: "b", extensions: { code: "INTERNAL_SERVER_ERROR" } },
        ],
      },
    },
  ];
  for (const [index, reply] of unlisted.entries()) {
    const { result, linear } = await create([reply, gql(CREATED)]);
    assert.deepEqual(
      result,
      { ok: false, outcome: "unknown", errorCode: "graphql_error", status: 200 },
      `case ${index}`
    );
    assert.equal(linear.calls.length, 1, `case ${index} is never retried`);
  }
});

// Checked live: Linear reported INPUT_ERROR
// (not ENTITY_NOT_FOUND) for a missing issue, and INPUT_ERROR with a
// "conflict on insert" message for a repeated client id.
test("the refusal list holds the codes Linear was seen to send", async () => {
  const { LINEAR_PRE_SEND_REJECTIONS } = await load();
  for (const code of [
    "INVALID_INPUT",
    "InvalidInput",
    "FORBIDDEN",
    "Forbidden",
    "ENTITY_NOT_FOUND",
    "EntityNotFound",
    "RATELIMITED",
    "AUTHENTICATION_ERROR",
    "INPUT_ERROR",
    "invalid input",
    "authentication error",
  ]) {
    assert.ok(LINEAR_PRE_SEND_REJECTIONS.has(code), code);
  }
});

test("an INPUT_ERROR reporting a missing entity is failed not_found", async () => {
  const { result, linear } = await create([
    gqlError("INPUT_ERROR", { message: "Entity not found: Issue" }),
    gql(CREATED),
  ]);
  assert.deepEqual(result, { ok: false, outcome: "failed", errorCode: "not_found", status: 200 });
  assert.equal(linear.calls.length, 1, "never retried");
});

test("an INPUT_ERROR reporting a conflict on insert is unknown, not a refusal", async () => {
  // The entity with that client id already exists: the create must be
  // settled by a lookup, never reported as failed.
  const { result, linear } = await create([
    gqlError("INPUT_ERROR", { message: "conflict on insert of Issue" }),
    gql(CREATED),
  ]);
  assert.deepEqual(result, {
    ok: false,
    outcome: "unknown",
    errorCode: "graphql_error",
    status: 200,
  });
  assert.equal(linear.calls.length, 1, "never retried");
});

test("any other INPUT_ERROR is failed invalid_input", async () => {
  const { result, linear } = await create([
    gqlError("INPUT_ERROR", { message: "Argument Validation Error" }),
    gql(CREATED),
  ]);
  assert.deepEqual(result, {
    ok: false,
    outcome: "failed",
    errorCode: "invalid_input",
    status: 200,
  });
  assert.equal(linear.calls.length, 1, "never retried");
});

test("a 401 or AUTHENTICATION_ERROR is failed unauthorized, with no retry here", async () => {
  for (const reply of [httpStatus(401), gqlError("AUTHENTICATION_ERROR")]) {
    const { result, linear } = await create([reply, gql(CREATED)]);
    assert.deepEqual(result, {
      ok: false,
      outcome: "failed",
      errorCode: "unauthorized",
      status: reply.status,
    });
    assert.equal(linear.calls.length, 1, "the connector, not the api, refreshes and retries");
  }
});

test("other 4xx are failed: a listed code keeps its name, anything else is http_<status>", async () => {
  const listed = await create([gqlError("INVALID_INPUT", { status: 400 })]);
  assert.deepEqual(listed.result, {
    ok: false,
    outcome: "failed",
    errorCode: "invalid_input",
    status: 400,
  });

  for (const status of [400, 403, 404, 413]) {
    const { result } = await create([httpStatus(status)]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode: `http_${status}`, status });
  }
  const unreadable = await create([{ status: 400, rawBody: "Bad Request" }]);
  assert.deepEqual(unreadable.result, {
    ok: false,
    outcome: "failed",
    errorCode: "http_400",
    status: 400,
  });
});

test("every 5xx is unknown, whatever its body says, and is never retried", async () => {
  for (const reply of [
    httpStatus(500),
    httpStatus(502),
    httpStatus(503, { "retry-after": "1" }),
    gqlError("INVALID_INPUT", { status: 500 }),
    { status: 504, rawBody: "" },
  ]) {
    const { result, linear, sleeps } = await create([reply, gql(CREATED)]);
    assert.deepEqual(
      result,
      { ok: false, outcome: "unknown", errorCode: `http_${reply.status}`, status: reply.status },
      JSON.stringify(reply)
    );
    assert.equal(linear.calls.length, 1);
    assert.deepEqual(sleeps, []);
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
    const { result } = await create([reply]);
    assert.deepEqual(result, { ok: false, outcome: "failed", errorCode }, errorCode);
  }

  const afterWrite = [
    [reset(), "ECONNRESET"],
    [throwing(new Error("net::ERR_CONNECTION_RESET")), "ERR_CONNECTION_RESET"],
    [throwing(new Error("something odd")), "network_error"],
  ];
  for (const [reply, errorCode] of afterWrite) {
    const { result, linear } = await create([reply, gql(CREATED)]);
    assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode }, errorCode);
    assert.equal(linear.calls.length, 1, errorCode);
  }
});

test("a request that times out after it was written is unknown timeout", async () => {
  const { createLinearApi } = await load();
  let calls = 0;
  const client = createLinearApi({
    timeoutMs: 20,
    fetchImpl: (url, init) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    },
  });

  const result = await client.graphql(CREATE, {}, { token: "access-1" });

  assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode: "timeout" });
  assert.equal(calls, 1);
});

test("a rate limit asking for 5 s or less is retried once after that wait", async () => {
  const { MAX_RETRY_AFTER_MS } = await load();
  assert.equal(MAX_RETRY_AFTER_MS, 5000);

  const http429 = await create([httpStatus(429, { "retry-after": "2" }), gql(CREATED)]);
  assert.deepEqual(http429.result, { ok: true, data: CREATED });
  assert.deepEqual(http429.sleeps, [2000]);
  assert.equal(http429.linear.calls.length, 2);

  const inBody = await create([
    gqlError("RATELIMITED", { headers: { "retry-after": "1" } }),
    gql(CREATED),
  ]);
  assert.deepEqual(inBody.result, { ok: true, data: CREATED });
  assert.deepEqual(inBody.sleeps, [1000]);

  const in400 = await create([
    gqlError("RATELIMITED", { status: 400, headers: { "retry-after": "5" } }),
    gql(CREATED),
  ]);
  assert.equal(in400.result.ok, true);
  assert.deepEqual(in400.sleeps, [5000]);
});

test("a longer, missing or date wait, or a second rate limit, is failed rate_limited", async () => {
  const cases = [
    [httpStatus(429, { "retry-after": "6" }), 429, 6000],
    [httpStatus(429), 429, null],
    [httpStatus(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), 429, null],
    [gqlError("RATELIMITED"), 200, null],
    [gqlError("RATELIMITED", { headers: { "retry-after": "30" } }), 200, 30000],
  ];
  for (const [reply, status, wait] of cases) {
    const { result, linear, sleeps } = await create([reply, gql(CREATED)]);
    assert.deepEqual(
      result,
      { ok: false, outcome: "failed", errorCode: "rate_limited", status, retryAfterMs: wait },
      JSON.stringify(reply.headers)
    );
    assert.equal(linear.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }

  const twice = await create([
    httpStatus(429, { "retry-after": "1" }),
    gqlError("RATELIMITED", { headers: { "retry-after": "1" } }),
    gql(CREATED),
  ]);
  assert.deepEqual(twice.result, {
    ok: false,
    outcome: "failed",
    errorCode: "rate_limited",
    status: 200,
    retryAfterMs: 1000,
  });
  assert.equal(twice.linear.calls.length, 2);
  assert.deepEqual(twice.sleeps, [1000]);
});

test("exchangeToken posts the PKCE code as a form, with no client secret and no bearer", async () => {
  const { LINEAR_TOKEN_URL } = await load();
  assert.equal(LINEAR_TOKEN_URL, "https://api.linear.app/oauth/token");
  const { client, linear } = await api({ [TOKEN]: [{ body: FIXTURES.exchange }] });

  const result = await client.exchangeToken({
    code: "code-1",
    client_id: "client-1",
    redirect_uri: "http://127.0.0.1:5000/linear/callback",
    code_verifier: "verifier-1",
    unused: undefined,
  });

  assert.deepEqual(result, { ok: true, data: FIXTURES.exchange });
  assert.deepEqual(linear.calls[0].form, {
    code: "code-1",
    client_id: "client-1",
    redirect_uri: "http://127.0.0.1:5000/linear/callback",
    code_verifier: "verifier-1",
    grant_type: "authorization_code",
  });
  assert.equal(linear.calls[0].authorization, null);
});

test("refreshToken posts the refresh token as a form with grant_type refresh_token", async () => {
  const { client, linear } = await api({ [TOKEN]: [{ body: FIXTURES.refresh }] });

  const result = await client.refreshToken({ client_id: "client-1", refresh_token: "refresh-1" });

  assert.deepEqual(result, { ok: true, data: FIXTURES.refresh });
  assert.deepEqual(linear.calls[0].form, {
    client_id: "client-1",
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
  });
  assert.equal("client_secret" in linear.calls[0].form, false);
});

test("token endpoint failures are told apart: login gone, bad client, busy, 5xx, offline", async () => {
  const oauth = (status, error) => ({ status, body: { error, error_description: "synthetic" } });
  const cases = [
    [
      oauth(400, "invalid_grant"),
      { ok: false, outcome: "failed", errorCode: "invalid_grant", refused: true },
    ],
    [
      oauth(401, "invalid_client"),
      { ok: false, outcome: "failed", errorCode: "invalid_client", refused: true },
    ],
    [
      oauth(400, "unauthorized_client"),
      { ok: false, outcome: "failed", errorCode: "unauthorized_client", refused: true },
    ],
    // A throttled or timed-out answer can pass, whatever its body says.
    [oauth(429, "rate_limited"), { ok: false, outcome: "failed", errorCode: "rate_limited" }],
    [oauth(408, "invalid_request"), { ok: false, outcome: "failed", errorCode: "invalid_request" }],
    [
      oauth(503, "temporarily_unavailable"),
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
    const result = await client.refreshToken({ refresh_token: "refresh-1" });
    assert.deepEqual(result, expected, JSON.stringify(reply));
    assert.equal(
      JSON.stringify(result).includes("synthetic"),
      false,
      "error_description is dropped"
    );
    seen.add(`${result.outcome}:${result.errorCode}`);
  }
  assert.equal(seen.size, cases.length, "every failure must be told apart");
});

test("revokeToken sends the token in the form only; any 2xx is success", async () => {
  const { LINEAR_REVOKE_URL } = await load();
  assert.equal(LINEAR_REVOKE_URL, "https://api.linear.app/oauth/revoke");
  const { client, linear } = await api({ [REVOKE]: [{ status: 200, rawBody: "" }] });

  assert.deepEqual(await client.revokeToken("refresh-1"), { ok: true });
  assert.deepEqual(linear.calls[0].form, { token: "refresh-1" });
  assert.equal(linear.calls[0].authorization, null);
});

test("revokeToken reports a refusal or a network error as not ok, and never throws", async () => {
  const refused = await api({ [REVOKE]: [{ status: 400, body: { error: "invalid_token" } }] });
  assert.deepEqual(await refused.client.revokeToken("access-1"), { ok: false });

  const down = await api({ [REVOKE]: [offline()] });
  assert.deepEqual(await down.client.revokeToken("refresh-1"), { ok: false });

  const serverError = await api({ [REVOKE]: [httpStatus(503)] });
  assert.deepEqual(await serverError.client.revokeToken("refresh-1"), { ok: false });

  const none = await api({ [REVOKE]: [{ status: 200, rawBody: "" }] });
  assert.deepEqual(await none.client.revokeToken(""), { ok: false });
  assert.deepEqual(await none.client.revokeToken(null), { ok: false });
  assert.equal(none.linear.calls.length, 0);
});

test("the fixtures script GraphQL by operation name and refuse an unscripted one", async () => {
  const { LINEAR_AUTHORIZE_URL } = await load();
  assert.equal(LINEAR_AUTHORIZE_URL, "https://linear.app/oauth/authorize");
  const { client, linear } = await api({
    [GRAPHQL]: { LinearIdentity: [gql(FIXTURES.identity)] },
  });

  const unscripted = await client.graphql(CREATE, { input: {} }, { token: "access-1" });

  assert.deepEqual(unscripted, { ok: false, outcome: "unknown", errorCode: "network_error" });
  assert.deepEqual(linear.operations(), ["LinearIssueCreate"]);
  assert.deepEqual(linear.calls[0].variables, { input: {} });
  assert.equal(BINDING.accountId, CONNECTED.userId);
  assert.equal(BINDING.workspaceId, CONNECTED.organizationId);
  assert.equal(CONNECTED.organizationUrlKey, "acme");
  assert.equal(CONNECTED.expiresAt, NOW + 3600000);
});
