const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  FakeFlowError,
  fakeLinearFetch,
  gql,
  gqlError,
  offline,
  reset,
  memoryCredentials,
} = require("./linearFixtures");

const loadAuth = () => import("../../../src/helpers/connectors/linearAuth.js");
const loadApi = () => import("../../../src/helpers/connectors/linearApi.js");

const GRAPHQL = "/graphql";
const TOKEN = "/oauth/token";
const REVOKE = "/oauth/revoke";
const REDIRECT_URI = "http://127.0.0.1:5000/linear/callback";
const CLIENT_ID = "client-1";
const EXPIRED = { ...CONNECTED, expiresAt: NOW - 1 };
const OTHER_LOGIN = {
  ...CONNECTED,
  userId: "user-2",
  userName: "Sam",
  accessToken: "access-other",
  refreshToken: "refresh-other",
};
const REVOKED_OK = { status: 200, rawBody: "" };
const REFRESHED = { body: FIXTURES.refresh };
const IDENTIFIED = gql(FIXTURES.identity);
const CONNECTION_CHANGED = { ok: false, errorCode: "connection_changed" };
const RECONNECT_NEEDED = { ok: false, errorCode: "reconnect_needed" };
const SECRETS = /access-1|access-2|refresh-1|refresh-2|client-1|Dana|Acme/;
const oauthError = (status, error) => ({
  status,
  body: { error, error_description: "synthetic" },
});
const exchangeReply = (overrides = {}) => ({ body: { ...FIXTURES.exchange, ...overrides } });

// The loopback flow as Linear drives it: the browser comes back to the
// local server, and the same redirect URI goes to the authorize URL and the
// exchange. A test `flow` may change the logins while the browser is "out".
const signIn = (options) => options.handleCallback("code-1", REDIRECT_URI, "verifier-1");

async function setup({
  script = {},
  credential = CONNECTED,
  credentials: credentialsOverride,
  clientId = CLIENT_ID,
  logger,
  renderResultPage,
  redirectUri,
  flow = signIn,
} = {}) {
  const [{ createLinearAuth }, { createLinearApi }] = await Promise.all([loadAuth(), loadApi()]);
  const linear = fakeLinearFetch(script);
  const credentials =
    credentialsOverride ?? memoryCredentials(credential, { connectorId: "linear" });
  const flows = [];
  const auth = createLinearAuth({
    api: createLinearApi({ fetchImpl: linear.fetchImpl, sleep: async () => {} }),
    credentials,
    getClientId: () => clientId,
    OAuthFlowError: FakeFlowError,
    renderResultPage,
    ...(redirectUri === undefined ? {} : { redirectUri }),
    logger,
    now: () => NOW,
    runOAuthLoopbackFlow: async (options) => {
      flows.push({
        options,
        authUrl: new URL(options.buildAuthUrl(REDIRECT_URI, "state-1", "challenge-1")),
      });
      return flow(options, credentials);
    },
  });
  const slot = (account = "acct-1") => credentials.read(account, "linear")?.credential;
  return { auth, linear, credentials, flows, slot };
}

const hits = (linear, path) => linear.calls.filter((call) => call.path === path);
const revoked = (linear) => hits(linear, REVOKE).map((call) => call.form.token);

