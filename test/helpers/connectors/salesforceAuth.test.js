const test = require("node:test");
const assert = require("node:assert/strict");
const { createSalesforceAuth } = require("../../../src/helpers/connectors/salesforceAuth");
const { createSalesforceApi } = require("../../../src/helpers/connectors/salesforceApi");
const { FakeFlowError, memoryCredentials } = require("./linearFixtures");
const SALESFORCE_CALLBACK_URL = "http://localhost:1718/salesforce/callback";
const INSTANCE = "https://acme.my.salesforce.com";
const NOW = 1700000000000;
const CONNECTED = {
  userId: "005000000000001",
  userName: "Dana",
  organizationId: "00D000000000001",
  organizationName: "acme.my.salesforce.com",
  instanceUrl: INSTANCE,
  loginUrl: "https://login.salesforce.com",
  clientId: "client",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: null,
  scope: "api openid refresh_token",
  needsReconnect: false,
};
const BINDING = {
  ownerAccountId: "acct-1",
  accountId: CONNECTED.userId,
  workspaceId: CONNECTED.organizationId,
  generation: 1,
  instanceUrl: INSTANCE,
};
const TOKENS = {
  access_token: "access-2",
  refresh_token: "refresh-2",
  instance_url: INSTANCE,
  scope: "api openid refresh_token",
};
const IDENTITY = {
  user_id: CONNECTED.userId,
  organization_id: CONNECTED.organizationId,
  preferred_username: "Dana",
};

function setup({
  credential = CONNECTED,
  refresh,
  identity = IDENTITY,
  tokens = TOKENS,
  identityResult = null,
  clientId = "client",
  loginUrl = "https://login.salesforce.com",
} = {}) {
  const credentials = memoryCredentials(credential, { connectorId: "salesforce" });
  const calls = [];
  const flows = [];
  const api = {
    exchangeToken: async (...args) => {
      calls.push(["exchange", ...args]);
      return { ok: true, data: tokens };
    },
    refreshToken: async (...args) => {
      calls.push(["refresh", ...args]);
      return refresh ? refresh(credentials) : { ok: true, data: tokens };
    },
    revokeToken: async (...args) => {
      calls.push(["revoke", ...args]);
      return { ok: true };
    },
    request: async (...args) => {
      calls.push(["identity", ...args]);
      return identityResult ?? { ok: true, data: identity };
    },
  };
  const auth = createSalesforceAuth({
    api,
    credentials,
    getClientId: () => clientId,
    getLoginUrl: () => loginUrl,
    OAuthFlowError: FakeFlowError,
    now: () => NOW,
    runOAuthLoopbackFlow: async (options) => {
      flows.push(options);
      return options.handleCallback("code", SALESFORCE_CALLBACK_URL, "verifier");
    },
  });
  return { auth, credentials, calls, flows };
}

test("authorization delegates validated state and PKCE to loopback, with fixed callback and no client secret", async () => {
  const { auth, calls, flows, credentials } = setup({ credential: null });
  const controller = new AbortController();
  const credential = await auth.authorize({ signal: controller.signal });
  const options = flows[0];
  const url = new URL(options.buildAuthUrl(SALESFORCE_CALLBACK_URL, "state", "challenge"));
  assert.equal(url.origin, "https://login.salesforce.com");
  assert.equal(url.pathname, "/services/oauth2/authorize");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "api refresh_token openid");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1718/salesforce/callback");
  assert.deepEqual(options.ports, [1718]);
  assert.equal(options.redirectHost, "localhost");
  assert.equal(options.callbackPath, "/salesforce/callback");
  assert.equal(options.signal, controller.signal);
  assert.equal(calls[0][1].client_secret, undefined);
  assert.equal(calls[0][1].code_verifier, "verifier");
  assert.equal(credential.organizationId, CONNECTED.organizationId);
  assert.equal(credential.userId, CONNECTED.userId);
  assert.equal(credential.instanceUrl, INSTANCE);
  assert.equal(credentials.saves.length, 0);
});

test("invalid client or login configuration cannot open a browser", async () => {
  for (const config of [
    { clientId: "" },
    { loginUrl: "https://evil.test" },
    { loginUrl: "https://999.999.999.999" },
    { loginUrl: INSTANCE + "/path" },
  ]) {
    const { auth, flows } = setup(config);
    assert.equal(auth.isConfigured(), false);
    await assert.rejects(auth.authorize(), { code: "not_configured" });
    assert.equal(flows.length, 0);
  }
});

