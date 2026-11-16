const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  CONNECTED,
  GRANTED,
  FakeFlowError,
  fakeGoogleFetch,
  idToken,
  decodeMessage,
  header,
  memoryCredentials,
  GOOGLE_REVOKE_OK,
} = require("./gmailFixtures");

const SEND = "/gmail/v1/users/me/messages/send";
const TOKEN = "/token";
const REVOKE = "/revoke";
const ALLOWED = { policyState: "allowed", accountId: "acct-1" };
const SENT = { body: { id: "msg-1", threadId: "thread-1", labelIds: ["SENT"] } };
const SENT_URL = "https://mail.google.com/mail/?authuser=you%40example.test#sent/msg-1";
const EMAIL = {
  to: ["josh@acme.test"],
  cc: ["ana@acme.test"],
  subject: "Q3 numbers",
  body: "Revenue is up.",
};
const silentLogger = { info() {}, warn() {}, error() {} };

function exchangeFor({
  sub = "sub-1",
  email = "you@example.test",
  scope = GRANTED,
  emailVerified = true,
} = {}) {
  return {
    body: {
      access_token: `access-${sub}`,
      refresh_token: `refresh-${sub}`,
      expires_in: 3599,
      scope,
      token_type: "Bearer",
      id_token: idToken({ sub, email, email_verified: emailVerified }),
    },
  };
}

// The receipts table, in memory: a guarded update only moves a row still in
// fromState, like updateConnectorActionState.
function fakeLog() {
  const rows = new Map();
  return {
    rows,
    insert: (row) => rows.set(row.id, { ...row }),
    update: (id, patch, fromState) => {
      const row = rows.get(id);
      if (!row || (fromState !== undefined && row.state !== fromState)) return 0;
      rows.set(id, { ...row, ...patch });
      return 1;
    },
    listRecent: () => [],
    reconcileInterrupted: () => ({ unknown: 0, cancelled: 0 }),
  };
}

const signIn = (options) => options.handleCallback("code-1", "http://127.0.0.1:5000", "verifier-1");

async function setup({
  script = {},
  credential = null,
  configured = true,
  flow = signIn,
  sharesGrant,
} = {}) {
  const [
    { createConnectorManager },
    { createPendingActions },
    { createGmailApi },
    { createGmailAuth },
    { createGmailConnector },
  ] = await Promise.all([
    import("../../../src/helpers/connectors/connectorManager.js"),
    import("../../../src/helpers/connectors/pendingActions.js"),
    import("../../../src/helpers/connectors/gmailApi.js"),
    import("../../../src/helpers/connectors/gmailAuth.js"),
    import("../../../src/helpers/connectors/gmailConnector.js"),
  ]);
  const google = fakeGoogleFetch({ [REVOKE]: [GOOGLE_REVOKE_OK], ...script });
  const credentials = memoryCredentials(credential, { connectorId: "gmail" });
  const api = createGmailApi({ fetchImpl: google.fetchImpl, sleep: async () => {} });
  const auth = createGmailAuth({
    api,
    credentials,
    getClientCredentials: () =>
      configured
        ? { clientId: "client-1", clientSecret: "secret-1" }
        : { clientId: null, clientSecret: null },
    // The round trip through the browser can take minutes; a test flow may
    // change the logins while it is "out".
    runOAuthLoopbackFlow: (options) => flow(options, credentials),
    OAuthFlowError: FakeFlowError,
    sharesGrant,
    now: () => NOW,
  });
  const log = fakeLog();
  const manager = createConnectorManager({
    connectors: [createGmailConnector({ api, auth, credentials })],
    pendingActions: createPendingActions(),
    actionLog: log,
    logger: silentLogger,
    getAccountId: () => credentials.activeAccountId(),
    credentials,
  });
  return { manager, google, credentials, log };
}

const hits = (google, path) => google.calls.filter((call) => call.path === path);
const revoked = (google) => hits(google, REVOKE).map((call) => call.form);

