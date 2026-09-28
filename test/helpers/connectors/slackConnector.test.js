const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  fakeSlackFetch,
  ok,
  slackError,
  httpStatus,
  reset,
  memoryCredentials,
} = require("./slackFixtures");

const BOUND = { binding: BINDING };
const NOT_CONNECTED = {
  connected: false,
  accountLabel: null,
  workspaceLabel: null,
  needsReconnect: false,
};

async function setupSlack(script, { credential = CONNECTED } = {}) {
  const [connectorModule, { createSlackApi }, { createSlackAuth }, { createSlackDirectory }] =
    await Promise.all([
      import("../../../src/helpers/connectors/slackConnector.js"),
      import("../../../src/helpers/connectors/slackApi.js"),
      import("../../../src/helpers/connectors/slackAuth.js"),
      import("../../../src/helpers/connectors/slackDirectory.js"),
    ]);
  const slack = fakeSlackFetch(script);
  const api = createSlackApi({ fetchImpl: slack.fetchImpl, sleep: async () => {} });
  const credentials = memoryCredentials(credential);
  const auth = createSlackAuth({
    api,
    credentials,
    getClientId: () => "123.456",
    OAuthFlowError: Error,
    runOAuthLoopbackFlow: async () => {
      throw new Error("not used in these tests");
    },
    now: () => NOW,
  });
  const connector = connectorModule.createSlackConnector({
    api,
    auth,
    directory: createSlackDirectory({ api, now: () => NOW }),
    credentials,
  });
  return { connector, slack, credentials, ...connectorModule };
}

const posts = (slack) => slack.calls.filter((call) => call.method === "chat.postMessage");
const postedText = (params) => params.markdown_text ?? params.text;
const channelsOnly = { "users.conversations": [ok(FIXTURES.channels)] };
const BOB = { ...CONNECTED, userId: "U0BOB", accessToken: "xoxe.xoxp-bob" };

async function prepareEng(connector, text = "Ship it") {
  const prepared = await connector.prepare("send_message", { destination: "#eng", text }, BOUND);
  assert.equal(prepared.status, "ready");
  return prepared;
}

test("a channel post: prepare only reads, and Send posts once with a permalink", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.posted)],
  });

  const prepared = await prepareEng(connector);
  assert.deepEqual(prepared.preview, {
    verbKey: "slackPost",
    destinationLabel: "#eng",
    accountLabel: "chad",
    workspaceLabel: "Acme Test",
    body: "Ship it",
  });
  assert.deepEqual(slack.methods(), ["users.conversations"]);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.deepEqual(result, {
    state: "sent",
    url: "https://acme-test.slack.com/archives/C0ENG/p1727200000123456",
  });
  assert.deepEqual(slack.methods(), ["users.conversations", "chat.postMessage"]);
  assert.equal(posts(slack)[0].params.channel, "C0ENG");
});

test("a DM is opened only after Send, never while preparing", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [ok(FIXTURES.dmOpen)],
    "chat.postMessage": [ok(FIXTURES.postedDm)],
  });

  const prepared = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith", text: "Lunch?" },
    BOUND
  );
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.preview.destinationLabel, "Gabe Smith");
  assert.equal(slack.methods().includes("conversations.open"), false);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "sent");
  assert.deepEqual(slack.methods().slice(-2), ["conversations.open", "chat.postMessage"]);
  assert.deepEqual(slack.calls.at(-2).params, { users: "U0GABE" });
  assert.equal(posts(slack)[0].params.channel, "D0GABE");
});

test("an ambiguous name asks which one and prepares nothing", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });

  const prepared = await connector.prepare(
    "send_message",
    { destination: "gab", text: "hi" },
    BOUND
  );

  assert.equal(prepared.status, "needs_clarification");
  assert.deepEqual(prepared.candidates, ["Gabe Smith (@gabe)", "Gabriel Stone (@gstone)"]);
  assert.equal(
    slack
      .methods()
      .some((method) => method === "chat.postMessage" || method === "conversations.open"),
    false
  );
});

test("an unknown #channel or email asks the user instead of guessing", async () => {
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.lookupByEmail": [slackError("users_not_found")],
  });

  const channel = await connector.prepare(
    "send_message",
    { destination: "#random", text: "hi" },
    BOUND
  );
  assert.equal(channel.status, "needs_clarification");
  assert.match(channel.message, /#random/);

  const email = await connector.prepare(
    "send_message",
    { destination: "nobody@example.com", text: "hi" },
    BOUND
  );
  assert.equal(email.status, "needs_clarification");
});

