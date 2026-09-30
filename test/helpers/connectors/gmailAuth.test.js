const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  CONNECTED,
  BINDING,
  GRANTED,
  FakeFlowError,
  fakeGoogleFetch,
  idToken,
  offline,
  reset,
  memoryCredentials,
  GOOGLE_REVOKE_OK,
} = require("./gmailFixtures");

const loadAuth = () => import("../../../src/helpers/connectors/gmailAuth.js");
const loadApi = () => import("../../../src/helpers/connectors/gmailApi.js");

const TOKEN = "/token";
const REVOKE = "/revoke";
const REDIRECT_URI = "http://127.0.0.1:5000";
const CLIENT = { clientId: "client-1.apps.googleusercontent.com", clientSecret: "secret-1" };
const EXPIRED = { ...CONNECTED, expiresAt: NOW - 1 };
const OTHER_LOGIN = {
  ...CONNECTED,
  sub: "sub-2",
  email: "other@example.test",
  accessToken: "access-other",
  refreshToken: "refresh-other",
};
const REVOKED_OK = GOOGLE_REVOKE_OK;
const REFRESHED = {
  body: { access_token: "access-2", expires_in: 3599, scope: GRANTED, token_type: "Bearer" },
};
const CONNECTION_CHANGED = { ok: false, errorCode: "connection_changed" };
const RECONNECT_NEEDED = { ok: false, errorCode: "reconnect_needed" };
const oauthError = (status, error) => ({
  status,
  body: { error, error_description: "synthetic" },
});

function exchangeReply({ scope = GRANTED, claims = {}, omit = [] } = {}) {
  const body = {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3599,
    scope,
    token_type: "Bearer",
    id_token: idToken({
      iss: "https://accounts.google.com",
      sub: "sub-1",
      email: "you@example.test",
      email_verified: true,
      ...claims,
    }),
  };
  for (const key of omit) delete body[key];
  return { body };
}

async function setup({
  script = {},
  credential = CONNECTED,
  credentials: credentialsOverride,
  client = CLIENT,
  logger,
  renderResultPage,
  sharesGrant,
} = {}) {
  const [{ createGmailAuth }, { createGmailApi }] = await Promise.all([loadAuth(), loadApi()]);
  const google = fakeGoogleFetch(script);
  const credentials =
    credentialsOverride ?? memoryCredentials(credential, { connectorId: "gmail" });
  const flows = [];
  const auth = createGmailAuth({
    api: createGmailApi({ fetchImpl: google.fetchImpl, sleep: async () => {} }),
    credentials,
    getClientCredentials: () => client,
    OAuthFlowError: FakeFlowError,
    renderResultPage,
    sharesGrant,
    logger,
    now: () => NOW,
    // Like the real flow: Google redirects to the loopback server itself, and
    // the same redirect URI goes to the authorize URL and the exchange.
    runOAuthLoopbackFlow: async (options) => {
      flows.push({
        options,
        authUrl: new URL(options.buildAuthUrl(REDIRECT_URI, "state-1", "challenge-1")),
      });
      return options.handleCallback("code-1", REDIRECT_URI, "verifier-1");
    },
  });
  const slot = (account = "acct-1") => credentials.read(account, "gmail")?.credential;
  return { auth, google, credentials, flows, slot };
}

const hits = (google, path) => google.calls.filter((call) => call.path === path);

test("authorize asks only for gmail.send, exchanges with the PKCE verifier, and saves nothing", async () => {
  const resultPage = () => "<html></html>";
  const { auth, google, credentials, flows } = await setup({
    credential: null,
    script: { [TOKEN]: [exchangeReply()] },
    renderResultPage: resultPage,
  });

  const credential = await auth.authorize();

  const { options, authUrl } = flows[0];
  assert.equal(options.errorParam, "gmail_error");
  assert.deepEqual(options.ports, [0]);
  assert.equal(options.callbackPath, "");
  assert.equal(options.timeoutMs, 300000);
  assert.equal(options.renderResultPage, resultPage);
  assert.equal(options.publicRedirectUri, undefined, "Google redirects straight to the loopback");
  assert.equal(authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(authUrl.searchParams), {
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state: "state-1",
    code_challenge: "challenge-1",
    code_challenge_method: "S256",
  });
  assert.deepEqual(hits(google, TOKEN)[0].form, {
    code: "code-1",
    client_id: CLIENT.clientId,
    client_secret: "secret-1",
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: "verifier-1",
  });
  assert.deepEqual(credential, {
    email: "you@example.test",
    sub: "sub-1",
    // The client the refresh token belongs to (see the client-change test).
    clientId: CLIENT.clientId,
    refreshToken: "refresh-1",
    accessToken: "access-1",
    expiresAt: NOW + 3599 * 1000,
    scope: GRANTED,
    needsReconnect: false,
  });
  assert.equal(credentials.saves.length, 0);
  assert.equal(credentials.read("acct-1", "gmail"), null);
  assert.equal(hits(google, REVOKE).length, 0);
});