test("authorize asks for read, issues:create and comments:create only, with PKCE and no secret, and saves nothing", async () => {
  const { LINEAR_SCOPES, LINEAR_LOOPBACK } = await loadAuth();
  assert.equal(LINEAR_SCOPES, "read,issues:create,comments:create");
  assert.deepEqual(LINEAR_LOOPBACK, {
    ports: [0],
    callbackPath: "/linear/callback",
    timeoutMs: 300000,
  });
  const resultPage = () => "<html></html>";
  const { auth, linear, credentials, flows } = await setup({
    credential: null,
    script: { [TOKEN]: [exchangeReply()], [GRAPHQL]: { LinearIdentity: [IDENTIFIED] } },
    renderResultPage: resultPage,
  });

  const credential = await auth.authorize();

  const { options, authUrl } = flows[0];
  assert.equal(options.errorParam, "linear_error");
  assert.deepEqual(options.ports, [0]);
  assert.equal(options.callbackPath, "/linear/callback");
  assert.equal(options.timeoutMs, 300000);
  assert.equal(options.renderResultPage, resultPage);
  assert.equal(
    options.publicRedirectUri,
    null,
    "createLinearAuth defaults to no relay; buildLinearConnector passes it"
  );
  assert.equal(authUrl.origin + authUrl.pathname, "https://linear.app/oauth/authorize");
  assert.deepEqual(Object.fromEntries(authUrl.searchParams), {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    prompt: "consent",
    scope: "read,issues:create,comments:create",
    state: "state-1",
    code_challenge: "challenge-1",
    code_challenge_method: "S256",
  });
  assert.deepEqual(hits(linear, TOKEN)[0].form, {
    code: "code-1",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: "verifier-1",
    grant_type: "authorization_code",
  });
  const [identity] = hits(linear, GRAPHQL);
  assert.equal(identity.operation, "LinearIdentity");
  assert.equal(identity.authorization, "Bearer access-1");
  assert.deepEqual(credential, {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: NOW + 86399 * 1000,
    userId: "user-1",
    userName: "Dana",
    organizationId: "org-1",
    organizationName: "Acme",
    organizationUrlKey: "acme",
    // FIXTURES.exchange.scope is Linear's space-separated
    // "comments:create issues:create read"; the stored
    // scope preserves that order, comma-joined.
    scope: "comments:create,issues:create,read",
    needsReconnect: false,
  });
  assert.equal(credentials.saves.length, 0);
  assert.equal(credentials.read("acct-1", "linear"), null);
  assert.deepEqual(revoked(linear), []);
});

test("authorize hands the connect's cancel signal and the relay redirect to the loopback flow", async () => {
  const { auth, flows } = await setup({
    credential: null,
    redirectUri: "https://openwhispr.com/auth/linear/callback",
    script: { [TOKEN]: [exchangeReply()], [GRAPHQL]: { LinearIdentity: [IDENTIFIED] } },
  });
  const controller = new AbortController();

  await auth.authorize({ signal: controller.signal });

  assert.equal(flows[0].options.signal, controller.signal);
  assert.equal(flows[0].options.publicRedirectUri, "https://openwhispr.com/auth/linear/callback");
});

test("without a client id, authorize fails with not_configured before any browser opens", async () => {
  for (const clientId of [null, ""]) {
    const { auth, flows, linear } = await setup({ credential: null, clientId });
    assert.equal(auth.isConfigured(), false);
    await assert.rejects(auth.authorize(), (error) => error.code === "not_configured");
    assert.equal(flows.length, 0, "no browser opened");
    assert.deepEqual(linear.calls, []);
  }
  assert.equal((await setup()).auth.isConfigured(), true);
});

test("the granted scope is accepted as an array, a comma list or a space list, or when Linear doesn't report it", async () => {
  for (const scope of [
    ["comments:create", "read", "issues:create"],
    "read,issues:create,comments:create",
    "read issues:create comments:create",
    undefined,
  ]) {
    const { auth, linear } = await setup({
      credential: null,
      script: { [TOKEN]: [exchangeReply({ scope })], [GRAPHQL]: { LinearIdentity: [IDENTIFIED] } },
    });
    const credential = await auth.authorize();
    assert.equal(
      credential.scope.split(",").sort().join(","),
      "comments:create,issues:create,read"
    );
    assert.deepEqual(revoked(linear), [], JSON.stringify(scope));
  }
});

test("a grant missing a scope is revoked, saved nowhere, and fails permission_not_granted", async () => {
  for (const scope of [
    ["read"],
    ["read", "issues:create"],
    "read,comments:create",
    // Only the exact scope counts, never a longer one.
    ["read", "issues:create:all", "comments:create"],
    [],
  ]) {
    const label = JSON.stringify(scope);
    const { auth, linear, credentials } = await setup({
      credential: null,
      script: {
        [TOKEN]: [exchangeReply({ scope })],
        [GRAPHQL]: { LinearIdentity: [IDENTIFIED] },
        [REVOKE]: [REVOKED_OK],
      },
    });

    await assert.rejects(
      auth.authorize(),
      (error) => error.redirectCode === "permission_not_granted",
      label
    );

    assert.deepEqual(revoked(linear), ["refresh-1", "access-1"], label);
    assert.equal(hits(linear, GRAPHQL).length, 0, `${label}: identity never read`);
    assert.equal(credentials.saves.length, 0, label);
    assert.equal(credentials.read("acct-1", "linear"), null, label);
  }
});

