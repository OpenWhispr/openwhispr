const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  CONNECTED,
  BINDING,
  fakeGoogleFetch,
  offline,
  reset,
  decodeMessage,
  header,
  memoryCredentials,
} = require("./gmailFixtures");

const SEND = "/gmail/v1/users/me/messages/send";
const TOKEN = "/token";
const BOUND = { binding: BINDING };
const JOSH = { to: ["josh@acme.test"], cc: [], subject: "Q3 numbers", body: "Revenue is up." };
const SENT = { body: { id: "msg-1", threadId: "thread-1", labelIds: ["SENT"] } };
const SENT_URL = "https://mail.google.com/mail/?authuser=you%40example.test#sent/msg-1";
const SENT_FOLDER = "https://mail.google.com/mail/?authuser=you%40example.test#sent";
const UNAUTHORIZED = {
  status: 401,
  body: {
    error: {
      code: 401,
      message: "Request had invalid authentication credentials.",
      status: "UNAUTHENTICATED",
    },
  },
};
const REFRESHED = {
  body: {
    access_token: "access-2",
    expires_in: 3599,
    scope: CONNECTED.scope,
    token_type: "Bearer",
  },
};
const LOGIN_GONE = {
  status: 400,
  body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
};
const OTHER_LOGIN = {
  ...CONNECTED,
  sub: "sub-2",
  email: "other@example.test",
  accessToken: "access-other",
  refreshToken: "refresh-other",
};
const NOT_CONNECTED = {
  connected: false,
  configured: true,
  accountLabel: null,
  workspaceLabel: null,
  needsReconnect: false,
};
const forbidden = (reason) => ({
  status: 403,
  body: {
    error: {
      code: 403,
      message: "Forbidden",
      errors: [{ domain: "global", reason, message: "Forbidden" }],
    },
  },
});
const people = (count) => Array.from({ length: count }, (_, index) => `person${index}@acme.test`);

async function setupGmail(script = {}, { credential = CONNECTED, configured = true } = {}) {
  const [connectorModule, { createGmailApi }, { createGmailAuth }] = await Promise.all([
    import("../../../src/helpers/connectors/gmailConnector.js"),
    import("../../../src/helpers/connectors/gmailApi.js"),
    import("../../../src/helpers/connectors/gmailAuth.js"),
  ]);
  const google = fakeGoogleFetch(script);
  const api = createGmailApi({ fetchImpl: google.fetchImpl, sleep: async () => {} });
  const credentials = memoryCredentials(credential, { connectorId: "gmail" });
  const auth = createGmailAuth({
    api,
    credentials,
    getClientCredentials: () =>
      configured
        ? { clientId: "client-1", clientSecret: "secret-1" }
        : { clientId: null, clientSecret: null },
    OAuthFlowError: Error,
    runOAuthLoopbackFlow: async () => {
      throw new Error("not used in these tests");
    },
    now: () => NOW,
  });
  const connector = connectorModule.createGmailConnector({ api, auth, credentials });
  return { connector, google, credentials, ...connectorModule };
}

const hits = (google, path) => google.calls.filter((call) => call.path === path);
const slot = (credentials) => credentials.read("acct-1", "gmail").credential;
const sentMessage = (google, index = 0) => decodeMessage(hits(google, SEND)[index].json.raw);

async function prepareJosh(connector, args = {}) {
  const prepared = await connector.prepare("send", { ...JOSH, ...args }, BOUND);
  assert.equal(prepared.status, "ready");
  return prepared;
}

test("Gmail declares one approval action whose card edits To, Cc, Subject and Body", async () => {
  const { connector } = await setupGmail();
  assert.equal(connector.id, "gmail");
  assert.deepEqual(connector.actions, {
    send: {
      kind: "approval",
      editable: { to: "addresses", cc: "addresses", subject: "line", body: "text" },
    },
  });
});