test("authorize hands the connect's cancel signal to the loopback flow", async () => {
  const { auth, flows } = await setup({
    credential: null,
    script: { [TOKEN]: [exchangeReply()] },
  });
  const controller = new AbortController();

  await auth.authorize({ signal: controller.signal });

  assert.equal(flows[0].options.signal, controller.signal);
});

test("a Workspace admin block or org-restricted app maps to domain_policy; other denials stay oauth_denied", async () => {
  const { createGmailAuth } = await loadAuth();
  for (const [providerError, expectedCode] of [
    ["admin_policy_enforced", "domain_policy"],
    ["org_internal", "domain_policy"],
    ["access_denied", "oauth_denied"],
  ]) {
    const credentials = memoryCredentials(null, { connectorId: "gmail" });
    const auth = createGmailAuth({
      api: {},
      credentials,
      getClientCredentials: () => CLIENT,
      OAuthFlowError: FakeFlowError,
      now: () => NOW,
      // Mirrors oauthLoopbackFlow.js: a provider `error` redirect rejects
      // with code "oauth_denied" and the raw value as providerError.
      runOAuthLoopbackFlow: async () => {
        throw Object.assign(new Error(`OAuth error: ${providerError}`), {
          code: "oauth_denied",
          providerError,
        });
      },
    });

    await assert.rejects(auth.authorize(), (error) => error.code === expectedCode, providerError);
    assert.equal(credentials.saves.length, 0, providerError);
  }
});

test("without a complete Google client, authorize fails fast with not_configured", async () => {
  for (const client of [
    { clientId: null, clientSecret: null },
    { clientId: CLIENT.clientId, clientSecret: null },
    { clientId: null, clientSecret: "secret-1" },
  ]) {
    const { auth, flows, google } = await setup({ credential: null, client });
    assert.equal(auth.isConfigured(), false);
    await assert.rejects(auth.authorize(), (error) => error.code === "not_configured");
    assert.equal(flows.length, 0, "no browser opened");
    assert.deepEqual(google.calls, []);
  }
  assert.equal((await setup()).auth.isConfigured(), true);
});

test("the Gmail client falls back to the calendar client as a pair, never mixing the two", async () => {
  const { gmailClientCredentials } = await loadAuth();
  const calendar = {
    GOOGLE_CALENDAR_CLIENT_ID: "cal-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "cal-secret",
  };
  const NONE = { clientId: null, clientSecret: null };
  const CALENDAR = { clientId: "cal-id", clientSecret: "cal-secret" };

  assert.deepEqual(gmailClientCredentials({}), NONE);
  assert.deepEqual(gmailClientCredentials(undefined), NONE);
  assert.deepEqual(gmailClientCredentials(calendar), CALENDAR);
  assert.deepEqual(
    gmailClientCredentials({
      ...calendar,
      GMAIL_CLIENT_ID: "gm-id",
      GMAIL_CLIENT_SECRET: "gm-secret",
    }),
    { clientId: "gm-id", clientSecret: "gm-secret" }
  );
  // Half a Gmail pair is ignored: an id with another client's secret is a
  // pair Google refuses (invalid_client).
  assert.deepEqual(gmailClientCredentials({ ...calendar, GMAIL_CLIENT_ID: "gm-id" }), CALENDAR);
  assert.deepEqual(
    gmailClientCredentials({ ...calendar, GMAIL_CLIENT_SECRET: "gm-secret" }),
    CALENDAR
  );
  assert.deepEqual(gmailClientCredentials({ GMAIL_CLIENT_ID: "", ...calendar }), CALENDAR);
  // No complete pair at all: not configured.
  assert.deepEqual(gmailClientCredentials({ GMAIL_CLIENT_ID: "gm-id" }), NONE);
  assert.deepEqual(
    gmailClientCredentials({
      GMAIL_CLIENT_ID: "gm-id",
      GOOGLE_CALENDAR_CLIENT_SECRET: "cal-secret",
    }),
    NONE
  );
  assert.deepEqual(gmailClientCredentials({ GOOGLE_CALENDAR_CLIENT_ID: "cal-id" }), NONE);
});