test("a failed exchange, a grant without an access token, or an unreadable identity fails token_exchange_failed, revoking what was issued", async () => {
  const cases = [
    [{ [TOKEN]: [oauthError(400, "invalid_grant")] }, []],
    [{ [TOKEN]: [offline()] }, []],
    [{ [TOKEN]: [exchangeReply({ access_token: undefined })] }, ["refresh-1"]],
    [
      { [TOKEN]: [exchangeReply()], [GRAPHQL]: { LinearIdentity: [gqlError("FORBIDDEN")] } },
      ["refresh-1", "access-1"],
    ],
    [
      { [TOKEN]: [exchangeReply()], [GRAPHQL]: { LinearIdentity: [reset()] } },
      ["refresh-1", "access-1"],
    ],
    [
      {
        [TOKEN]: [exchangeReply()],
        [GRAPHQL]: {
          LinearIdentity: [gql({ viewer: { id: "user-1" }, organization: { id: "org-1" } })],
        },
      },
      ["refresh-1", "access-1"],
    ],
  ];
  for (const [index, [script, expected]] of cases.entries()) {
    const { auth, linear, credentials } = await setup({
      credential: null,
      script: { [REVOKE]: [REVOKED_OK], ...script },
    });

    await assert.rejects(
      auth.authorize(),
      (error) => error.redirectCode === "token_exchange_failed",
      `case ${index}`
    );

    assert.deepEqual(revoked(linear), expected, `case ${index}`);
    assert.equal(credentials.saves.length, 0, `case ${index}`);
  }
});

test("a grant without a refresh token or an expiry still connects, and is refreshed only when forced", async () => {
  const { auth, credentials } = await setup({
    credential: null,
    script: {
      [TOKEN]: [exchangeReply({ refresh_token: undefined, expires_in: undefined })],
      [GRAPHQL]: { LinearIdentity: [IDENTIFIED] },
    },
  });

  const credential = await auth.authorize();

  assert.equal(credential.refreshToken, null);
  assert.equal(credential.expiresAt, null);
  credentials.replace("acct-1", "linear", credential, 0);
  const binding = { ...BINDING, generation: 1 };
  assert.equal((await auth.getAccessToken(binding)).token, "access-1");
  // A 401 makes the connector force a refresh; with no refresh token, that
  // is a reconnect.
  assert.deepEqual(await auth.getAccessToken(binding, { forceRefresh: true }), RECONNECT_NEEDED);
});

// The connector manager saves what authorize returns, under the account and
// slot generation the Connect started from (Plan 2). These run Linear's
// authorize and revoke through the real manager.
async function connectThroughManager({ script, flow, credential = null }) {
  const [{ createConnectorManager }, { createPendingActions }] = await Promise.all([
    import("../../../src/helpers/connectors/connectorManager.js"),
    import("../../../src/helpers/connectors/pendingActions.js"),
  ]);
  const { auth, linear, credentials } = await setup({
    credential,
    flow,
    script: { [REVOKE]: [REVOKED_OK], ...script },
  });
  const connector = {
    id: "linear",
    actions: {},
    getStatus: async () => {
      const entry = credentials.read(credentials.activeAccountId(), "linear");
      return entry
        ? auth.statusOf(entry.credential)
        : { connected: false, accountLabel: null, workspaceLabel: null, needsReconnect: false };
    },
    getBinding: async () => null,
    authorize: auth.authorize,
    revoke: auth.revoke,
  };
  const manager = createConnectorManager({
    connectors: [connector],
    pendingActions: createPendingActions(),
    actionLog: {
      insert() {},
      update: () => 0,
      listRecent: () => [],
      reconcileInterrupted: () => ({ unknown: 0, cancelled: 0 }),
    },
    logger: { info() {}, warn() {}, error() {} },
    getAccountId: () => credentials.activeAccountId(),
    credentials,
  });
  const result = await manager.connect("linear", "allowed");
  return { result, linear, credentials };
}

const SIGNED_IN = { [TOKEN]: [exchangeReply()], [GRAPHQL]: { LinearIdentity: [IDENTIFIED] } };