test("a directory cut off at the page cap never claims a unique name", async () => {
  const sam = {
    id: "U0SAM",
    name: "sam",
    deleted: false,
    is_bot: false,
    profile: { real_name: "Sam Lee", display_name: "sam" },
  };
  const endless = (key, item) => ({
    ok: true,
    [key]: [item],
    response_metadata: { next_cursor: "more" },
  });

  const people = await setupSlack({ ...channelsOnly, "users.list": [ok(endless("members", sam))] });
  const byName = await people.connector.prepare(
    "send_message",
    { destination: "Sam", text: "hi" },
    BOUND
  );
  assert.equal(byName.status, "needs_clarification");
  assert.match(byName.message, /email/);

  const exact = await setupSlack({
    "users.conversations": [ok(endless("channels", FIXTURES.channels.channels[0]))],
  });
  assert.equal(
    (await exact.connector.prepare("send_message", { destination: "#eng", text: "hi" }, BOUND))
      .status,
    "ready"
  );

  const prefixOnly = await setupSlack({
    "users.conversations": [ok(endless("channels", FIXTURES.channels.channels[1]))],
  });
  assert.equal(
    (await prefixOnly.connector.prepare("send_message", { destination: "#eng", text: "hi" }, BOUND))
      .status,
    "needs_clarification"
  );
});

test("Slack refusing an expired token refreshes the same login once and posts once", async () => {
  const { connector, slack, credentials } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [slackError("token_expired"), ok(FIXTURES.posted)],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });
  const prepared = await prepareEng(connector);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "sent");
  assert.deepEqual(
    posts(slack).map((call) => call.authorization),
    ["Bearer xoxe.xoxp-1-test-access", "Bearer xoxe.xoxp-1-test-access-2"]
  );
  assert.equal(credentials.saves.at(-1).accessToken, "xoxe.xoxp-1-test-access-2");
  assert.equal(
    credentials.generation("acct-1", "slack"),
    1,
    "a refresh keeps pending approvals valid"
  );
});

test("an HTTP 401 takes the same refresh-then-retry path", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [httpStatus(401), ok(FIXTURES.posted)],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });
  const prepared = await prepareEng(connector);

  assert.equal((await connector.commit("send_message", prepared.payload, {}, BOUND)).state, "sent");
  assert.equal(posts(slack).length, 2);
});

test("a reconnect before Send refuses the send without calling Slack", async () => {
  const { connector, slack, credentials } = await setupSlack(channelsOnly);
  const prepared = await prepareEng(connector);
  credentials.replace("acct-1", "slack", BOB, 1);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "connection_changed");
  assert.equal(posts(slack).length, 0);
});

test("a reconnect while refreshing after a token refusal never sends as the new login", async () => {
  let credentials;
  const setup = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [slackError("token_expired"), ok(FIXTURES.posted)],
    "oauth.v2.access": [
      { body: FIXTURES.refresh, during: () => credentials.replace("acct-1", "slack", BOB, 1) },
    ],
  });
  credentials = setup.credentials;
  const prepared = await prepareEng(setup.connector);

  const result = await setup.connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "connection_changed");
  assert.deepEqual(
    posts(setup.slack).map((call) => call.authorization),
    ["Bearer xoxe.xoxp-1-test-access"]
  );
});

const slot = (credentials) => credentials.read("acct-1", "slack").credential;

test("a login Slack revoked at Send flips to Reconnect, with one post", async () => {
  for (const code of ["token_revoked", "account_inactive", "not_authed"]) {
    const { connector, slack, credentials } = await setupSlack({
      ...channelsOnly,
      "chat.postMessage": [slackError(code)],
      "oauth.v2.access": [slackError("invalid_refresh_token")],
    });
    const prepared = await prepareEng(connector);

    const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

    assert.equal(result.state, "failed", code);
    assert.equal(result.errorCode, "reconnect_needed", code);
    assert.equal(slot(credentials).needsReconnect, true, code);
    assert.equal(posts(slack).length, 1, `${code}: a refused post is never repeated`);
  }
});