test("refuses and revokes grants missing refresh, API scope, valid instance or identity", async () => {
  for (const config of [
    { tokens: { ...TOKENS, refresh_token: null } },
    { tokens: { ...TOKENS, scope: "openid" } },
    { tokens: { ...TOKENS, instance_url: "https://evil.test" } },
    { identity: { ...IDENTITY, organization_id: "bad" } },
  ]) {
    const { auth, calls } = setup(config);
    await assert.rejects(auth.authorize());
    assert.ok(calls.some(([kind]) => kind === "revoke"));
    if (config.tokens?.instance_url === "https://evil.test")
      assert.ok(!calls.some(([kind]) => kind === "identity"));
  }
});

test("binding checks include account owner, org, instance and connection generation before token use", async () => {
  const { auth, calls } = setup();
  assert.equal((await auth.getAccessToken(BINDING)).token, "access-1");
  for (const changes of [
    { ownerAccountId: "acct-2" },
    { accountId: "005000000000002" },
    { workspaceId: "00D000000000002" },
    { instanceUrl: "https://other.my.salesforce.com" },
    { generation: 2 },
  ]) {
    assert.deepEqual(await auth.getAccessToken({ ...BINDING, ...changes }), {
      ok: false,
      errorCode: "connection_changed",
    });
  }
  assert.equal(calls.length, 0);
  const switched = setup();
  switched.credentials.switchAccount("acct-2");
  assert.equal((await switched.auth.getAccessToken(BINDING)).errorCode, "connection_changed");
});

test("refresh rotates and persists tokens before use, retaining refresh when omitted", async () => {
  for (const tokens of [TOKENS, { ...TOKENS, refresh_token: undefined }]) {
    const { auth, credentials } = setup({ tokens });
    const result = await auth.getAccessToken(BINDING, { forceRefresh: true });
    assert.equal(result.token, "access-2");
    const stored = credentials.read("acct-1", "salesforce").credential;
    assert.equal(stored.refreshToken, tokens.refresh_token ?? "refresh-1");
    assert.equal(stored.accessToken, result.token);
  }
});