test("Connect saves the Linear login under the account that started it", async () => {
  const { result, credentials, linear } = await connectThroughManager({ script: SIGNED_IN });

  assert.deepEqual(result, { status: "connected", accountLabel: "Dana", workspaceLabel: "Acme" });
  const saved = credentials.read("acct-1", "linear");
  assert.equal(saved.credential.userId, "user-1");
  assert.equal(saved.credential.organizationId, "org-1");
  assert.equal(saved.generation, 1);
  assert.deepEqual(revoked(linear), []);
});

test("a narrowed grant reaches Settings as permission_not_granted, revoked and saved nowhere", async () => {
  const { result, credentials, linear } = await connectThroughManager({
    script: { ...SIGNED_IN, [TOKEN]: [exchangeReply({ scope: ["read"] })] },
  });

  assert.deepEqual(result, { status: "failed", errorCode: "permission_not_granted" });
  assert.deepEqual(revoked(linear), ["refresh-1", "access-1"]);
  assert.equal(credentials.read("acct-1", "linear"), null);
});

test("an OpenWhispr account switch during the Linear round trip saves the login nowhere and revokes it", async () => {
  const { result, credentials, linear } = await connectThroughManager({
    script: SIGNED_IN,
    flow: async (options, store) => {
      store.switchAccount("acct-2");
      return signIn(options);
    },
  });

  assert.deepEqual(result, { status: "failed", errorCode: "connection_changed" });
  assert.deepEqual(revoked(linear), ["refresh-1", "access-1"]);
  assert.equal(credentials.read("acct-1", "linear"), null);
  assert.equal(credentials.read("acct-2", "linear"), null);
});

test("a login saved while the round trip was out wins: the late one is revoked, not saved", async () => {
  const { result, credentials, linear } = await connectThroughManager({
    script: SIGNED_IN,
    flow: async (options, store) => {
      store.replace("acct-1", "linear", OTHER_LOGIN, 0);
      return signIn(options);
    },
  });

  assert.deepEqual(result, { status: "failed", errorCode: "connection_changed" });
  assert.deepEqual(revoked(linear), ["refresh-1", "access-1"]);
  assert.deepEqual(credentials.read("acct-1", "linear").credential, OTHER_LOGIN);
});

test("a Disconnect while the round trip was out stays disconnected", async () => {
  const { result, credentials, linear } = await connectThroughManager({
    credential: OTHER_LOGIN,
    script: SIGNED_IN,
    flow: async (options, store) => {
      store.clear("acct-1", "linear", 1);
      return signIn(options);
    },
  });

  assert.deepEqual(result, { status: "failed", errorCode: "connection_changed" });
  assert.deepEqual(revoked(linear), ["refresh-1", "access-1"]);
  assert.equal(credentials.read("acct-1", "linear"), null);
});

test("a token is refreshed five minutes before it expires, not earlier", async () => {
  const { EXPIRY_SKEW_MS } = await loadAuth();
  assert.equal(EXPIRY_SKEW_MS, 5 * 60 * 1000);

  const early = await setup({ credential: { ...CONNECTED, expiresAt: NOW + 6 * 60 * 1000 } });
  assert.equal((await early.auth.getAccessToken(BINDING)).token, "access-1");
  assert.deepEqual(early.linear.calls, []);

  const late = await setup({
    credential: { ...CONNECTED, expiresAt: NOW + 4 * 60 * 1000 },
    script: { [TOKEN]: [REFRESHED] },
  });
  assert.equal((await late.auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(hits(late.linear, TOKEN).length, 1);
});

test("a token is handed out only for the Linear login and workspace the action is bound to", async () => {
  const { auth, credentials, linear } = await setup();
  assert.equal((await auth.getAccessToken(BINDING)).token, "access-1");

  assert.deepEqual(
    await auth.getAccessToken({ ...BINDING, workspaceId: "org-2" }),
    CONNECTION_CHANGED,
    "the same user in another workspace"
  );
  // The user reconnected as another Linear user.
  credentials.replace("acct-1", "linear", OTHER_LOGIN, 1);
  assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED);
  assert.deepEqual(
    await auth.getAccessToken({ ...BINDING, generation: 2 }),
    CONNECTION_CHANGED,
    "the current generation, but another Linear user"
  );
  assert.deepEqual(
    await auth.getAccessToken({ ...BINDING, ownerAccountId: "acct-2" }),
    CONNECTION_CHANGED
  );
  assert.deepEqual(await auth.getAccessToken(null), CONNECTION_CHANGED);
  assert.deepEqual(linear.calls, []);
});

test("concurrent callers share one refresh, with no client secret, saved under the binding's generation", async () => {
  const { auth, linear, credentials, slot } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [REFRESHED] },
  });

  const results = await Promise.all([
    auth.getAccessToken(BINDING),
    auth.getAccessToken(BINDING),
    auth.getAccessToken(BINDING, { forceRefresh: true }),
  ]);

  assert.equal(hits(linear, TOKEN).length, 1);
  assert.deepEqual(hits(linear, TOKEN)[0].form, {
    client_id: CLIENT_ID,
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
  });
  for (const result of results) assert.equal(result.token, "access-2");
  assert.equal(credentials.saves.length, 1);
  assert.deepEqual(slot(), {
    ...EXPIRED,
    accessToken: "access-2",
    expiresAt: NOW + 86399 * 1000,
    refreshToken: "refresh-2",
    // FIXTURES.refresh.scope is also Linear's space-separated
    // "comments:create issues:create read".
    scope: "comments:create,issues:create,read",
    needsReconnect: false,
  });
  assert.equal(credentials.generation("acct-1", "linear"), 1, "a refresh is not a new login");
});