test("a grant without gmail.send is revoked, saved nowhere, and fails permission_not_granted", async () => {
  for (const reply of [
    // The user unticked "Send email on your behalf".
    exchangeReply({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }),
    // Only the exact scope counts, never a prefix of another one.
    exchangeReply({
      scope: "openid https://www.googleapis.com/auth/gmail.send.fake",
    }),
    exchangeReply({ omit: ["scope"] }),
  ]) {
    const label = String(reply.body.scope);
    const { auth, google, credentials } = await setup({
      credential: null,
      script: { [TOKEN]: [reply], [REVOKE]: [REVOKED_OK] },
    });

    await assert.rejects(
      auth.authorize(),
      (error) => error.redirectCode === "permission_not_granted"
    );

    assert.deepEqual(
      hits(google, REVOKE).map((call) => call.form),
      [{ token: "refresh-1" }],
      label
    );
    assert.equal(credentials.saves.length, 0, label);
  }
});

test("an unverified or missing Google address is revoked and fails email_not_verified", async () => {
  const replies = [
    exchangeReply({ claims: { email_verified: false } }),
    exchangeReply({ claims: { email_verified: undefined } }),
    exchangeReply({ claims: { email: undefined } }),
    exchangeReply({ claims: { sub: undefined } }),
    { body: { ...exchangeReply().body, id_token: "not-a-jwt" } },
  ];
  for (const [index, reply] of replies.entries()) {
    const { auth, google, credentials } = await setup({
      credential: null,
      script: { [TOKEN]: [reply], [REVOKE]: [REVOKED_OK] },
    });

    await assert.rejects(auth.authorize(), (error) => error.redirectCode === "email_not_verified");

    assert.deepEqual(
      hits(google, REVOKE).map((call) => call.form),
      [{ token: "refresh-1" }],
      `case ${index}`
    );
    assert.equal(credentials.saves.length, 0, `case ${index}`);
  }
});

test("a failed exchange or a grant missing a token fails token_exchange_failed, revoking what was issued", async () => {
  const cases = [
    [oauthError(400, "invalid_grant"), []],
    [exchangeReply({ omit: ["refresh_token"] }), [{ token: "access-1" }]],
    [exchangeReply({ omit: ["id_token"] }), [{ token: "refresh-1" }]],
    [exchangeReply({ omit: ["access_token"] }), [{ token: "refresh-1" }]],
  ];
  for (const [index, [reply, revoked]] of cases.entries()) {
    const { auth, google } = await setup({
      credential: null,
      script: { [TOKEN]: [reply], [REVOKE]: [REVOKED_OK] },
    });

    await assert.rejects(
      auth.authorize(),
      (error) => error.redirectCode === "token_exchange_failed"
    );

    assert.deepEqual(
      hits(google, REVOKE).map((call) => call.form),
      revoked,
      `case ${index}`
    );
  }
});

test("a token is refreshed five minutes before it expires, not earlier", async () => {
  const { EXPIRY_SKEW_MS } = await loadAuth();
  assert.equal(EXPIRY_SKEW_MS, 5 * 60 * 1000);

  const early = await setup({ credential: { ...CONNECTED, expiresAt: NOW + 6 * 60 * 1000 } });
  assert.equal((await early.auth.getAccessToken(BINDING)).token, "access-1");
  assert.deepEqual(early.google.calls, []);

  const late = await setup({
    credential: { ...CONNECTED, expiresAt: NOW + 4 * 60 * 1000 },
    script: { [TOKEN]: [REFRESHED] },
  });
  assert.equal((await late.auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(hits(late.google, TOKEN).length, 1);
});

test("a token is handed out only for the Google login the action is bound to", async () => {
  const { auth, credentials, google } = await setup();
  assert.equal((await auth.getAccessToken(BINDING)).token, "access-1");

  // The user reconnected as another Google account.
  credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1);
  assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED);
  assert.deepEqual(
    await auth.getAccessToken({ ...BINDING, generation: 2 }),
    CONNECTION_CHANGED,
    "the current generation, but another Google account"
  );
  assert.deepEqual(
    await auth.getAccessToken({ ...BINDING, ownerAccountId: "acct-2" }),
    CONNECTION_CHANGED
  );
  assert.deepEqual(await auth.getAccessToken(null), CONNECTION_CHANGED);
  assert.deepEqual(google.calls, []);
});