test("Connect saves the Google login under the account that started it", async () => {
  const { manager, credentials } = await setup({ script: { [TOKEN]: [exchangeFor()] } });

  assert.deepEqual(await manager.connect("gmail", "allowed"), {
    status: "connected",
    accountLabel: "you@example.test",
    workspaceLabel: null,
  });

  const saved = credentials.read("acct-1", "gmail");
  assert.equal(saved.credential.sub, "sub-1");
  assert.equal(saved.generation, 1);
  const [status] = await manager.status();
  assert.equal(status.id, "gmail");
  assert.equal(status.connected, true);
  assert.equal(status.configured, true);
  assert.equal(status.accountLabel, "you@example.test");
  assert.equal(status.needsReconnect, false);
});

test("connecting another Google account revokes the old one's grant; reconnecting the same keeps it", async () => {
  const other = await setup({
    credential: CONNECTED,
    script: { [TOKEN]: [exchangeFor({ sub: "sub-2", email: "other@example.test" })] },
  });
  assert.equal((await other.manager.connect("gmail", "allowed")).status, "connected");
  assert.deepEqual(revoked(other.google), [{ token: "refresh-1" }]);

  // Revoking the same account's old token would end the new login's grant.
  const same = await setup({ credential: CONNECTED, script: { [TOKEN]: [exchangeFor()] } });
  assert.equal((await same.manager.connect("gmail", "allowed")).status, "connected");
  assert.deepEqual(revoked(same.google), []);
});

test("an unticked Gmail permission or an unverified address is revoked, saved nowhere, and reported", async () => {
  for (const [reply, errorCode] of [
    [
      exchangeFor({ scope: "openid https://www.googleapis.com/auth/userinfo.email" }),
      "permission_not_granted",
    ],
    [exchangeFor({ emailVerified: false }), "email_not_verified"],
  ]) {
    const { manager, google, credentials } = await setup({ script: { [TOKEN]: [reply] } });

    assert.deepEqual(await manager.connect("gmail", "allowed"), { status: "failed", errorCode });
    assert.deepEqual(revoked(google), [{ token: "refresh-sub-1" }], errorCode);
    assert.equal(credentials.read("acct-1", "gmail"), null, errorCode);
  }
});

test("an OpenWhispr account switch during the Google round trip saves the login nowhere and revokes it", async () => {
  const { manager, google, credentials } = await setup({
    script: { [TOKEN]: [exchangeFor()] },
    flow: async (options, store) => {
      store.switchAccount("acct-2");
      return signIn(options);
    },
  });

  assert.deepEqual(await manager.connect("gmail", "allowed"), {
    status: "failed",
    errorCode: "connection_changed",
  });
  assert.deepEqual(revoked(google), [{ token: "refresh-sub-1" }]);
  assert.equal(credentials.read("acct-1", "gmail"), null);
  assert.equal(credentials.read("acct-2", "gmail"), null);
});

test("a login saved while the round trip was out wins: the late one is revoked, not saved", async () => {
  const first = { ...CONNECTED, sub: "sub-9", email: "first@example.test" };
  const { manager, google, credentials } = await setup({
    script: { [TOKEN]: [exchangeFor()] },
    flow: async (options, store) => {
      store.replace("acct-1", "gmail", first, 0);
      return signIn(options);
    },
  });

  assert.deepEqual(await manager.connect("gmail", "allowed"), {
    status: "failed",
    errorCode: "connection_changed",
  });
  assert.deepEqual(revoked(google), [{ token: "refresh-sub-1" }]);
  assert.deepEqual(credentials.read("acct-1", "gmail").credential, first);
});

