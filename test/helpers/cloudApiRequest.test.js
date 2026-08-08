const test = require("node:test");
const assert = require("node:assert/strict");

const { createCloudApiRequestHandler } = require("../../src/helpers/cloudApiRequest");

function createHandler(state, proxyFetch) {
  return createCloudApiRequestHandler({
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.2.3",
    proxyFetch,
    tokenStore: {
      getState: () => ({ ...state.current }),
    },
    logger: { error: () => {} },
  });
}

test("an unvalidated or stale generation never reaches the network", async () => {
  const state = { current: { token: "token-b", generation: 2 } };
  let fetchCalls = 0;
  const handler = createHandler(state, async () => {
    fetchCalls += 1;
    return new Response("{}");
  });

  const missing = await handler({ method: "GET", path: "/api/me/spaces" });
  const stale = await handler({
    method: "GET",
    path: "/api/me/spaces",
    expectedAuthGeneration: 1,
  });

  assert.equal(missing.code, "AUTH_CONTEXT_UNVALIDATED");
  assert.equal(stale.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(fetchCalls, 0);
});

test("a token replacement while the request is in flight discards the response", async () => {
  const state = { current: { token: "token-a", generation: 4 } };
  let release;
  const fetchGate = new Promise((resolve) => {
    release = resolve;
  });
  const handler = createHandler(state, async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer token-a");
    return fetchGate;
  });

  const request = handler({
    method: "GET",
    path: "/api/me/spaces",
    expectedAuthGeneration: 4,
  });
  state.current = { token: "token-b", generation: 5 };
  release(new Response(JSON.stringify({ data: [{ id: "space-a" }] })));

  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(result.data, undefined);
});

test("an auth-context change dominates a simultaneous network failure", async () => {
  const state = { current: { token: "token-a", generation: 8 } };
  const handler = createHandler(state, async () => {
    state.current = { token: "token-b", generation: 9 };
    throw new Error("socket closed");
  });

  const result = await handler({
    method: "PATCH",
    path: "/api/notes/note-a",
    body: { title: "old account data" },
    expectedAuthGeneration: 8,
  });

  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.doesNotMatch(result.error, /socket closed/);
});

test("a stable authenticated request is bearer-only and returns parsed data", async () => {
  const state = { current: { token: "token-a", generation: 13 } };
  const handler = createHandler(state, async (url, options) => {
    assert.equal(url, "https://api.openwhispr.test/api/me/spaces");
    assert.equal(options.useSessionCookies, false);
    assert.equal(options.headers.Authorization, "Bearer token-a");
    assert.equal(options.headers["x-openwhispr-policy-version"], "1");
    assert.equal(options.headers["x-openwhispr-version"], "1.2.3");
    return new Response(JSON.stringify({ data: [{ id: "space-a" }] }));
  });

  const result = await handler({
    method: "GET",
    path: "/api/me/spaces",
    expectedAuthGeneration: 13,
  });
  assert.deepEqual(result, {
    success: true,
    data: { data: [{ id: "space-a" }] },
  });
});

test("public requests carry neither bearer nor cookies", async () => {
  const state = { current: { token: "token-a", generation: 21 } };
  const handler = createHandler(state, async (_url, options) => {
    assert.equal(options.useSessionCookies, false);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers["x-openwhispr-policy-version"], undefined);
    assert.equal(options.headers["x-openwhispr-version"], "1.2.3");
    return new Response(JSON.stringify({ data: { invite: "preview" } }));
  });

  const result = await handler({
    method: "GET",
    path: "/api/invitations/preview",
    public: true,
  });
  assert.equal(result.success, true);
});

test("preserves policy and upgrade metadata from authenticated cloud failures", async () => {
  const state = { current: { token: "token-a", generation: 22 } };
  const handler = createHandler(
    state,
    async () =>
      new Response(
        JSON.stringify({
          error: "Upgrade required",
          code: "UPGRADE_REQUIRED",
          data: { minAppVersion: "2.0.0" },
        }),
        { status: 426 }
      )
  );

  const result = await handler({
    method: "POST",
    path: "/api/transcriptions/create",
    expectedAuthGeneration: 22,
  });

  assert.deepEqual(result, {
    success: false,
    error: "Upgrade required",
    status: 426,
    code: "UPGRADE_REQUIRED",
    details: { minAppVersion: "2.0.0" },
    minAppVersion: "2.0.0",
  });
});