test("concurrent callers share one refresh, saved under the binding's generation", async () => {
  const { auth, google, credentials, slot } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [REFRESHED] },
  });

  const results = await Promise.all([
    auth.getAccessToken(BINDING),
    auth.getAccessToken(BINDING),
    auth.getAccessToken(BINDING, { forceRefresh: true }),
  ]);

  assert.equal(hits(google, TOKEN).length, 1);
  assert.deepEqual(hits(google, TOKEN)[0].form, {
    client_id: CLIENT.clientId,
    client_secret: "secret-1",
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
  });
  for (const result of results) assert.equal(result.token, "access-2");
  assert.equal(credentials.saves.length, 1);
  assert.deepEqual(slot(), {
    ...EXPIRED,
    accessToken: "access-2",
    expiresAt: NOW + 3599 * 1000,
    refreshToken: "refresh-1",
    scope: GRANTED,
    needsReconnect: false,
  });
  assert.equal(credentials.generation("acct-1", "gmail"), 1, "a refresh is not a new login");
});

test("Google's refresh token is kept unless Google returns a new one", async () => {
  const { auth, slot } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [{ body: { ...REFRESHED.body, refresh_token: "refresh-2" } }] },
  });

  await auth.getAccessToken(BINDING);

  assert.equal(slot().refreshToken, "refresh-2");
});

test("forceRefresh refreshes a token that still looks valid", async () => {
  const { auth, google } = await setup({ script: { [TOKEN]: [REFRESHED] } });
  assert.equal((await auth.getAccessToken(BINDING, { forceRefresh: true })).token, "access-2");
  assert.equal(hits(google, TOKEN).length, 1);
});

test("invalid_grant flags the login for reconnecting, keeps it, and asks Google only once", async () => {
  const { auth, google, slot } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [oauthError(400, "invalid_grant")] },
  });

  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.equal(slot().needsReconnect, true);
  assert.equal(slot().refreshToken, "refresh-1", "kept, so Disconnect can still revoke it");
  assert.equal(auth.statusOf(slot()).needsReconnect, true);
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.equal(hits(google, TOKEN).length, 1);

  const noRefreshToken = await setup({ credential: { ...EXPIRED, refreshToken: null } });
  assert.deepEqual(await noRefreshToken.auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(noRefreshToken.google.calls, []);
});

test("network errors, 5xx, temporarily_unavailable and unreadable answers keep the login, are asked once more, then report network", async () => {
  const replies = [
    offline(),
    reset(),
    { status: 503, rawBody: "<html>unavailable</html>" },
    oauthError(503, "temporarily_unavailable"),
    oauthError(400, "temporarily_unavailable"),
    { body: { token_type: "Bearer" } },
  ];
  for (const [index, reply] of replies.entries()) {
    const { auth, google, slot } = await setup({
      credential: EXPIRED,
      script: { [TOKEN]: [reply] },
    });

    assert.deepEqual(
      await auth.getAccessToken(BINDING),
      { ok: false, errorCode: "network" },
      `case ${index}`
    );
    assert.equal(hits(google, TOKEN).length, 2, `case ${index}`);
    assert.equal(slot().needsReconnect, false, `case ${index}`);
    assert.equal(slot().accessToken, "access-1", `case ${index}`);
  }
});