test("Send commits exactly the card's fields, and the receipt holds recipients only", async () => {
  const { manager, google, log } = await setup({
    credential: CONNECTED,
    script: { [SEND]: [SENT] },
  });

  const prepared = await manager.prepare("gmail", "send", EMAIL, ALLOWED);

  assert.equal(prepared.status, "ready");
  assert.equal(prepared.preview.verbKey, "email");
  assert.equal(prepared.preview.destinationLabel, "josh@acme.test +1");
  assert.equal(prepared.preview.accountLabel, "you@example.test");
  assert.deepEqual(prepared.preview.fields, EMAIL);

  const result = await manager.commit(
    prepared.actionId,
    {
      to: ["lee@acme.test"],
      cc: ["ana@acme.test"],
      subject: "Q3 numbers (final)",
      body: "Revenue is up 12%.",
      bcc: ["spy@evil.test"],
      from: "boss@acme.test",
      title: "ignored",
    },
    ALLOWED
  );

  assert.deepEqual(result, {
    state: "sent",
    url: SENT_URL,
    destinationLabel: "lee@acme.test +1",
  });
  const message = decodeMessage(hits(google, SEND)[0].json.raw);
  assert.equal(header(message, "From"), "From: you@example.test");
  assert.equal(header(message, "To"), "To: lee@acme.test");
  assert.equal(header(message, "Cc"), "Cc: ana@acme.test");
  assert.equal(header(message, "Subject"), "Subject: Q3 numbers (final)");
  assert.equal(header(message, "Bcc"), null);
  assert.equal(message.body, "Revenue is up 12%.");
  const row = log.rows.get(prepared.actionId);
  assert.equal(row.state, "sent");
  // The receipt follows what was actually sent (lee@ + ana@), not the
  // card's original prepared recipients (josh@ + ana@).
  assert.equal(row.destinationLabel, "lee@acme.test +1");
  assert.doesNotMatch(JSON.stringify([...log.rows.values()]), /Q3 numbers|Revenue/);
});

test("edits that would add a header never reach Gmail", async () => {
  // The card's Subject is one line, so the manager refuses a subject with a
  // line break: nothing goes out, not even under the prepared subject.
  const subjectEdit = await setup({ credential: CONNECTED, script: { [SEND]: [SENT] } });
  const first = await subjectEdit.manager.prepare("gmail", "send", EMAIL, ALLOWED);
  assert.deepEqual(
    await subjectEdit.manager.commit(
      first.actionId,
      { subject: "Hi\r\nBcc: spy@evil.test" },
      ALLOWED
    ),
    { state: "not_sent", reason: "invalid_edit" }
  );
  assert.equal(hits(subjectEdit.google, SEND).length, 0);
  assert.equal(subjectEdit.log.rows.get(first.actionId).state, "cancelled");

  // An address with a line break reaches the connector, which refuses it.
  const addressEdit = await setup({ credential: CONNECTED, script: { [SEND]: [SENT] } });
  const second = await addressEdit.manager.prepare("gmail", "send", EMAIL, ALLOWED);
  const refused = await addressEdit.manager.commit(
    second.actionId,
    { to: ["josh@acme.test\r\nBcc: spy@evil.test"] },
    ALLOWED
  );
  assert.equal(refused.state, "failed");
  assert.equal(refused.errorCode, "invalid_recipients");
  assert.equal(hits(addressEdit.google, SEND).length, 0);
  assert.equal(addressEdit.log.rows.get(second.actionId).state, "failed");
});

test("an OpenWhispr account switch between prepare and Send sends nothing", async () => {
  // The new account presses Send on the old account's card.
  const byNewAccount = await setup({ credential: CONNECTED, script: { [SEND]: [SENT] } });
  const first = await byNewAccount.manager.prepare("gmail", "send", EMAIL, ALLOWED);
  byNewAccount.credentials.switchAccount("acct-2");
  assert.deepEqual(
    await byNewAccount.manager.commit(
      first.actionId,
      {},
      { policyState: "allowed", accountId: "acct-2" }
    ),
    { state: "not_sent", reason: "account_changed" }
  );
  assert.equal(hits(byNewAccount.google, SEND).length, 0);

  // A card still showing the old account is pressed after the switch.
  const staleCard = await setup({ credential: CONNECTED, script: { [SEND]: [SENT] } });
  const second = await staleCard.manager.prepare("gmail", "send", EMAIL, ALLOWED);
  staleCard.credentials.switchAccount("acct-2");
  assert.deepEqual(await staleCard.manager.commit(second.actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "connection_changed",
  });
  assert.equal(hits(staleCard.google, SEND).length, 0);
  assert.equal(staleCard.log.rows.get(second.actionId).state, "cancelled");
});