test("prepare cleans the recipients and shows what will be sent, without calling Google", async () => {
  const { connector, google } = await setupGmail();

  const prepared = await connector.prepare(
    "send",
    {
      to: ["Josh Lee <JOSH@acme.test>", "josh@acme.test", " ana@acme.test "],
      cc: ["ANA@acme.test", "lee@acme.test"],
      subject: "Q3\r\nnumbers",
      body: "Here they are.",
    },
    BOUND
  );

  const fields = {
    to: ["JOSH@acme.test", "ana@acme.test"],
    cc: ["lee@acme.test"],
    subject: "Q3 numbers",
    body: "Here they are.",
  };
  assert.deepEqual(prepared, {
    status: "ready",
    payload: fields,
    preview: {
      verbKey: "email",
      destinationLabel: "JOSH@acme.test +2",
      accountLabel: "you@example.test",
      body: "Here they are.",
      fields,
    },
  });
  assert.deepEqual(google.calls, []);
});

test("an invalid address asks the user, naming it, and prepares nothing", async () => {
  const { connector, google } = await setupGmail();

  const prepared = await connector.prepare(
    "send",
    { ...JOSH, cc: ["ana@acme.test", "ana at acme"] },
    BOUND
  );

  assert.equal(prepared.status, "needs_clarification");
  assert.match(prepared.message, /ana at acme/);
  assert.deepEqual(prepared.candidates, []);
  assert.deepEqual(google.calls, []);
});

test("an email with no one in To asks who it is for", async () => {
  const { connector } = await setupGmail();
  const prepared = await connector.prepare(
    "send",
    { ...JOSH, to: [], cc: ["ana@acme.test"] },
    BOUND
  );
  assert.equal(prepared.status, "needs_clarification");
  assert.deepEqual(prepared.candidates, []);
});

test("prepare enforces Gmail's caps before anything is sent", async () => {
  const { connector, google } = await setupGmail();
  const prepare = (args) => connector.prepare("send", { ...JOSH, ...args }, BOUND);

  assert.equal((await prepare({ cc: people(49) })).status, "ready", "50 recipients");
  assert.deepEqual(
    [(await prepare({ cc: people(50) })).status, (await prepare({ cc: people(50) })).errorCode],
    ["failed", "too_many_recipients"]
  );
  assert.equal((await prepare({ subject: "x".repeat(250) })).status, "ready");
  assert.equal(
    (await prepare({ subject: "😀".repeat(250) })).status,
    "ready",
    "characters, not UTF-16 units"
  );
  assert.equal((await prepare({ subject: "x".repeat(251) })).errorCode, "too_long");
  assert.equal(
    (await prepare({ body: "x".repeat(800_000) })).errorCode,
    "too_long",
    "the finished message is over 1 MB"
  );
  assert.deepEqual(google.calls, []);
});

test("an oversized body never refreshes a stale token, at prepare or at commit", async () => {
  // A stale (expired) token whose refresh is scripted to succeed: if the
  // size cap were checked only after auth.getAccessToken, an oversized
  // body would still cost a refresh call before being refused.
  const expiredCredential = { ...CONNECTED, expiresAt: NOW - 1 };
  const bigBody = "x".repeat(800_000);

  const prepareCase = await setupGmail({ [TOKEN]: [REFRESHED] }, { credential: expiredCredential });
  const prepared = await prepareCase.connector.prepare("send", { ...JOSH, body: bigBody }, BOUND);
  assert.equal(prepared.status, "failed");
  assert.equal(prepared.errorCode, "too_long");
  assert.deepEqual(prepareCase.google.calls, [], "prepare: no token refresh and no send");

  const fresh = await setupGmail();
  const { payload } = await prepareJosh(fresh.connector);
  const commitCase = await setupGmail(
    { [TOKEN]: [REFRESHED], [SEND]: [SENT] },
    { credential: expiredCredential }
  );
  const committed = await commitCase.connector.commit("send", payload, { body: bigBody }, BOUND);
  assert.equal(committed.state, "failed");
  assert.equal(committed.errorCode, "too_long");
  assert.deepEqual(commitCase.google.calls, [], "commit: no token refresh and no send");
});