test("a refresh that fails once and then works hands out the new token", async () => {
  const { auth, google } = await setup({
    credential: EXPIRED,
    script: { [TOKEN]: [{ status: 503, rawBody: "busy" }, REFRESHED] },
  });
  assert.equal((await auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(hits(google, TOKEN).length, 2);
});

test("a refused OAuth client is a build fault: gmail_unavailable, login kept, one call, logged without secrets", async () => {
  for (const [status, error] of [
    [401, "invalid_client"],
    [400, "unauthorized_client"],
    [401, "deleted_client"],
  ]) {
    const warnings = [];
    const { auth, google, slot } = await setup({
      credential: EXPIRED,
      logger: { warn: (...args) => warnings.push(args) },
      script: { [TOKEN]: [oauthError(status, error)] },
    });

    assert.deepEqual(
      await auth.getAccessToken(BINDING),
      { ok: false, errorCode: "gmail_unavailable" },
      error
    );
    assert.equal(hits(google, TOKEN).length, 1, error);
    assert.equal(slot().needsReconnect, false, error);
    assert.match(JSON.stringify(warnings), new RegExp(error));
    assert.doesNotMatch(JSON.stringify(warnings), /refresh-1|access-1|secret-1|you@example/);
  }
});

test("Google refusing the refresh is not a network problem: a Workspace block or a reconnect, asked once, logged", async () => {
  for (const [status, error, expected, needsReconnect] of [
    [400, "admin_policy_enforced", "domain_policy", false],
    [400, "org_internal", "domain_policy", false],
    [400, "invalid_scope", "reconnect_needed", true],
    [400, "invalid_request", "reconnect_needed", true],
    [403, "access_denied", "reconnect_needed", true],
  ]) {
    const warnings = [];
    const { auth, google, slot } = await setup({
      credential: EXPIRED,
      logger: { warn: (...args) => warnings.push(args) },
      script: { [TOKEN]: [oauthError(status, error)] },
    });

    assert.deepEqual(await auth.getAccessToken(BINDING), { ok: false, errorCode: expected }, error);
    assert.equal(hits(google, TOKEN).length, 1, `${error}: not asked again`);
    assert.equal(slot().needsReconnect, needsReconnect, error);
    assert.match(JSON.stringify(warnings), new RegExp(error), `${error} is logged`);
    assert.doesNotMatch(JSON.stringify(warnings), /refresh-1|access-1|secret-1|you@example/);
  }
});

test("a refresh that stays unreachable is logged with its code", async () => {
  const warnings = [];
  const { auth } = await setup({
    credential: EXPIRED,
    logger: { warn: (...args) => warnings.push(args) },
    script: { [TOKEN]: [{ status: 503, rawBody: "busy" }] },
  });
  assert.deepEqual(await auth.getAccessToken(BINDING), { ok: false, errorCode: "network" });
  assert.match(JSON.stringify(warnings), /http_503/);
});

test("a login made before the Google client left the build reports gmail_unavailable without calling Google", async () => {
  const { auth, google, slot } = await setup({
    credential: EXPIRED,
    client: { clientId: null, clientSecret: null },
  });
  assert.deepEqual(await auth.getAccessToken(BINDING), {
    ok: false,
    errorCode: "gmail_unavailable",
  });
  assert.deepEqual(google.calls, []);
  assert.equal(slot().needsReconnect, false);
});

test("a reconnect during a refresh wins: connection_changed, and nothing is written to the new login", async () => {
  const replies = [REFRESHED, oauthError(400, "invalid_grant"), { status: 503, rawBody: "busy" }];
  for (const [index, reply] of replies.entries()) {
    const credentials = memoryCredentials(EXPIRED, { connectorId: "gmail" });
    let replaced = false;
    const { auth, google, slot } = await setup({
      credentials,
      script: {
        [TOKEN]: [
          {
            ...reply,
            // Mid-flight: the user reconnects as another Google account.
            during: () => {
              if (replaced) return;
              replaced = true;
              credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1);
            },
          },
        ],
      },
    });

    assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED, `case ${index}`);
    assert.equal(hits(google, TOKEN).length, 1, `case ${index}: no retry for the old login`);
    assert.deepEqual(slot(), OTHER_LOGIN, `case ${index}`);
    assert.equal(credentials.saves.length, 0, `case ${index}`);
  }
});

test("a disconnect during a refresh leaves the login cleared", async () => {
  const credentials = memoryCredentials(EXPIRED, { connectorId: "gmail" });
  const { auth } = await setup({
    credentials,
    script: { [TOKEN]: [{ ...REFRESHED, during: () => credentials.clear("acct-1", "gmail", 1) }] },
  });

  assert.deepEqual(await auth.getAccessToken(BINDING), CONNECTION_CHANGED);
  assert.equal(credentials.read("acct-1", "gmail"), null);
  assert.equal(credentials.saves.length, 0);
});

