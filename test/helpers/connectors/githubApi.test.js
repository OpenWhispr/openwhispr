const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  FIXTURES,
  fakeGithubFetch,
  json,
  httpStatus,
  oauthError,
  rateLimited,
  reset,
  offline,
  hang,
} = require("./githubFixtures");

const load = () => import("../../../src/helpers/connectors/githubApi.js");

async function api(script, options = {}) {
  const { createGithubApi } = await load();
  const github = fakeGithubFetch(script);
  const sleeps = [];
  const client = createGithubApi({
    fetchImpl: github.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW,
    ...options,
  });
  return { client, github, sleeps };
}

const ISSUES = "/repos/acme/app/issues";
const COMMENTS = "/repos/acme/app/issues/12/comments";

test("a GET goes to api.github.com with the version headers, the bearer token and the query", async () => {
  const { GITHUB_API_BASE } = await load();
  assert.equal(GITHUB_API_BASE, "https://api.github.com");
  const { client, github } = await api({
    "GET /search/issues": [
      json({ total_count: 0, items: [] }, 200, { "x-ratelimit-remaining": "29" }),
    ],
  });

  const result = await client.rest("GET", "/search/issues", {
    token: "ghu-1",
    query: { q: "timeout repo:acme/app", per_page: 10, page: undefined },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { total_count: 0, items: [] });
  assert.equal(result.status, 200);
  assert.equal(result.headers["x-ratelimit-remaining"], "29");
  const [call] = github.calls;
  assert.equal(call.origin, "https://api.github.com");
  assert.deepEqual(call.query, { q: "timeout repo:acme/app", per_page: "10" });
  assert.equal(call.authorization, "Bearer ghu-1");
  assert.equal(call.headers.Accept, "application/vnd.github+json");
  assert.equal(call.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(call.headers["User-Agent"], "OpenWhispr");
  assert.equal(call.headers["Content-Type"], undefined);
});

test("a POST sends a JSON body; a 201 and a 204 are ok", async () => {
  const { client, github } = await api({
    [`POST ${ISSUES}`]: [
      json({ number: 212, html_url: "https://github.com/acme/app/issues/212" }, 201),
    ],
    "DELETE /repos/acme/app/issues/12/lock": [{ status: 204, rawBody: "" }],
  });

  const created = await client.rest("POST", ISSUES, {
    token: "ghu-1",
    body: { title: "Timeout on login", body: "Steps", labels: ["bug"] },
  });
  assert.deepEqual(
    { ok: created.ok, status: created.status, number: created.data.number },
    { ok: true, status: 201, number: 212 }
  );
  assert.equal(github.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(github.calls[0].json, {
    title: "Timeout on login",
    body: "Steps",
    labels: ["bug"],
  });

  const empty = await client.rest("DELETE", "/repos/acme/app/issues/12/lock", { token: "ghu-1" });
  assert.equal(empty.ok, true);
  assert.equal(empty.data, null);
  assert.equal(empty.status, 204);
});

test("a path that isn't a single-slash API path throws before any request", async () => {
  const { client, github } = await api({});
  for (const path of ["@evil.example/x", "//evil.example/x", "https://evil.example/x", "", null]) {
    assert.throws(() => client.rest("GET", path, { token: "ghu-1" }), TypeError, String(path));
  }
  assert.equal(github.calls.length, 0);
});

test("a 2xx that can't be read is unknown bad_response, never failed", async () => {
  const replies = [
    { status: 201, rawBody: "<html>oops</html>" },
    { status: 201, rawBody: "" },
    { status: 200, rawBody: "42" },
    { status: 200, rawBody: '"text"' },
  ];
  for (const reply of replies) {
    const { client } = await api({ [`POST ${COMMENTS}`]: [reply] });
    const result = await client.rest("POST", COMMENTS, { token: "ghu-1", body: { body: "Hi" } });
    assert.deepEqual(
      result,
      { ok: false, outcome: "unknown", errorCode: "bad_response", status: reply.status },
      JSON.stringify(reply)
    );
  }
});

test("GitHub's refusals are failed with their own codes; 5xx and other statuses are unknown", async () => {
  const expected = [
    [401, "failed", "unauthorized"],
    [404, "failed", "not_found"],
    [410, "failed", "issues_disabled"],
    [422, "failed", "invalid"],
    [409, "failed", "http_409"],
    [400, "failed", "http_400"],
    [500, "unknown", "http_500"],
    [502, "unknown", "http_502"],
    [503, "unknown", "http_503"],
    [304, "unknown", "http_304"],
  ];
  for (const [status, outcome, errorCode] of expected) {
    const { client, github, sleeps } = await api({
      [`POST ${ISSUES}`]: [httpStatus(status), json({ number: 1 }, 201)],
    });
    const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
    assert.deepEqual(result, { ok: false, outcome, errorCode, status }, String(status));
    assert.equal(github.calls.length, 1, `${status}: the api never retries it`);
    assert.deepEqual(sleeps, []);
  }
});

test("a 401 is failed unauthorized with one request: the connector refreshes and retries", async () => {
  const { client, github } = await api({
    [`POST ${COMMENTS}`]: [httpStatus(401, {}, "Bad credentials"), json({ id: 1 }, 201)],
  });
  const result = await client.rest("POST", COMMENTS, { token: "ghu-1", body: { body: "Hi" } });
  assert.deepEqual(result, {
    ok: false,
    outcome: "failed",
    errorCode: "unauthorized",
    status: 401,
  });
  assert.equal(github.calls.length, 1);
});

test("a 403 without rate-limit headers or message is forbidden and not retried", async () => {
  const { client, github, sleeps } = await api({
    [`POST ${ISSUES}`]: [
      httpStatus(403, {}, "Resource not accessible by integration"),
      json({ number: 1 }, 201),
    ],
  });
  const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
  assert.deepEqual(result, { ok: false, outcome: "failed", errorCode: "forbidden", status: 403 });
  assert.equal(github.calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a primary rate limit resetting within 5 s is retried once, with the same request", async () => {
  for (const status of [403, 429]) {
    const { client, github, sleeps } = await api({
      [`POST ${ISSUES}`]: [rateLimited({ status, resetIn: 3 }), json({ number: 212 }, 201)],
    });
    const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
    assert.equal(result.ok, true, String(status));
    assert.equal(result.data.number, 212);
    assert.deepEqual(sleeps, [3000]);
    assert.equal(github.calls.length, 2);
    assert.deepEqual(github.calls[1].json, github.calls[0].json);
  }
});

test("a second rate limit, or a reset more than 5 s away, is failed rate_limited", async () => {
  const twice = await api({
    [`POST ${ISSUES}`]: [rateLimited({ status: 429, resetIn: 3 })],
  });
  const second = await twice.client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
  assert.deepEqual(second, {
    ok: false,
    outcome: "failed",
    errorCode: "rate_limited",
    status: 429,
    retryAfterMs: 3000,
  });
  assert.equal(twice.github.calls.length, 2, "one retry only");
  assert.deepEqual(twice.sleeps, [3000]);

  const long = await api({ [`POST ${ISSUES}`]: [rateLimited({ resetIn: 6 })] });
  const result = await long.client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
  assert.deepEqual(result, {
    ok: false,
    outcome: "failed",
    errorCode: "rate_limited",
    status: 403,
    retryAfterMs: 6000,
  });
  assert.equal(long.github.calls.length, 1);
  assert.deepEqual(long.sleeps, []);
});

test("retry-after decides a secondary limit's wait, ahead of x-ratelimit-reset", async () => {
  const short = await api({
    [`POST ${COMMENTS}`]: [rateLimited({ retryAfter: 2 }), json({ id: 7 }, 201)],
  });
  const retried = await short.client.rest("POST", COMMENTS, {
    token: "ghu-1",
    body: { body: "Hi" },
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(short.sleeps, [2000]);

  const both = rateLimited({ resetIn: 1 });
  both.headers["retry-after"] = "30";
  const long = await api({ [`POST ${COMMENTS}`]: [both] });
  const refused = await long.client.rest("POST", COMMENTS, {
    token: "ghu-1",
    body: { body: "Hi" },
  });
  assert.equal(refused.errorCode, "rate_limited");
  assert.equal(refused.retryAfterMs, 30000);
  assert.equal(long.github.calls.length, 1);
});

test("a secondary limit with no headers, and a bare 429, wait a minute: failed, not retried", async () => {
  const { SECONDARY_RATE_LIMIT_WAIT_MS } = await load();
  assert.equal(SECONDARY_RATE_LIMIT_WAIT_MS, 60000);
  for (const reply of [rateLimited({ secondary: true }), httpStatus(429)]) {
    const { client, github, sleeps } = await api({ [`POST ${ISSUES}`]: [reply] });
    const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
    assert.deepEqual(result, {
      ok: false,
      outcome: "failed",
      errorCode: "rate_limited",
      status: reply.status,
      retryAfterMs: 60000,
    });
    assert.equal(github.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("a cancel while waiting out a rate limit ends at once, with no retry", async () => {
  const { createGithubApi } = await load();
  const github = fakeGithubFetch({ "GET /user/installations": [rateLimited({ retryAfter: 5 })] });
  // The default sleep, on real timers.
  const client = createGithubApi({ fetchImpl: github.fetchImpl, now: () => NOW });
  const controller = new AbortController();
  const pending = client.rest("GET", "/user/installations", {
    token: "ghu-1",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 5);
  const started = Date.now();

  const result = await pending;

  assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode: "network_error" });
  assert.ok(Date.now() - started < 1000, "does not wait out the 5 s retry-after");
  assert.equal(github.calls.length, 1);
});

test("offline before the write is failed; a reset after it is unknown", async () => {
  const cases = [
    [offline(), "failed", "ENOTFOUND"],
    [{ throw: new Error("net::ERR_INTERNET_DISCONNECTED") }, "failed", "ERR_INTERNET_DISCONNECTED"],
    [reset(), "unknown", "ECONNRESET"],
    [{ throw: new Error("boom") }, "unknown", "network_error"],
  ];
  for (const [reply, outcome, errorCode] of cases) {
    const { client } = await api({ [`POST ${ISSUES}`]: [reply] });
    const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
    assert.deepEqual(result, { ok: false, outcome, errorCode }, errorCode);
  }
});

test("a request that times out after it was written is unknown timeout", async () => {
  const { client, github } = await api({ [`POST ${ISSUES}`]: [hang()] }, { timeoutMs: 20 });
  const result = await client.rest("POST", ISSUES, { token: "ghu-1", body: { title: "T" } });
  assert.deepEqual(result, { ok: false, outcome: "unknown", errorCode: "timeout" });
  assert.equal(github.calls.length, 1);
});

const page = (items, next) =>
  json(items, 200, next ? { link: `<${next}>; rel="next", <${next}&x=1>; rel="last"` } : {});

test("restAll follows Link rel=next across array pages with the token on each", async () => {
  const { client, github } = await api({
    "GET /user/repos": [
      page([{ id: 1 }, { id: 2 }], "https://api.github.com/user/repos?per_page=2&page=2"),
      page([{ id: 3 }], "https://api.github.com/user/repos?per_page=2&page=3"),
      page([]),
    ],
  });

  const result = await client.restAll("/user/repos", { token: "ghu-1", query: { per_page: 2 } });

  assert.deepEqual(result, {
    ok: true,
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
    truncated: false,
    status: 200,
  });
  assert.deepEqual(
    github.calls.map((call) => call.query),
    [{ per_page: "2" }, { per_page: "2", page: "2" }, { per_page: "2", page: "3" }]
  );
  assert.ok(github.calls.every((call) => call.authorization === "Bearer ghu-1"));
});

test("restAll reads { key: [...] } bodies and stops at maxPages with truncated: true", async () => {
  const next = (n) => `https://api.github.com/user/installations?per_page=100&page=${n}`;
  const { client, github } = await api({
    "GET /user/installations": [
      page({ total_count: 5, installations: [{ id: 1 }, { id: 2 }] }, next(2)),
      page({ total_count: 5, installations: [{ id: 3 }, { id: 4 }] }, next(3)),
      page({ total_count: 5, installations: [{ id: 5 }] }),
    ],
  });

  const result = await client.restAll("/user/installations", {
    token: "ghu-1",
    query: { per_page: 100 },
    key: "installations",
    maxPages: 2,
  });

  assert.deepEqual(result, {
    ok: true,
    items: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    truncated: true,
    status: 200,
  });
  assert.equal(github.calls.length, 2);
});

test("restAll returns a failed page's result, and never follows a link off api.github.com", async () => {
  const failing = await api({
    "GET /user/installations": [
      page({ installations: [{ id: 1 }] }, "https://api.github.com/user/installations?page=2"),
      httpStatus(502),
    ],
  });
  const failed = await failing.client.restAll("/user/installations", {
    token: "ghu-1",
    key: "installations",
  });
  assert.deepEqual(failed, { ok: false, outcome: "unknown", errorCode: "http_502", status: 502 });

  const wrongShape = await api({ "GET /user/installations": [json({ installations: "x" })] });
  const shape = await wrongShape.client.restAll("/user/installations", {
    token: "ghu-1",
    key: "installations",
  });
  assert.deepEqual(shape, {
    ok: false,
    outcome: "unknown",
    errorCode: "bad_response",
    status: 200,
  });

  const foreign = await api({
    "GET /user/repos": [page([{ id: 1 }], "https://evil.example/user/repos?page=2")],
  });
  const refused = await foreign.client.restAll("/user/repos", { token: "ghu-1" });
  assert.deepEqual(refused, {
    ok: false,
    outcome: "unknown",
    errorCode: "bad_response",
    status: 200,
  });
  assert.deepEqual(foreign.github.requests(), ["GET /user/repos"]);
  assert.ok(foreign.github.calls.every((call) => call.origin === "https://api.github.com"));
});

test("a call with no token sends no Authorization header, as GitHub's credential revoke requires", async () => {
  const { client, github } = await api({ "POST /credentials/revoke": [json({}, 202)] });

  const result = await client.rest("POST", "/credentials/revoke", {
    body: { credentials: ["ghr-1", "ghu-1"] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  const [call] = github.calls;
  assert.equal(call.origin, "https://api.github.com");
  assert.equal(call.authorization, null);
  assert.equal("Authorization" in call.headers, false);
  assert.deepEqual(call.json, { credentials: ["ghr-1", "ghu-1"] });
});

test("deviceCode posts the client id as a form to github.com, with no secret and no token", async () => {
  const { GITHUB_DEVICE_CODE_URL } = await load();
  assert.equal(GITHUB_DEVICE_CODE_URL, "https://github.com/login/device/code");
  const { client, github } = await api({
    "POST /login/device/code": [json(FIXTURES.deviceCode)],
  });

  const result = await client.deviceCode({ client_id: "Iv1.test" });

  assert.deepEqual(result, { ok: true, data: FIXTURES.deviceCode });
  const [call] = github.calls;
  assert.equal(call.origin, "https://github.com");
  assert.deepEqual(call.form, { client_id: "Iv1.test" });
  assert.equal(call.headers.Accept, "application/json");
  assert.equal(call.headers["User-Agent"], "OpenWhispr");
  assert.equal(call.authorization, null);
});

test("accessToken reads GitHub's OAuth errors from an HTTP 200, keeping slow_down's interval", async () => {
  const { GITHUB_ACCESS_TOKEN_URL } = await load();
  assert.equal(GITHUB_ACCESS_TOKEN_URL, "https://github.com/login/oauth/access_token");
  const codes = [
    "authorization_pending",
    "expired_token",
    "access_denied",
    "device_flow_disabled",
    "bad_refresh_token",
    "incorrect_device_code",
  ];
  for (const code of codes) {
    const { client } = await api({ "POST /login/oauth/access_token": [oauthError(code)] });
    const result = await client.accessToken({ client_id: "Iv1.test", device_code: "dc-test-1" });
    assert.deepEqual(
      result,
      { ok: false, outcome: "failed", errorCode: code, refused: true },
      code
    );
  }

  const { client, github } = await api({
    "POST /login/oauth/access_token": [oauthError("slow_down", { interval: 10 })],
  });
  const slow = await client.accessToken({
    client_id: "Iv1.test",
    device_code: "dc-test-1",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.deepEqual(slow, {
    ok: false,
    outcome: "failed",
    errorCode: "slow_down",
    refused: true,
    intervalMs: 10000,
  });
  assert.equal(JSON.stringify(slow).includes("Synthetic description"), false);
  assert.deepEqual(github.calls[0].form, {
    client_id: "Iv1.test",
    device_code: "dc-test-1",
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  assert.equal(github.calls[0].headers.Accept, "application/json");
});

test("accessToken: a token is ok; unreadable, 5xx, other 4xx and offline are classified", async () => {
  const ok = await api({ "POST /login/oauth/access_token": [json(FIXTURES.token)] });
  assert.deepEqual(await ok.client.accessToken({ client_id: "Iv1.test" }), {
    ok: true,
    data: FIXTURES.token,
  });

  const cases = [
    [
      { status: 200, rawBody: "<html>" },
      { outcome: "unknown", errorCode: "bad_response" },
    ],
    [json(["x"]), { outcome: "unknown", errorCode: "bad_response" }],
    [
      { status: 502, rawBody: "" },
      { outcome: "unknown", errorCode: "http_502" },
    ],
    [
      { status: 404, rawBody: "Not Found" },
      { outcome: "failed", errorCode: "http_404" },
    ],
    [
      json({ error: "bad_refresh_token" }, 400),
      { outcome: "failed", errorCode: "bad_refresh_token", refused: true },
    ],
    [json({ error: "server_error" }, 503), { outcome: "unknown", errorCode: "server_error" }],
    [offline(), { outcome: "failed", errorCode: "ENOTFOUND" }],
    [reset(), { outcome: "unknown", errorCode: "ECONNRESET" }],
  ];
  for (const [reply, expected] of cases) {
    const { client } = await api({ "POST /login/oauth/access_token": [reply] });
    const result = await client.accessToken({ client_id: "Iv1.test" });
    assert.deepEqual(result, { ok: false, ...expected }, JSON.stringify(reply));
  }
});

test("accessToken: a throttle or a try-later OAuth error is not a refusal", async () => {
  const cases = [
    [json({ error: "authorization_pending" }, 408), "authorization_pending"],
    [oauthError("temporarily_unavailable"), "temporarily_unavailable"],
    [oauthError("server_error"), "server_error"],
  ];
  for (const [reply, errorCode] of cases) {
    const { client } = await api({ "POST /login/oauth/access_token": [reply] });
    const result = await client.accessToken({ client_id: "Iv1.test" });
    assert.deepEqual(
      result,
      { ok: false, outcome: "failed", errorCode },
      `${reply.status} ${errorCode}`
    );
  }
});

test("accessToken: a 429 is rate limited whatever its body says", async () => {
  const cases = [
    [json({ error: "slow_down" }, 429), "slow_down"],
    [json({ error: "bad_refresh_token" }, 429), "bad_refresh_token"],
    [json({ message: "Too many requests" }, 429), "http_429"],
    [{ status: 429, rawBody: "" }, "http_429"],
  ];
  for (const [reply, errorCode] of cases) {
    const { client } = await api({ "POST /login/oauth/access_token": [reply] });
    const result = await client.accessToken({ client_id: "Iv1.test" });
    assert.deepEqual(
      result,
      { ok: false, outcome: "failed", errorCode, rateLimited: true },
      `${reply.status} ${errorCode}`
    );
  }
});

test("an aborted signal ends an in-flight login request at once", async () => {
  const { client, github } = await api({ "POST /login/oauth/access_token": [hang()] });
  const controller = new AbortController();
  const pending = client.accessToken({ client_id: "Iv1.test" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const started = Date.now();

  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.outcome, "unknown");
  assert.ok(Date.now() - started < 1000, "does not wait for the 15 s timeout");
  assert.equal(github.calls.length, 1);
});