test("a rotated refresh token is saved; without a new one the old one is kept", async () => {
  const rotated = await setup({ credential: EXPIRED, script: { [TOKEN]: [REFRESHED] } });
  await rotated.auth.getAccessToken(BINDING);
  assert.equal(rotated.slot().refreshToken, "refresh-2");

  const kept = await setup({
    credential: EXPIRED,
    script: {
      [TOKEN]: [{ body: { ...FIXTURES.refresh, refresh_token: undefined, scope: undefined } }],
    },
  });
  await kept.auth.getAccessToken(BINDING);
  assert.equal(kept.slot().refreshToken, "refresh-1");
  assert.equal(kept.slot().scope, CONNECTED.scope);
});

test("forceRefresh refreshes a token that still looks valid", async () => {
  const { auth, linear } = await setup({ script: { [TOKEN]: [REFRESHED] } });
  assert.equal((await auth.getAccessToken(BINDING, { forceRefresh: true })).token, "access-2");
  assert.equal(hits(linear, TOKEN).length, 1);
});

test("invalid_grant flags the login for reconnecting, keeps it, and asks Linear only once", async () => {
  const { OAUTH_LOGIN_GONE } = await loadAuth();
  assert.deepEqual([...OAUTH_LOGIN_GONE], ["invalid_grant"]);
  const { auth, linear, slot } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [oauthError(400, "invalid_grant")] },
  });

  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.equal(slot().needsReconnect, true);
  assert.equal(slot().refreshToken, "refresh-1", "kept, so Disconnect can still revoke it");
  assert.equal(auth.statusOf(slot()).needsReconnect, true);
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.equal(hits(linear, TOKEN).length, 1);

  const noRefreshToken = await setup({ credential: { ...EXPIRED, refreshToken: null } });
  assert.deepEqual(await noRefreshToken.auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(noRefreshToken.linear.calls, []);
});

test("a transient refresh failure keeps the login, is asked once more, then reports network", async () => {
  const replies = [
    offline(),
    reset(),
    { status: 503, rawBody: "<html>unavailable</html>" },
    oauthError(500, "server_error"),
    oauthError(400, "temporarily_unavailable"),
    { status: 429, rawBody: "" },
    // A throttle is never a verdict on the login, whatever its body says.
    oauthError(429, "rate_limited"),
    oauthError(408, "invalid_request"),
    { body: { token_type: "Bearer" } },
  ];
  for (const [index, reply] of replies.entries()) {
    const { auth, linear, slot } = await setup({
      credential: EXPIRED,
      script: { [TOKEN]: [reply] },
    });

    assert.deepEqual(
      await auth.getAccessToken(BINDING),
      { ok: false, errorCode: "network" },
      `case ${index}`
    );
    assert.equal(hits(linear, TOKEN).length, 2, `case ${index}`);
    assert.equal(slot().needsReconnect, false, `case ${index}`);
    assert.equal(slot().accessToken, "access-1", `case ${index}`);
  }
});

test("a refresh that fails once and then works hands out the new token", async () => {
  const { auth, linear } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [{ status: 503, rawBody: "busy" }, REFRESHED] },
  });
  assert.equal((await auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(hits(linear, TOKEN).length, 2);
});