test("refresh cannot replace a newer login or cross an org or instance boundary", async () => {
  const swapped = setup({
    refresh: async (credentials) => {
      credentials.replace("acct-1", "salesforce", { ...CONNECTED, accessToken: "other" }, 1);
      return { ok: true, data: TOKENS };
    },
  });
  assert.equal(
    (await swapped.auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
    "connection_changed"
  );
  assert.equal(swapped.credentials.saves.length, 0);
  for (const config of [
    { tokens: { ...TOKENS, instance_url: "https://other.my.salesforce.com" } },
    { identity: { ...IDENTITY, organization_id: "00D000000000002" } },
  ]) {
    const { auth, credentials } = setup(config);
    assert.equal(
      (await auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
      "reconnect_needed"
    );
    assert.equal(credentials.read("acct-1", "salesforce").credential.accessToken, "access-1");
  }
});

test("a refused refresh flags the login for reconnect without an automatic retry", async () => {
  // The sign-in host moved (a renamed My Domain): net.fetch rejects the redirect.
  const moved = createSalesforceApi({
    fetchImpl: async () => {
      throw new Error("Redirect was cancelled");
    },
  });
  for (const refresh of [
    async () => ({
      ok: false,
      errorCode: "invalid_grant",
      refused: true,
      status: 400,
      outcome: "failed",
    }),
    async () => ({
      ok: false,
      errorCode: "inactive_user",
      refused: true,
      status: 400,
      outcome: "failed",
    }),
    () => moved.refreshToken({ client_id: "client" }, "https://login.salesforce.com"),
  ]) {
    const { auth, calls, credentials } = setup({ refresh });
    assert.equal(
      (await auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
      "reconnect_needed"
    );
    assert.equal(calls.filter(([kind]) => kind === "refresh").length, 1);
    assert.equal(credentials.read("acct-1", "salesforce").credential.needsReconnect, true);
  }
});

test("a refresh refused for the app's own client never flags the user's login", async () => {
  for (const errorCode of ["invalid_client", "invalid_client_id", "unauthorized_client"]) {
    const { auth, credentials } = setup({
      refresh: async () => ({
        ok: false,
        errorCode,
        refused: true,
        status: 400,
        outcome: "failed",
      }),
    });
    assert.equal(
      (await auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
      "salesforce_unavailable"
    );
    assert.equal(credentials.read("acct-1", "salesforce").credential.needsReconnect, false);
  }
});

test("a refresh Salesforce couldn't answer keeps the login for the next action", async () => {
  for (const [response, errorCode] of [
    [{ ok: false, errorCode: "network", outcome: "unknown" }, "network"],
    [{ ok: false, errorCode: "http_503", status: 503, outcome: "unknown" }, "network"],
    [
      { ok: false, errorCode: "http_408", status: 408, refused: true, outcome: "failed" },
      "network",
    ],
    [
      { ok: false, errorCode: "http_429", status: 429, refused: true, outcome: "failed" },
      "rate_limited",
    ],
    [
      {
        ok: false,
        errorCode: "rate_limit_exceeded",
        status: 400,
        refused: true,
        outcome: "failed",
      },
      "rate_limited",
    ],
  ]) {
    const { auth, calls, credentials } = setup({ refresh: async () => response });
    assert.equal((await auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode, errorCode);
    assert.equal(calls.filter(([kind]) => kind === "refresh").length, 1);
    const stored = credentials.read("acct-1", "salesforce").credential;
    assert.equal(stored.needsReconnect, false);
    assert.equal(stored.refreshToken, "refresh-1");
  }
});

test("a rotated refresh token is saved before the identity check, which keeps the login when it can't answer", async () => {
  const unanswered = setup({
    identityResult: { ok: false, errorCode: "network", outcome: "unknown" },
  });
  assert.equal(
    (await unanswered.auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
    "network"
  );
  const kept = unanswered.credentials.read("acct-1", "salesforce").credential;
  assert.equal(kept.refreshToken, "refresh-2");
  assert.equal(kept.accessToken, "access-1", "the unverified access token is never saved");
  assert.equal(kept.needsReconnect, false);
  const refused = setup({
    identityResult: { ok: false, errorCode: "http_403", status: 403, refused: true },
  });
  assert.equal(
    (await refused.auth.getAccessToken(BINDING, { forceRefresh: true })).errorCode,
    "reconnect_needed"
  );
  const flagged = refused.credentials.read("acct-1", "salesforce").credential;
  assert.equal(flagged.refreshToken, "refresh-2");
  assert.equal(flagged.needsReconnect, true);
});

test("simultaneous refreshes share one request and save failure never exposes the new token", async () => {
  const { auth, calls } = setup();
  const results = await Promise.all([
    auth.getAccessToken(BINDING, { forceRefresh: true }),
    auth.getAccessToken(BINDING, { forceRefresh: true }),
  ]);
  assert.ok(results.every((result) => result.token === "access-2"));
  assert.equal(calls.filter(([kind]) => kind === "refresh").length, 1);
  const failed = setup();
  failed.credentials.save = () => {
    throw new Error("disk unavailable");
  };
  assert.deepEqual(await failed.auth.getAccessToken(BINDING, { forceRefresh: true }), {
    ok: false,
    errorCode: "credential_save_failed",
  });
});

test("disconnect revokes at the saved OAuth host and status contains only display identity", async () => {
  const { auth, calls } = setup();
  await auth.revoke({ ...CONNECTED, loginUrl: "https://test.salesforce.com" });
  assert.deepEqual(calls, [["revoke", "refresh-1", "https://test.salesforce.com"]]);
  assert.deepEqual(auth.statusOf(CONNECTED), {
    connected: true,
    accountLabel: "Dana",
    workspaceLabel: "acme.my.salesforce.com",
    needsReconnect: false,
  });
});

test("a sandbox or My Domain typed at connect is where the user signs in, exchanges and refreshes", async () => {
  for (const [typed, origin] of [
    ["test.salesforce.com", "https://test.salesforce.com"],
    [
      " https://acme--uat.sandbox.my.salesforce.com/ ",
      "https://acme--uat.sandbox.my.salesforce.com",
    ],
  ]) {
    const { auth, calls, flows } = setup({ credential: null });
    const credential = await auth.authorize({ loginDomain: typed });
    const url = new URL(flows[0].buildAuthUrl(SALESFORCE_CALLBACK_URL, "state", "challenge"));
    assert.equal(url.origin, origin);
    assert.equal(url.searchParams.get("prompt"), "login consent");
    assert.equal(calls.find(([kind]) => kind === "exchange")[2], origin);
    assert.equal(credential.loginUrl, origin);
    // The login refreshes at its own host, not the build's default.
    const refreshing = setup({ credential: { ...CONNECTED, loginUrl: origin } });
    assert.equal(
      (await refreshing.auth.getAccessToken(BINDING, { forceRefresh: true })).token,
      "access-2"
    );
    assert.equal(refreshing.calls.find(([kind]) => kind === "refresh")[2], origin);
  }
});

test("a typed domain that isn't a Salesforce sign-in host opens no browser", async () => {
  for (const typed of ["evil.test", "acme.lightning.force.com", "acme.my.salesforce.com/path"]) {
    const { auth, flows } = setup({ credential: null });
    await assert.rejects(auth.authorize({ loginDomain: typed }), { code: "invalid_login_domain" });
    assert.equal(flows.length, 0);
  }
});

test("Reconnect signs in again at the host the login was made on", async () => {
  const { auth, flows } = setup({
    credential: { ...CONNECTED, loginUrl: "https://test.salesforce.com" },
  });
  await auth.authorize();
  const url = new URL(flows[0].buildAuthUrl(SALESFORCE_CALLBACK_URL, "state", "challenge"));
  assert.equal(url.origin, "https://test.salesforce.com");
});