test("a body past the card's limit is refused even when its raw message would fit", async () => {
  const { MAX_EMAIL_BODY_BYTES } = await import("../../../src/helpers/connectors/emailCompose.js");
  const justOver = "x".repeat(MAX_EMAIL_BODY_BYTES + 1);
  const atLimit = "x".repeat(MAX_EMAIL_BODY_BYTES);

  const { connector, google } = await setupGmail({ [SEND]: [SENT] });
  const refused = await connector.prepare("send", { ...JOSH, body: justOver }, BOUND);
  assert.equal(refused.errorCode, "too_long");
  const { payload } = await prepareJosh(connector);
  const committed = await connector.commit("send", payload, { body: justOver }, BOUND);
  assert.equal(committed.errorCode, "too_long");
  assert.equal(hits(google, SEND).length, 0);

  // The card and main agree: at the limit, it sends.
  assert.equal((await connector.commit("send", payload, { body: atLimit }, BOUND)).state, "sent");
});

test("a login that needs reconnecting, or that Google says is gone, fails prepare with reconnect_needed", async () => {
  const flagged = await setupGmail({}, { credential: { ...CONNECTED, needsReconnect: true } });
  const refused = await flagged.connector.prepare("send", JOSH, BOUND);
  assert.equal(refused.status, "failed");
  assert.equal(refused.errorCode, "reconnect_needed");
  assert.deepEqual(flagged.google.calls, []);

  const gone = await setupGmail(
    { [TOKEN]: [LOGIN_GONE] },
    { credential: { ...CONNECTED, expiresAt: NOW - 1 } }
  );
  const expired = await gone.connector.prepare("send", JOSH, BOUND);
  assert.equal(expired.errorCode, "reconnect_needed");
  assert.equal(slot(gone.credentials).needsReconnect, true);
  assert.equal(hits(gone.google, SEND).length, 0);
});

test("an unknown action is refused by prepare and commit", async () => {
  const { connector, google } = await setupGmail();
  const refusal = { errorCode: "unknown_action", message: "Unknown Gmail action." };
  assert.deepEqual(await connector.prepare("draft", JOSH, BOUND), { status: "failed", ...refusal });
  assert.deepEqual(await connector.commit("draft", JOSH, {}, BOUND), {
    state: "failed",
    ...refusal,
  });
  assert.deepEqual(google.calls, []);
});

test("Send posts the message once, as the connected address, and links to it in Gmail", async () => {
  const { connector, google } = await setupGmail({ [SEND]: [SENT] });
  const prepared = await prepareJosh(connector, { cc: ["ana@acme.test"] });

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.deepEqual(result, {
    state: "sent",
    url: SENT_URL,
    destinationLabel: "josh@acme.test +1",
  });
  assert.deepEqual(
    google.calls.map((call) => call.path),
    [SEND],
    "the token was fresh"
  );
  assert.equal(hits(google, SEND)[0].authorization, "Bearer access-1");
  const message = sentMessage(google);
  assert.equal(header(message, "From"), "From: you@example.test");
  assert.equal(header(message, "To"), "To: josh@acme.test");
  assert.equal(header(message, "Cc"), "Cc: ana@acme.test");
  assert.equal(header(message, "Subject"), "Subject: Q3 numbers");
  assert.equal(message.body, "Revenue is up.");
});

test("Send rebuilds the message from the card's fields only", async () => {
  const { connector, google } = await setupGmail({ [SEND]: [SENT] });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit(
    "send",
    { ...prepared.payload, bcc: ["hidden@evil.test"], from: "boss@acme.test" },
    {
      to: ["lee@acme.test", "LEE@acme.test"],
      cc: ["ana@acme.test"],
      subject: "Q3 numbers (final)",
      body: "Revenue is up 12%.\nThanks.",
      bcc: ["spy@evil.test"],
      from: "boss@acme.test",
      headers: "X-Evil: 1",
    },
    BOUND
  );

  assert.equal(result.state, "sent");
  const message = sentMessage(google);
  assert.equal(header(message, "From"), "From: you@example.test");
  assert.equal(header(message, "To"), "To: lee@acme.test");
  assert.equal(header(message, "Cc"), "Cc: ana@acme.test");
  assert.equal(header(message, "Subject"), "Subject: Q3 numbers (final)");
  assert.equal(header(message, "Bcc"), null);
  assert.equal(header(message, "X-Evil"), null);
  assert.equal(message.body, "Revenue is up 12%.\r\nThanks.");
});