test("a refused OAuth client is linear_unavailable: login kept, one call, logged without secrets", async () => {
  for (const [status, error] of [
    [401, "invalid_client"],
    [400, "unauthorized_client"],
  ]) {
    const warnings = [];
    const { auth, linear, slot } = await setup({
      credential: EXPIRED,
      logger: { warn: (...args) => warnings.push(args) },
      script: { [TOKEN]: [oauthError(status, error)] },
    });

    assert.deepEqual(
      await auth.getAccessToken(BINDING),
      { ok: false, errorCode: "linear_unavailable" },
      error
    );
    assert.equal(hits(linear, TOKEN).length, 1, error);
    assert.equal(slot().needsReconnect, false, error);
    assert.match(JSON.stringify(warnings), new RegExp(error));
    assert.doesNotMatch(JSON.stringify(warnings), SECRETS);
  }
});

test("a login made before the client id left the build reports linear_unavailable without calling Linear", async () => {
  const { auth, linear, slot } = await setup({ credential: EXPIRED, clientId: null });
  assert.deepEqual(await auth.getAccessToken(BINDING), {
    ok: false,
    errorCode: "linear_unavailable",
  });
  assert.deepEqual(linear.calls, []);
  assert.equal(slot().needsReconnect, false);
});

test("any other OAuth refusal of the refresh needs a reconnect, asked once, logged", async () => {
  for (const error of ["invalid_request", "invalid_scope", "unsupported_grant_type"]) {
    const warnings = [];
    const { auth, linear, slot } = await setup({
      credential: EXPIRED,
      logger: { warn: (...args) => warnings.push(args) },
      script: { [TOKEN]: [oauthError(400, error)] },
    });

    assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED, error);
    assert.equal(hits(linear, TOKEN).length, 1, `${error}: not asked again`);
    assert.equal(slot().needsReconnect, true, error);
    assert.match(JSON.stringify(warnings), new RegExp(error));
    assert.doesNotMatch(JSON.stringify(warnings), SECRETS);
  }
});

test("a reconnect during a refresh wins: connection_changed, not asked again, nothing written to the new login", async () => {
  const replies = [REFRESHED, oauthError(400, "invalid_grant"), { status: 503, rawBody: "busy" }];
  for (const [index, reply] of replies.entries()) {
    const credentials = memoryCredentials(EXPIRED, { connectorId: "linear" });
    let replaced = false;
    const { auth, linear, slot } = await setup({
      credentials,
      script: {
        [TOKEN]: [
          {
            ...reply,
            // Mid-flight: the user reconnects as another Linear user.
            during: () => {
              if (replaced) return;
              replaced = true;
              credentials.replace("acct-1", "linear", OTHER_LOGIN, 1);
            },
          },
        ],
      },
    });

    assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED, `case ${index}`);
    assert.deepEqual(slot(), OTHER_LOGIN, `case ${index}`);
    assert.equal(credentials.saves.length, 0, `case ${index}`);
    assert.equal(hits(linear, TOKEN).length, 1, `case ${index}: no retry for a replaced login`);
  }
});

test("a disconnect during a refresh leaves the login cleared", async () => {
  const credentials = memoryCredentials(EXPIRED, { connectorId: "linear" });
  const { auth } = await setup({
    credentials,
    script: {
      [TOKEN]: [{ ...REFRESHED, during: () => credentials.clear("acct-1", "linear", 1) }],
    },
  });

  assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED);
  assert.equal(credentials.read("acct-1", "linear"), null);
  assert.equal(credentials.saves.length, 0);
});