test("an OpenWhispr account switch during a refresh saves only into the account the action belongs to", async () => {
  const credentials = memoryCredentials(EXPIRED, { connectorId: "gmail" });
  const { auth, slot } = await setup({
    credentials,
    script: { [TOKEN]: [{ ...REFRESHED, during: () => credentials.switchAccount("acct-2") }] },
  });

  assert.equal((await auth.getAccessToken(BINDING)).token, "access-2");
  assert.equal(slot("acct-1").accessToken, "access-2");
  assert.equal(credentials.read("acct-2", "gmail"), null);
});

test("markReconnect flags only the bound login and reports reconnect_needed", async () => {
  const { auth, credentials, slot, google } = await setup();

  assert.deepEqual(auth.markReconnect(BINDING), RECONNECT_NEEDED);

  assert.equal(slot().needsReconnect, true);
  assert.equal(slot().accessToken, CONNECTED.accessToken, "the rest of the login is kept");
  assert.equal(credentials.generation("acct-1", "gmail"), 1, "a flag is not a new login");
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(google.calls, []);
});

test("markReconnect after a reconnect reports connection_changed and writes nothing", async () => {
  const { auth, credentials, slot } = await setup();
  credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1);

  assert.deepEqual(auth.markReconnect(BINDING), CONNECTION_CHANGED);
  assert.deepEqual(slot(), OTHER_LOGIN);
  assert.equal(credentials.saves.length, 0);
});

test("a reconnect flag that can't be saved for a real reason is logged without the token", async () => {
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
    script: { [TOKEN]: [oauthError(400, "invalid_grant")] },
  });

  // Google's answer stands even though the flag couldn't be written.
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(auth.markReconnect(BINDING), RECONNECT_NEEDED);
  // The refresh failure, then each flag that couldn't be saved.
  assert.equal(warnings.length, 3);
  const serialized = JSON.stringify(warnings);
  assert.match(serialized, /ENOSPC/);
  assert.doesNotMatch(serialized, /refresh-1|access-1|no space left/);
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
  assert.doesNotMatch(JSON.stringify(warnings), /access-2|refresh-1/);
});

test("revoke posts the refresh token, which ends the whole grant, and never throws", async () => {
  const online = await setup({ script: { [REVOKE]: [REVOKED_OK] } });
  await online.auth.revoke(CONNECTED);
  assert.deepEqual(
    hits(online.google, REVOKE).map((call) => call.form),
    [{ token: "refresh-1" }]
  );

  const accessOnly = await setup({ script: { [REVOKE]: [REVOKED_OK] } });
  await accessOnly.auth.revoke({ ...CONNECTED, refreshToken: null });
  assert.deepEqual(
    hits(accessOnly.google, REVOKE).map((call) => call.form),
    [{ token: "access-1" }]
  );

  const unreachable = await setup({ script: { [REVOKE]: [offline()] } });
  await assert.doesNotReject(unreachable.auth.revoke(CONNECTED));
  const refused = await setup({
    script: { [REVOKE]: [{ status: 400, body: { error: "invalid_token" } }] },
  });
  await assert.doesNotReject(refused.auth.revoke(CONNECTED));

  const empty = await setup();
  await empty.auth.revoke({});
  assert.deepEqual(empty.google.calls, []);
});

test("a Gmail grant shares the calendar's only in the same Cloud project, for a connected calendar account", async () => {
  const { sharesCalendarGrant } = await loadAuth();
  const calendar = "123456789012-calendar.apps.googleusercontent.com";
  const sameProject = "123456789012-gmail.apps.googleusercontent.com";
  const otherProject = "999999999999-gmail.apps.googleusercontent.com";
  const shares = (overrides) =>
    sharesCalendarGrant({
      gmailClientId: calendar,
      calendarClientId: calendar,
      getCalendarEmails: () => ["You@Example.test"],
      email: "you@example.test",
      ...overrides,
    });

  assert.equal(shares({}), true, "the calendar's own client, same account (any case)");
  assert.equal(shares({ gmailClientId: sameProject }), true, "another client of the same project");
  assert.equal(shares({ gmailClientId: otherProject }), false, "a separate project");
  assert.equal(shares({ email: "someone@example.test" }), false, "another Google account");
  assert.equal(shares({ getCalendarEmails: () => [] }), false, "no calendar connected");
  assert.equal(
    shares({
      gmailClientId: otherProject,
      getCalendarEmails: () => {
        throw new Error("Database not initialized");
      },
    }),
    false,
    "a separate project never reads the calendar database"
  );
  assert.equal(shares({ email: undefined }), true, "an unknown address counts as any account");
  assert.equal(shares({ calendarClientId: undefined }), false, "no calendar client in the build");
  assert.equal(
    shares({ gmailClientId: "dev-client", calendarClientId: "dev-client" }),
    true,
    "ids without a project number compare whole"
  );
});