test("edits that break a rule at Send are refused without calling Google", async () => {
  const { connector, google } = await setupGmail({ [SEND]: [SENT] });
  const prepared = await prepareJosh(connector);

  for (const [edits, errorCode] of [
    [{ to: ["not-an-address"] }, "invalid_recipients"],
    [{ to: ["josh@acme.test\r\nBcc: spy@evil.test"] }, "invalid_recipients"],
    [{ to: [], cc: ["ana@acme.test"] }, "invalid_recipients"],
    [{ cc: people(50) }, "too_many_recipients"],
    [{ subject: "Q3\r\nBcc: spy@evil.test" }, "invalid_message"],
    [{ subject: "x".repeat(251) }, "too_long"],
    [{ body: "x".repeat(800_000) }, "too_long"],
  ]) {
    const label = JSON.stringify(edits).slice(0, 60);
    const result = await connector.commit("send", prepared.payload, edits, BOUND);
    assert.equal(result.state, "failed", label);
    assert.equal(result.errorCode, errorCode, label);
    assert.equal(typeof result.message, "string", label);
  }
  assert.deepEqual(google.calls, []);
});

test("a 401 refreshes the same login once and sends the same message once more", async () => {
  const { connector, google, credentials } = await setupGmail({
    [SEND]: [UNAUTHORIZED, SENT],
    [TOKEN]: [REFRESHED],
  });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.deepEqual(result, {
    state: "sent",
    url: SENT_URL,
    destinationLabel: "josh@acme.test",
  });
  const sends = hits(google, SEND);
  assert.deepEqual(
    sends.map((call) => call.authorization),
    ["Bearer access-1", "Bearer access-2"]
  );
  assert.equal(sends[0].json.raw, sends[1].json.raw);
  assert.equal(hits(google, TOKEN)[0].form.refresh_token, "refresh-1");
  assert.equal(slot(credentials).accessToken, "access-2");
  assert.equal(credentials.generation("acct-1", "gmail"), 1, "pending approvals stay valid");
});

test("a 401 right after a successful refresh needs a reconnect, with two attempts in all", async () => {
  const { connector, google, credentials } = await setupGmail({
    [SEND]: [UNAUTHORIZED, UNAUTHORIZED],
    [TOKEN]: [REFRESHED],
  });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(slot(credentials).needsReconnect, true);
  assert.equal(hits(google, SEND).length, 2);
});

test("a 401 whose refresh Google refuses needs a reconnect, after one attempt", async () => {
  const { connector, google, credentials } = await setupGmail({
    [SEND]: [UNAUTHORIZED],
    [TOKEN]: [LOGIN_GONE],
  });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(slot(credentials).needsReconnect, true);
  assert.equal(hits(google, SEND).length, 1);
});

test("a 401 whose refresh can't reach Google fails with network and keeps the login", async () => {
  const { connector, google, credentials } = await setupGmail({
    [SEND]: [UNAUTHORIZED],
    [TOKEN]: [offline()],
  });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "network");
  assert.equal(slot(credentials).needsReconnect, false);
  assert.equal(hits(google, SEND).length, 1);
});

test("a reconnect as another Google account, or a disconnect, before Send sends nothing", async () => {
  const reconnected = await setupGmail({ [SEND]: [SENT] });
  const first = await prepareJosh(reconnected.connector);
  reconnected.credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1);
  assert.deepEqual(await reconnected.connector.commit("send", first.payload, {}, BOUND), {
    state: "failed",
    errorCode: "connection_changed",
    message: "The Gmail connection changed before sending, so nothing was sent.",
  });
  assert.equal(hits(reconnected.google, SEND).length, 0);

  const disconnected = await setupGmail({ [SEND]: [SENT] });
  const second = await prepareJosh(disconnected.connector);
  disconnected.credentials.clear("acct-1", "gmail", 1);
  const result = await disconnected.connector.commit("send", second.payload, {}, BOUND);
  assert.equal(result.errorCode, "connection_changed");
  assert.equal(hits(disconnected.google, SEND).length, 0);
});