test("a login Slack revoked while preparing flips to Reconnect", async () => {
  const { connector, slack, credentials } = await setupSlack({
    "users.conversations": [slackError("token_revoked")],
    "oauth.v2.access": [slackError("invalid_refresh_token")],
  });

  const prepared = await connector.prepare(
    "send_message",
    { destination: "#eng", text: "hi" },
    BOUND
  );

  assert.equal(prepared.status, "failed");
  assert.equal(prepared.errorCode, "reconnect_needed");
  assert.equal(slot(credentials).needsReconnect, true);
  assert.deepEqual(slack.methods(), ["users.conversations", "oauth.v2.access"]);
});

test("a lookup refused for its token is asked once more after refreshing the same login", async () => {
  const { connector, slack, credentials } = await setupSlack({
    "users.conversations": [slackError("invalid_auth"), ok(FIXTURES.channels)],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });

  const prepared = await prepareEng(connector);

  assert.equal(prepared.payload.target.id, "C0ENG");
  assert.deepEqual(
    slack.calls
      .filter((call) => call.method === "users.conversations")
      .map((call) => call.authorization),
    ["Bearer xoxe.xoxp-1-test-access", "Bearer xoxe.xoxp-1-test-access-2"]
  );
  assert.equal(slot(credentials).needsReconnect, false);
});

test("a token refused again right after a successful refresh needs a reconnect", async () => {
  const atSend = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [slackError("invalid_auth"), slackError("invalid_auth")],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });
  const prepared = await prepareEng(atSend.connector);

  const sent = await atSend.connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(sent.state, "failed");
  assert.equal(sent.errorCode, "reconnect_needed");
  assert.equal(slot(atSend.credentials).needsReconnect, true);
  assert.equal(slot(atSend.credentials).accessToken, "xoxe.xoxp-1-test-access-2");
  assert.equal(posts(atSend.slack).length, 2);

  const atPrepare = await setupSlack({
    "users.conversations": [slackError("token_revoked"), slackError("token_revoked")],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });
  const refused = await atPrepare.connector.prepare(
    "send_message",
    { destination: "#eng", text: "hi" },
    BOUND
  );
  assert.equal(refused.status, "failed");
  assert.equal(refused.errorCode, "reconnect_needed");
  assert.equal(slot(atPrepare.credentials).needsReconnect, true);
});

test("a reconnect racing the reconnect flag reports connection_changed and leaves the new login alone", async () => {
  let credentials;
  const setup = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [
      slackError("invalid_auth"),
      {
        ...slackError("invalid_auth"),
        during: () => credentials.replace("acct-1", "slack", BOB, 1),
      },
    ],
    "oauth.v2.access": [ok(FIXTURES.refresh)],
  });
  credentials = setup.credentials;
  const prepared = await prepareEng(setup.connector);

  const result = await setup.connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "connection_changed");
  assert.deepEqual(slot(credentials), BOB, "nothing was written to the new login");
  assert.equal(credentials.saves.length, 1, "only the old login's refresh was saved");
  assert.equal(posts(setup.slack).length, 2);
});

test("a short 429 is retried once and posts once", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [httpStatus(429, { "retry-after": "1" }), ok(FIXTURES.posted)],
  });
  const prepared = await prepareEng(connector);

  assert.equal((await connector.commit("send_message", prepared.payload, {}, BOUND)).state, "sent");
  assert.equal(posts(slack).length, 2);
});

test("permission and membership errors are failed with a specific reason", async () => {
  for (const [code, message] of [
    ["not_in_channel", "You're not a member of #eng."],
    ["is_archived", "#eng is archived."],
    ["missing_scope", /permission/],
  ]) {
    const { connector } = await setupSlack({
      ...channelsOnly,
      "chat.postMessage": [slackError(code)],
    });
    const prepared = await prepareEng(connector);
    const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
    assert.equal(result.state, "failed", code);
    assert.equal(result.errorCode, code);
    if (message instanceof RegExp) assert.match(result.message, message);
    else assert.equal(result.message, message);
  }
});

test("a reset after the write, a 5xx or internal_error is unknown, with a link to check, and never retried", async () => {
  for (const reply of [reset(), httpStatus(503), slackError("internal_error")]) {
    const { connector, slack } = await setupSlack({ ...channelsOnly, "chat.postMessage": [reply] });
    const prepared = await prepareEng(connector);
    const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
    assert.equal(result.state, "unknown");
    assert.equal(result.checkUrl, "https://app.slack.com/client/T0TEST/C0ENG");
    assert.equal(posts(slack).length, 1);
  }
});