test("Disconnect keeps a shared grant alive: no revoke, unless the device is being erased", async () => {
  const asked = [];
  const sharesGrant = (email, clientId) => {
    asked.push([email, clientId]);
    return true;
  };
  const shared = await setup({ script: { [REVOKE]: [REVOKED_OK] }, sharesGrant });
  assert.deepEqual(await shared.auth.revoke(CONNECTED), { kept: true }, "Settings says so");
  assert.deepEqual(hits(shared.google, REVOKE), [], "the calendar's grant stays");
  // A login saved before its client was recorded counts as the current one.
  assert.deepEqual(asked, [["you@example.test", CLIENT.clientId]], "checked for the login");

  const erasing = await setup({ script: { [REVOKE]: [REVOKED_OK] }, sharesGrant });
  assert.equal(await erasing.auth.revoke(CONNECTED, { erasingDevice: true }), null);
  assert.deepEqual(
    hits(erasing.google, REVOKE).map((call) => call.form),
    [{ token: "refresh-1" }]
  );

  const unreadable = await setup({
    script: { [REVOKE]: [REVOKED_OK] },
    sharesGrant: () => {
      throw new Error("Database not initialized");
    },
  });
  await assert.doesNotReject(unreadable.auth.revoke(CONNECTED));
  assert.deepEqual(hits(unreadable.google, REVOKE), [], "a check that can't run keeps the grant");
});

test("the shared-grant check asks about the client the login was issued to", async () => {
  const asked = [];
  const { auth, google } = await setup({
    script: { [REVOKE]: [REVOKED_OK] },
    sharesGrant: (email, clientId) => {
      asked.push(clientId);
      return false;
    },
  });
  // Issued under the calendar's client; this build now has its own Gmail pair.
  await auth.revoke({ ...CONNECTED, clientId: "123456789012-calendar.apps.googleusercontent.com" });
  assert.deepEqual(asked, ["123456789012-calendar.apps.googleusercontent.com"]);
  assert.equal(hits(google, REVOKE).length, 1);
});

test("a login issued to another OAuth client needs a reconnect, without calling Google", async () => {
  const { auth, google, slot } = await setup({
    credential: { ...EXPIRED, clientId: "999999999999-old.apps.googleusercontent.com" },
  });
  assert.deepEqual(await auth.getAccessToken(BINDING), RECONNECT_NEEDED);
  assert.deepEqual(google.calls, []);
  assert.equal(slot().needsReconnect, true);

  // The same client refreshes as usual.
  const same = await setup({
    credential: { ...EXPIRED, clientId: CLIENT.clientId },
    script: { [TOKEN]: [REFRESHED] },
  });
  assert.equal((await same.auth.getAccessToken(BINDING)).token, "access-2");
});

test("two OpenWhispr accounts' logins never share a refresh, even at the same generation", async () => {
  const credentials = memoryCredentials(EXPIRED, { connectorId: "gmail" });
  credentials.replace(
    "acct-2",
    "gmail",
    { ...EXPIRED, sub: "sub-2", refreshToken: "refresh-2" },
    0
  );
  const { auth, google } = await setup({
    credentials,
    script: {
      [TOKEN]: [
        REFRESHED,
        { body: { access_token: "access-3", expires_in: 3599, scope: GRANTED } },
      ],
    },
  });

  const [first, second] = await Promise.all([
    auth.getAccessToken(BINDING),
    auth.getAccessToken({ ownerAccountId: "acct-2", accountId: "sub-2", generation: 1 }),
  ]);
  assert.deepEqual(
    hits(google, TOKEN).map((call) => call.form.refresh_token),
    ["refresh-1", "refresh-2"]
  );
  assert.equal(first.token, "access-2");
  assert.equal(second.token, "access-3", "never the other account's token");
});