test("a reconnect while refreshing after a 401 never sends as the new login", async () => {
  let credentials;
  const setup = await setupGmail({
    [SEND]: [UNAUTHORIZED, SENT],
    [TOKEN]: [
      { ...REFRESHED, during: () => credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1) },
    ],
  });
  credentials = setup.credentials;
  const prepared = await prepareJosh(setup.connector);

  const result = await setup.connector.commit("send", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "connection_changed");
  assert.deepEqual(
    hits(setup.google, SEND).map((call) => call.authorization),
    ["Bearer access-1"]
  );
  assert.deepEqual(slot(credentials), OTHER_LOGIN, "nothing was written to the new login");
});

test("Gmail's 403 reasons fail with a specific reason and are never retried", async () => {
  for (const [reason, errorCode, pattern] of [
    ["dailyLimitExceeded", "daily_limit", /daily sending limit/],
    ["userRateLimitExceeded", "rate_limited", /busy/],
    ["rateLimitExceeded", "rate_limited", /busy/],
    ["domainPolicy", "domain_policy", /admin/],
    ["somethingNew", "refused", /refused/],
  ]) {
    const { connector, google, credentials } = await setupGmail({ [SEND]: [forbidden(reason)] });
    const prepared = await prepareJosh(connector);

    const result = await connector.commit("send", prepared.payload, {}, BOUND);

    assert.equal(result.state, "failed", reason);
    assert.equal(result.errorCode, errorCode, reason);
    assert.match(result.message, pattern, reason);
    assert.equal(hits(google, SEND).length, 1, reason);
    assert.equal(slot(credentials).needsReconnect, false, reason);
  }
});

test("a grant that no longer covers gmail.send flips to Reconnect", async () => {
  const { connector, google, credentials } = await setupGmail({
    [SEND]: [forbidden("insufficientPermissions")],
  });
  const prepared = await prepareJosh(connector);

  const result = await connector.commit("send", prepared.payload, {}, BOUND);

  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(slot(credentials).needsReconnect, true);
  assert.equal(hits(google, SEND).length, 1);
  assert.equal(hits(google, TOKEN).length, 0);
});

test("a malformed message or no connection before the write fails: nothing went out", async () => {
  const malformed = await setupGmail({
    [SEND]: [{ status: 400, body: { error: { code: 400, message: "Invalid To header" } } }],
  });
  const first = await prepareJosh(malformed.connector);
  const refused = await malformed.connector.commit("send", first.payload, {}, BOUND);
  assert.equal(refused.state, "failed");
  assert.equal(refused.errorCode, "invalid_message");

  const unreachable = await setupGmail({ [SEND]: [offline()] });
  const second = await prepareJosh(unreachable.connector);
  const result = await unreachable.connector.commit("send", second.payload, {}, BOUND);
  assert.equal(result.state, "failed");
  assert.equal(hits(unreachable.google, SEND).length, 1);
});

test("a 5xx, a reset after the write or a 200 without an id is unknown, with a link to Sent, and never retried", async () => {
  for (const [index, reply] of [
    { status: 503, rawBody: "<html>busy</html>" },
    reset(),
    { body: { threadId: "thread-1" } },
  ].entries()) {
    const { connector, google } = await setupGmail({ [SEND]: [reply] });
    const prepared = await prepareJosh(connector);

    const result = await connector.commit("send", prepared.payload, {}, BOUND);

    assert.equal(result.state, "unknown", `case ${index}`);
    assert.equal(result.checkUrl, SENT_FOLDER, `case ${index}`);
    assert.equal(hits(google, SEND).length, 1, `case ${index}`);
  }
});