test("a reset while opening a DM is failed: the message was never posted", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [reset()],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith", text: "hi" },
    BOUND
  );

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "failed");
  assert.equal(posts(slack).length, 0);
});

test("edited text that is empty or too long is refused without calling Slack", async () => {
  const { connector, slack, SLACK_MESSAGE_LIMIT } = await setupSlack(channelsOnly);
  const prepared = await prepareEng(connector);

  assert.deepEqual(
    await connector.commit("send_message", prepared.payload, { body: "   " }, BOUND),
    {
      state: "failed",
      errorCode: "no_text",
      message: "The message is empty.",
    }
  );
  const tooLong = await connector.commit(
    "send_message",
    prepared.payload,
    { body: "x".repeat(SLACK_MESSAGE_LIMIT + 1) },
    BOUND
  );
  assert.equal(tooLong.errorCode, "msg_too_long");
  assert.deepEqual(slack.methods(), ["users.conversations"]);
});

test("the length limit applies to what Slack receives, after escaping", async () => {
  const { connector, slack, formatMessage, SLACK_MESSAGE_LIMIT, SLACK_ESCAPE_SPECIALS } =
    await setupSlack(channelsOnly);
  const ampersands = "&".repeat(3000);

  if (!SLACK_ESCAPE_SPECIALS) {
    assert.equal(formatMessage(ampersands), ampersands, "nothing expands without escaping");
    return;
  }
  assert.ok(formatMessage(ampersands).length > SLACK_MESSAGE_LIMIT);
  const refused = await connector.prepare(
    "send_message",
    { destination: "#eng", text: ampersands },
    BOUND
  );
  assert.equal(refused.errorCode, "msg_too_long");
  const prepared = await prepareEng(connector);
  const atSend = await connector.commit(
    "send_message",
    prepared.payload,
    { body: ampersands },
    BOUND
  );
  assert.equal(atSend.errorCode, "msg_too_long");
  assert.deepEqual(slack.methods(), ["users.conversations"]);
});

test("mentions and special characters post exactly as the card showed them", async () => {
  const { connector, slack, escapeSpecials, SLACK_ESCAPE_SPECIALS } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.posted)],
  });
  assert.equal(escapeSpecials("5 < 6 & 7 > 3 <!here>"), "5 &lt; 6 &amp; 7 &gt; 3 &lt;!here&gt;");
  const text = "5 < 6 & <!here> <@U0GABE>";

  const prepared = await prepareEng(connector, text);
  assert.equal(prepared.preview.body, text, "the card shows what the model wrote");
  await connector.commit("send_message", prepared.payload, {}, BOUND);

  const posted = postedText(posts(slack)[0].params);
  assert.equal(posted, SLACK_ESCAPE_SPECIALS ? escapeSpecials(text) : text);
  if (SLACK_ESCAPE_SPECIALS) assert.equal(posted.includes("<!"), false);
});

test("a login that needs reconnecting fails prepare without calling Slack", async () => {
  const { connector, slack } = await setupSlack(
    {},
    { credential: { ...CONNECTED, needsReconnect: true } }
  );

  const prepared = await connector.prepare(
    "send_message",
    { destination: "#eng", text: "hi" },
    BOUND
  );

  assert.equal(prepared.status, "failed");
  assert.equal(prepared.errorCode, "reconnect_needed");
  assert.deepEqual(slack.calls, []);
});

test("authorize passes the connect's cancel signal on to Slack auth", async () => {
  const { createSlackConnector } =
    await import("../../../src/helpers/connectors/slackConnector.js");
  const seen = [];
  const connector = createSlackConnector({
    api: null,
    auth: { authorize: async (options) => seen.push(options) },
    directory: null,
    credentials: null,
  });
  const controller = new AbortController();

  await connector.authorize({ signal: controller.signal });

  assert.equal(seen[0].signal, controller.signal);
});

test("the binding and status follow the active account's login", async () => {
  const { connector, credentials } = await setupSlack({});
  assert.deepEqual(await connector.getBinding(), BINDING);

  credentials.replace("acct-1", "slack", { ...CONNECTED, userId: "U0OTHER" }, 1);
  assert.deepEqual(await connector.getBinding(), {
    ...BINDING,
    accountId: "U0OTHER",
    generation: 2,
  });

  credentials.switchAccount("acct-2");
  assert.equal(await connector.getBinding(), null);
  assert.deepEqual(await connector.getStatus(), NOT_CONNECTED);
});