test("reconnecting as another Google account between prepare and Send cancels the card", async () => {
  const { manager, google, log } = await setup({
    credential: CONNECTED,
    script: {
      [SEND]: [SENT],
      [TOKEN]: [exchangeFor({ sub: "sub-2", email: "other@example.test" })],
    },
  });
  const prepared = await manager.prepare("gmail", "send", EMAIL, ALLOWED);

  assert.equal((await manager.connect("gmail", "allowed")).accountLabel, "other@example.test");

  assert.deepEqual(await manager.commit(prepared.actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
  assert.equal(hits(google, SEND).length, 0);
  assert.equal(log.rows.get(prepared.actionId).state, "cancelled");
  assert.equal(log.rows.get(prepared.actionId).errorCode, "connection_changed");
});

test("Disconnect between prepare and Send revokes the grant and cancels the card", async () => {
  const { manager, google, credentials, log } = await setup({
    credential: CONNECTED,
    script: { [SEND]: [SENT] },
  });
  const prepared = await manager.prepare("gmail", "send", EMAIL, ALLOWED);

  assert.deepEqual(await manager.disconnect("gmail"), { status: "disconnected" });

  assert.deepEqual(revoked(google), [{ token: "refresh-1" }]);
  assert.equal(credentials.read("acct-1", "gmail"), null);
  assert.deepEqual(await manager.commit(prepared.actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "not_found",
  });
  assert.equal(hits(google, SEND).length, 0);
  assert.equal(log.rows.get(prepared.actionId).state, "cancelled");
});

test("disconnectAll (account deletion) revokes the Gmail grant and clears the login", async () => {
  const { manager, google, credentials } = await setup({ credential: CONNECTED });

  await manager.disconnectAll();

  assert.deepEqual(revoked(google), [{ token: "refresh-1" }]);
  assert.equal(credentials.read("acct-1", "gmail"), null);
});

test("Disconnect with a calendar on the same grant clears the login without revoking", async () => {
  const { manager, google, credentials } = await setup({
    credential: CONNECTED,
    sharesGrant: () => true,
  });

  assert.deepEqual(await manager.disconnect("gmail"), {
    status: "disconnected",
    grantKept: true,
  });

  assert.deepEqual(revoked(google), [], "the calendar's grant stays live");
  assert.equal(credentials.read("acct-1", "gmail"), null);
});

test("Delete account with device erase revokes Gmail even on a shared grant", async () => {
  const { manager, google, credentials } = await setup({
    credential: CONNECTED,
    sharesGrant: () => true,
  });

  // cleanup-app runs next and finds no Gmail login left, so this is the one
  // chance to end the grant; the calendar is being erased too.
  await manager.disconnectAll({ erasingDevice: true });

  assert.deepEqual(revoked(google), [{ token: "refresh-1" }]);
  assert.equal(credentials.read("acct-1", "gmail"), null);
});

test("revokeAllStored (Reset app data) revokes Gmail signed out, even on a shared grant", async () => {
  const { manager, google, credentials } = await setup({
    credential: CONNECTED,
    sharesGrant: () => true,
  });
  credentials.switchAccount(null);

  await manager.revokeAllStored();

  assert.deepEqual(revoked(google), [{ token: "refresh-1" }]);
});

test("without a Google client, Gmail reports configured: false and Connect opens no browser", async () => {
  let opened = 0;
  const { manager } = await setup({
    configured: false,
    flow: async (options) => {
      opened += 1;
      return signIn(options);
    },
  });

  const [status] = await manager.status();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.deepEqual(await manager.connect("gmail", "allowed"), {
    status: "failed",
    errorCode: "not_configured",
  });
  assert.equal(opened, 0);
});