test("recipient helpers de-duplicate, keep To over Cc, and build Gmail links", async () => {
  const { normalizeRecipients, sentMessageUrl, sentFolderUrl } =
    await import("../../../src/helpers/connectors/gmailConnector.js");
  const { recipientsLabel } = await import("../../../src/helpers/connectors/emailCompose.js");

  assert.deepEqual(
    normalizeRecipients({
      to: ["A@x.test", "a@x.test", "Bee <b@x.test>", 7, ""],
      cc: ["b@X.test", "c@x.test", "bad address", "bad address"],
    }),
    { to: ["A@x.test", "b@x.test"], cc: ["c@x.test"], invalid: ["bad address"] }
  );
  assert.deepEqual(normalizeRecipients({}), { to: [], cc: [], invalid: [] });
  assert.equal(recipientsLabel(["a@x.test"], []), "a@x.test");
  assert.equal(recipientsLabel(["a@x.test", "b@x.test"], ["c@x.test"]), "a@x.test +2");
  // Each address counts once, as main sends it.
  assert.equal(recipientsLabel(["a@x.test", "A@x.test"], ["a@X.test"]), "a@x.test");
  assert.equal(recipientsLabel(["a@x.test", "b@x.test"], ["B@x.test"]), "a@x.test +1");
  // A single-script look-alike of apple.com: isValidEmailAddress lets it
  // through (one script, not a mix), so the card must show its ASCII form
  // rather than the raw address alone.
  assert.equal(
    recipientsLabel(["a@аррӏе.com"], []),
    "a@аррӏе.com (xn--80ak6aa92e.com)",
    "a non-ASCII domain shows its punycode form"
  );
  assert.equal(
    recipientsLabel(["a@аррӏе.com", "b@x.test"], []),
    "a@аррӏе.com (xn--80ak6aa92e.com) +1"
  );
  assert.equal(
    sentMessageUrl("you+tag@example.test", "msg-1"),
    "https://mail.google.com/mail/?authuser=you%2Btag%40example.test#sent/msg-1"
  );
  assert.equal(
    sentFolderUrl("you@example.test"),
    "https://mail.google.com/mail/?authuser=you%40example.test#sent"
  );
});

test("the binding and status follow the active account's Google login", async () => {
  const { connector, credentials } = await setupGmail();
  assert.deepEqual(await connector.getBinding(), BINDING);
  assert.deepEqual(await connector.getStatus(), {
    connected: true,
    configured: true,
    accountLabel: "you@example.test",
    workspaceLabel: null,
    needsReconnect: false,
  });

  credentials.replace("acct-1", "gmail", OTHER_LOGIN, 1);
  assert.deepEqual(await connector.getBinding(), {
    ownerAccountId: "acct-1",
    accountId: "sub-2",
    generation: 2,
  });

  credentials.switchAccount("acct-2");
  assert.equal(await connector.getBinding(), null);
  assert.deepEqual(await connector.getStatus(), NOT_CONNECTED);
});

test("without a Google client the row is hidden, unless a login is left to disconnect", async () => {
  const none = await setupGmail({}, { credential: null, configured: false });
  assert.deepEqual(await none.connector.getStatus(), { ...NOT_CONNECTED, configured: false });

  const leftover = await setupGmail({}, { configured: false });
  assert.deepEqual(await leftover.connector.getStatus(), {
    connected: true,
    configured: true,
    accountLabel: "you@example.test",
    workspaceLabel: null,
    needsReconnect: false,
  });
});

test("authorize and revoke go to Gmail auth, with the connect's cancel signal", async () => {
  const { createGmailConnector } =
    await import("../../../src/helpers/connectors/gmailConnector.js");
  const seen = [];
  const connector = createGmailConnector({
    api: null,
    credentials: null,
    auth: {
      authorize: async (options) => seen.push(["authorize", options]),
      revoke: async (credential) => seen.push(["revoke", credential]),
    },
  });
  const controller = new AbortController();

  await connector.authorize({ signal: controller.signal });
  await connector.revoke(CONNECTED);

  assert.equal(seen[0][1].signal, controller.signal);
  assert.deepEqual(seen[1], ["revoke", CONNECTED]);
});