test("an OpenWhispr account switch during a refresh saves only into the account the action belongs to", async () => {
  const credentials = memoryCredentials(EXPIRED, { connectorId: "linear" });
  const { auth, slot } = await setup({
    credentials,
    script: { [TOKEN]: [{ ...REFRESHED, during: () => credentials.switchAccount("acct-2") }] },
  });

  assert.equal((await auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(slot("acct-1").accessToken, "access-2");
  assert.equal(credentials.read("acct-2", "linear"), null);
});

test("markReconnect flags only the bound login and reports reconnect_needed", async () => {
  const { auth, credentials, slot, linear } = await setup();

  assert.deepEqual(auth.markReconnect(BINDING), RECONNECT_NEEDED);

  assert.equal(slot().needsReconnect, true);
  assert.equal(slot().accessToken, CONNECTED.accessToken, "the rest of the login is kept");
  assert.equal(credentials.generation("acct-1", "linear"), 1, "a flag is not a new login");
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(linear.calls, []);
});

test("markReconnect after a reconnect reports connection_changed and writes nothing", async () => {
  const { auth, credentials, slot } = await setup();
  credentials.replace("acct-1", "linear", OTHER_LOGIN, 1);

  assert.deepEqual(auth.markReconnect(BINDING), CONNECTION_CHANGED);
  assert.deepEqual(slot(), OTHER_LOGIN);
  assert.equal(credentials.saves.length, 0);
});

test("a refreshed token that can't be saved is credential_save_failed, logged without the token", async () => {
  const warnings = [];
  const credentials = {
    read: () => ({ credential: EXPIRED, generation: 1 }),
    save: () => {
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
  };
  const { auth } = await setup({
    credentials,
    logger: { warn: (...args) => warnings.push(args) },
    script: { [TOKEN]: [REFRESHED] },
  });

  assert.deepEqual(await auth.getAccessToken(BINDING), {
    ok: false,
    errorCode: "credential_save_failed",
  });
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings), /ENOSPC/);
  assert.doesNotMatch(JSON.stringify(warnings), /access-2|refresh-2|no space left/);
});

test("revoke revokes the refresh token and the access token together, and never throws", async () => {
  const online = await setup({ script: { [REVOKE]: [REVOKED_OK] } });
  await online.auth.revoke(CONNECTED);
  assert.deepEqual(revoked(online.linear), ["refresh-1", "access-1"]);
  assert.deepEqual(
    hits(online.linear, REVOKE).map((call) => call.authorization),
    [null, null],
    "the token goes in the form only"
  );

  // Neither waits on the other: both are out before either answers.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let sent = 0;
  const { createLinearAuth } = await import("../../../src/helpers/connectors/linearAuth.js");
  const parallel = createLinearAuth({
    api: {
      revokeToken: async () => {
        sent += 1;
        await held;
        return { ok: true };
      },
    },
    credentials: null,
    getClientId: () => "client-1",
  });
  const revoking = parallel.revoke(CONNECTED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent, 2);
  release();
  await revoking;

  const accessOnly = await setup({ script: { [REVOKE]: [REVOKED_OK] } });
  await accessOnly.auth.revoke({ ...CONNECTED, refreshToken: null });
  assert.deepEqual(revoked(accessOnly.linear), ["access-1"]);

  const unreachable = await setup({ script: { [REVOKE]: [offline()] } });
  await assert.doesNotReject(unreachable.auth.revoke(CONNECTED));
  assert.equal(hits(unreachable.linear, REVOKE).length, 2, "the access token is still tried");

  const throwing = await setup();
  await assert.doesNotReject(
    throwing.auth.revoke(CONNECTED),
    "an unscripted revoke is a network error"
  );

  const empty = await setup();
  await empty.auth.revoke({});
  await empty.auth.revoke(null);
  assert.deepEqual(empty.linear.calls, []);
});

test("a failed revoke is logged by token kind, never the token, and both are still tried", async () => {
  const warnings = [];
  const { auth, linear } = await setup({
    logger: { warn: (...args) => warnings.push(args) },
    script: { [REVOKE]: [offline()] },
  });

  await assert.doesNotReject(auth.revoke(CONNECTED));

  assert.equal(hits(linear, REVOKE).length, 2, "both tokens still tried");
  assert.equal(warnings.length, 2);
  assert.deepEqual(
    warnings.map(([, data]) => data.tokenKind),
    ["refresh", "access"]
  );
  assert.doesNotMatch(JSON.stringify(warnings), SECRETS);
});

test("the status shows the user and the workspace, and the reconnect flag", async () => {
  const { auth } = await setup();
  assert.deepEqual(auth.statusOf(CONNECTED), {
    connected: true,
    accountLabel: "Dana",
    workspaceLabel: "Acme",
    needsReconnect: false,
  });
  assert.equal(auth.statusOf({ ...CONNECTED, needsReconnect: true }).needsReconnect, true);
  assert.deepEqual(auth.statusOf({ ...CONNECTED, userName: null, organizationName: null }), {
    connected: true,
    accountLabel: null,
    workspaceLabel: null,
    needsReconnect: false,
  });
});