test("a refused grant shared with a connected calendar is not revoked, and still fails", async () => {
  const asked = [];
  const { auth, google, credentials } = await setup({
    credential: null,
    script: {
      [TOKEN]: [exchangeReply({ scope: "openid https://www.googleapis.com/auth/userinfo.email" })],
      [REVOKE]: [REVOKED_OK],
    },
    sharesGrant: (email) => {
      asked.push(email);
      return true;
    },
  });

  await assert.rejects(
    auth.authorize(),
    (error) => error.redirectCode === "permission_not_granted"
  );

  assert.deepEqual(hits(google, REVOKE), []);
  assert.deepEqual(asked, ["you@example.test"], "checked for the refused grant's address");
  assert.equal(credentials.saves.length, 0);
});

// Another OpenWhispr account on this device, signed in to Gmail as `login`.
function withSecondAccount(login) {
  const credentials = memoryCredentials(CONNECTED, { connectorId: "gmail" });
  credentials.replace("acct-2", "gmail", login, 0);
  return credentials;
}

const SAME_USER_ELSEWHERE = {
  ...CONNECTED,
  accessToken: "access-acct-2",
  refreshToken: "refresh-acct-2",
};

test("a grant another OpenWhispr account's Gmail login holds is kept, unless the device is erased", async () => {
  // Google's revoke would end acct-2's login to the same Google user too.
  const shared = await setup({
    credentials: withSecondAccount(SAME_USER_ELSEWHERE),
    script: { [REVOKE]: [REVOKED_OK] },
  });
  assert.equal(await shared.auth.revoke(CONNECTED), null, "not the calendar's note");
  assert.deepEqual(hits(shared.google, REVOKE), []);

  const erasing = await setup({
    credentials: withSecondAccount(SAME_USER_ELSEWHERE),
    script: { [REVOKE]: [REVOKED_OK] },
  });
  await erasing.auth.revoke(CONNECTED, { erasingDevice: true });
  assert.equal(hits(erasing.google, REVOKE).length, 1);

  // Another Google user, or another Cloud project, is a separate grant.
  for (const other of [
    { ...SAME_USER_ELSEWHERE, sub: "sub-2", email: "Other@Example.test" },
    { ...SAME_USER_ELSEWHERE, clientId: "999999999999-other.apps.googleusercontent.com" },
  ]) {
    const separate = await setup({
      credentials: withSecondAccount(other),
      script: { [REVOKE]: [REVOKED_OK] },
    });
    await separate.auth.revoke(CONNECTED);
    assert.deepEqual(
      hits(separate.google, REVOKE).map((call) => call.form),
      [{ token: "refresh-1" }],
      JSON.stringify(other)
    );
  }
  // The same address in another case is the same Google user.
  const upper = await setup({
    credentials: withSecondAccount({ ...SAME_USER_ELSEWHERE, email: "YOU@example.test" }),
    script: { [REVOKE]: [REVOKED_OK] },
  });
  await upper.auth.revoke(CONNECTED);
  assert.deepEqual(hits(upper.google, REVOKE), []);
});

test("a refused sign-in doesn't revoke the grant this account's current login still uses", async () => {
  const { auth, google, slot } = await setup({
    credential: { ...CONNECTED, accessToken: "access-old", refreshToken: "refresh-old" },
    script: {
      [TOKEN]: [exchangeReply({ scope: "openid https://www.googleapis.com/auth/userinfo.email" })],
      [REVOKE]: [REVOKED_OK],
    },
  });

  await assert.rejects(
    auth.authorize(),
    (error) => error.redirectCode === "permission_not_granted"
  );
  assert.deepEqual(hits(google, REVOKE), [], "the old login keeps working");
  assert.equal(slot().refreshToken, "refresh-old");
});

test("a login store that can't be read keeps the grant", async () => {
  const credentials = memoryCredentials(CONNECTED, { connectorId: "gmail" });
  credentials.readAllAccounts = () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  const { auth, google } = await setup({ credentials, script: { [REVOKE]: [REVOKED_OK] } });
  await assert.doesNotReject(auth.revoke(CONNECTED));
  assert.deepEqual(hits(google, REVOKE), []);
});

test("the status shows the Google address and the reconnect flag", async () => {
  const { auth } = await setup();
  assert.deepEqual(auth.statusOf(CONNECTED), {
    connected: true,
    accountLabel: "you@example.test",
    workspaceLabel: null,
    needsReconnect: false,
  });
  assert.equal(auth.statusOf({ ...CONNECTED, needsReconnect: true }).needsReconnect, true);
});
