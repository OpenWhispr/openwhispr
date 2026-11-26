const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
    url: "https://acme-test.slack.com/archives/C0ENG0001/p1727200000123456",
  });
  assert.deepEqual(slack.methods(), ["users.conversations", "chat.postMessage"]);
  assert.equal(posts(slack)[0].params.channel, "C0ENG0001");
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
  // With the username, since display names repeat.
  assert.equal(prepared.preview.destinationLabel, "Gabe Smith (@gabe)");
  assert.equal(slack.methods().includes("conversations.open"), false);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(result.state, "sent");
  assert.deepEqual(slack.methods().slice(-2), ["conversations.open", "chat.postMessage"]);
  assert.deepEqual(slack.calls.at(-2).params, { users: "U0GABE001" });
  assert.equal(posts(slack)[0].params.channel, "D0GABE001");
});

const GROUP_OPEN = { ok: true, channel: { id: "C0MPIM001" } };
const POSTED_GROUP = { ...FIXTURES.posted, channel: "C0MPIM001" };

test("a group DM is named by its people: Send opens it with all of them and posts there", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [ok(GROUP_OPEN)],
    "chat.postMessage": [ok(POSTED_GROUP)],
  });

  // The user is in every group DM they post to, so naming them changes nothing.
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith, @gstone, chad", text: "Standup notes" },
    BOUND
  );
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.preview.destinationLabel, "Gabe Smith (@gabe), Gabriel Stone (@gstone)");
  assert.equal(slack.methods().includes("conversations.open"), false);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
  assert.equal(result.state, "sent");
  assert.deepEqual(slack.calls.at(-2).params, { users: "U0GABE001,U0GABRIEL" });
  assert.equal(posts(slack)[0].params.channel, "C0MPIM001");

  // Its link then names that group DM, as a reply in its thread does.
  const again = await connector.prepare(
    "send_message",
    { destination: "https://acme-test.slack.com/archives/C0MPIM001", text: "One more thing" },
    BOUND
  );
  assert.equal(again.status, "ready");
  assert.equal(again.preview.destinationLabel, "Gabe Smith (@gabe), Gabriel Stone (@gstone)");
});

test("a list that isn't two or more other people is no group DM", async () => {
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });

  const oneOther = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith, chad", text: "Lunch?" },
    BOUND
  );
  assert.equal(oneOther.status, "ready");
  assert.equal(oneOther.preview.destinationLabel, "Gabe Smith (@gabe)");
  assert.equal(oneOther.payload.target.kind, "user");

  const withChannel = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith, #eng", text: "Lunch?" },
    BOUND
  );
  assert.equal(withChannel.status, "needs_clarification");
});

test("a login from before group DMs is told to reconnect when Slack refuses to open one", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [slackError("missing_scope")],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Gabe Smith, Gabriel Stone", text: "Standup notes" },
    BOUND
  );
  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(posts(slack).length, 0);
  // Flagged, so Settings and the card offer a reconnect, which asks for the new scope.
  assert.equal((await connector.getStatus()).needsReconnect, true);
});

const groupStandup = { destination: "Gabe Smith, Gabriel Stone", text: "Standup notes" };

test("a login whose scopes leave out group DMs is told so before any card, and is never flagged", async () => {
  const { connector, slack } = await setupSlack(
    {
      ...channelsOnly,
      "users.list": [ok(FIXTURES.people)],
      "chat.postMessage": [ok(FIXTURES.posted)],
    },
    { credential: { ...CONNECTED, scopes: ["chat:write", "channels:read", "users:read"] } }
  );
  const prepared = await connector.prepare("send_message", groupStandup, BOUND);
  assert.equal(prepared.status, "failed");
  assert.equal(prepared.errorCode, "missing_scope");
  assert.match(prepared.message, /group DMs/);
  assert.equal(slack.methods().includes("conversations.open"), false);
  assert.equal((await connector.getStatus()).needsReconnect, false);
  // A reconnect can't grant what the workspace withholds: posts elsewhere still go out.
  const eng = await prepareEng(connector);
  assert.equal((await connector.commit("send_message", eng.payload, {}, BOUND)).state, "sent");
});

test("Slack refusing a group DM the login's scopes allow never flags the login", async () => {
  const { connector, slack } = await setupSlack(
    {
      ...channelsOnly,
      "users.list": [ok(FIXTURES.people)],
      "conversations.open": [slackError("missing_scope")],
    },
    { credential: { ...CONNECTED, scopes: ["chat:write", "mpim:write", "users:read"] } }
  );
  const prepared = await connector.prepare("send_message", groupStandup, BOUND);
  assert.equal(prepared.status, "ready");
  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "missing_scope");
  assert.equal(posts(slack).length, 0);
  assert.equal((await connector.getStatus()).needsReconnect, false);
});

test("a person whose name has a comma in it is that person, not a group DM", async () => {
  const smith = {
    id: "U0SMITH01",
    name: "gsmith",
    deleted: false,
    is_bot: false,
    profile: { real_name: "Smith, Gabe", display_name: "" },
  };
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok({ ...FIXTURES.people, members: [...FIXTURES.people.members, smith] })],
  });
  // However the comma is spaced or the name cased, as any name is matched.
  for (const destination of ["Smith, Gabe", "Smith,Gabe", "smith ,  gabe", "SMITH, GABE"]) {
    const prepared = await connector.prepare("send_message", { destination, text: "Hi" }, BOUND);
    assert.equal(prepared.preview?.destinationLabel, "Smith, Gabe (@gsmith)", destination);
  }
});

test("people who share a name with a comma in it are offered to pick from", async () => {
  const smith = (id, name) => ({
    id,
    name,
    deleted: false,
    is_bot: false,
    profile: { real_name: "Smith, Gabe", display_name: "" },
  });
  const members = [
    ...FIXTURES.people.members,
    smith("U0SMITH01", "gsmith"),
    smith("U0SMITH02", "gsmith2"),
  ];
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok({ ...FIXTURES.people, members })],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Smith, Gabe", text: "Hi" },
    BOUND
  );
  assert.equal(prepared.status, "needs_clarification");
  assert.deepEqual(
    prepared.choices.map((choice) => choice.destination),
    ["@gsmith", "@gsmith2"]
  );
});

test("a list of people is a group DM even when it loosely matches one channel's name", async () => {
  const gabeGabriel = { ...FIXTURES.channels.channels[0], id: "C0GABEGAB", name: "gabe-gabriel" };
  const { connector } = await setupSlack({
    "users.conversations": [
      ok({ ...FIXTURES.channels, channels: [...FIXTURES.channels.channels, gabeGabriel] }),
    ],
    "users.list": [ok(FIXTURES.people)],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Gabe, Gabriel", text: "Hi" },
    BOUND
  );
  assert.equal(prepared.preview.destinationLabel, "Gabe Smith (@gabe), Gabriel Stone (@gstone)");
});

test("a list with a name that matches several people asks about that name, never a looser match", async () => {
  const person = (id, name, realName) => ({
    id,
    name,
    deleted: false,
    is_bot: false,
    profile: { real_name: realName, display_name: "" },
  });
  const members = [
    ...FIXTURES.people.members,
    person("U0ANASAMP", "asampson", "Ana Sampson"),
    person("U0SAMALPH", "sama", "Sam Alpha"),
    person("U0SAMBETA", "samb", "Sam Beta"),
  ];
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok({ ...FIXTURES.people, members })],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Ana, Sam", text: "Hi" },
    BOUND
  );
  assert.equal(prepared.status, "needs_clarification");
  assert.match(prepared.message, /"Sam"/);
  assert.deepEqual(prepared.candidates, ["Sam Alpha (@sama)", "Sam Beta (@samb)"]);
  // A pick would post to that one person, without Ana.
  assert.equal(prepared.choices, undefined);
});

test("two people with the same name are told apart by their usernames", async () => {
  const alex = (id, name) => ({
    id,
    name,
    deleted: false,
    is_bot: false,
    profile: { real_name: "Alex Chen", display_name: "alex" },
  });
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok({ ok: true, members: [alex("U0A1", "alex.chen"), alex("U0A2", "achen")] })],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "Alex Chen", text: "hi" },
    BOUND
  );
  assert.deepEqual(prepared.choices, [
    { label: "Alex Chen (@alex.chen)", destination: "@alex.chen" },
    { label: "Alex Chen (@achen)", destination: "@achen" },
  ]);
  // The model reads the same usernames where no picker shows.
  assert.deepEqual(prepared.candidates, ["Alex Chen (@alex.chen)", "Alex Chen (@achen)"]);
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
  // What the user picks from: each one finds exactly that person again.
  assert.deepEqual(prepared.choices, [
    { label: "Gabe Smith (@gabe)", destination: "@gabe" },
    { label: "Gabriel Stone (@gstone)", destination: "@gstone" },
  ]);
  for (const { destination } of prepared.choices) {
    const picked = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(picked.status, "ready", destination);
  }
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

  assert.equal(prepared.payload.target.id, "C0ENG0001");
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
    assert.equal(result.checkUrl, "https://app.slack.com/client/T0TEST/C0ENG0001");
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
  const text = "5 < 6 & <!here> <@U0GABE001>";

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

test("a Slack login is the same account only for the same user in the same workspace", async () => {
  const { createSlackConnector } =
    await import("../../../src/helpers/connectors/slackConnector.js");
  const { loginKey } = createSlackConnector({
    api: null,
    auth: null,
    directory: null,
    credentials: null,
  });
  const login = { userId: "U1", teamId: "T1" };
  assert.equal(loginKey(login), loginKey({ ...login, accessToken: "newer" }));
  assert.notEqual(loginKey(login), loginKey({ ...login, userId: "U2" }));
  assert.notEqual(loginKey(login), loginKey({ ...login, teamId: "T2" }));
});

test("Slack's card lets the user edit only the message text", async () => {
  const { connector } = await setupSlack({});
  assert.deepEqual(connector.actions, {
    send_message: { kind: "approval", editable: { body: "text" } },
  });
});

// The whole path the card's Send takes: the manager keeps only the declared
// body, and Slack posts it to the channel the card was prepared for.
test("an edited Slack card posts its edited text through the manager, and nothing else it sent", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.posted)],
  });
  const [{ createConnectorManager }, { createPendingActions }] = await Promise.all([
    import("../../../src/helpers/connectors/connectorManager.js"),
    import("../../../src/helpers/connectors/pendingActions.js"),
  ]);
  const manager = createConnectorManager({
    connectors: [connector],
    pendingActions: createPendingActions(),
    actionLog: {
      insert() {},
      update: () => 1,
      listRecent: () => [],
      reconcileInterrupted: () => ({}),
    },
    logger: { info() {}, warn() {}, error() {} },
    getAccountId: () => "acct-1",
  });
  const auth = { policyState: "allowed", accountId: "acct-1" };

  const prepared = await manager.prepare(
    "slack",
    "send_message",
    { destination: "#eng", text: "Ship it" },
    auth
  );
  assert.equal(prepared.status, "ready");
  const result = await manager.commit(
    prepared.actionId,
    { body: "Ship it today", title: "Ignored", channel: "C0OTHER", text: "Not this" },
    auth
  );

  assert.equal(result.state, "sent");
  assert.equal(posts(slack).length, 1);
  assert.equal(posts(slack)[0].params.channel, "C0ENG0001");
  assert.equal(postedText(posts(slack)[0].params), "Ship it today");
});

test("a picked @username finds that person even when it is someone else's display name", async () => {
  const person = (id, name, realName, displayName) => ({
    id,
    name,
    deleted: false,
    is_bot: false,
    profile: { real_name: realName, display_name: displayName },
  });
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [
      ok({
        ok: true,
        members: [
          person("U1", "john", "John Park", ""),
          person("U2", "jsmith", "John Smith", "john"),
        ],
      }),
    ],
  });
  const asked = await connector.prepare("send_message", { destination: "John", text: "hi" }, BOUND);
  assert.equal(asked.status, "needs_clarification");
  const park = asked.choices.find((choice) => choice.label.startsWith("John Park"));
  assert.equal(park.destination, "@john");
  const picked = await connector.prepare(
    "send_message",
    { destination: park.destination, text: "hi" },
    BOUND
  );
  assert.equal(picked.status, "ready");
  assert.match(picked.preview.destinationLabel, /John Park/);
});

test("a list cut off at the page cap still finds an exact @username", async () => {
  const sam = {
    id: "U0SAM",
    name: "sam",
    deleted: false,
    is_bot: false,
    profile: { real_name: "Sam Lee", display_name: "sam" },
  };
  const { connector } = await setupSlack({
    ...channelsOnly,
    // More pages than the cap: the list is cut off.
    "users.list": [ok({ ok: true, members: [sam], response_metadata: { next_cursor: "more" } })],
  });
  const picked = await connector.prepare(
    "send_message",
    { destination: "@sam", text: "hi" },
    BOUND
  );
  assert.equal(picked.status, "ready");
  const named = await connector.prepare(
    "send_message",
    { destination: "Sam Lee", text: "hi" },
    BOUND
  );
  assert.equal(named.status, "needs_clarification", "a name alone still isn't enough");
});

// Links to FIXTURES.posted (where a thread starts), to FIXTURES.postedReply
// in that thread, and to FIXTURES.postedDm.
const ENG_MESSAGE = "https://acme-test.slack.com/archives/C0ENG0001/p1727200000123456";
const ENG_REPLY =
  "https://acme-test.slack.com/archives/C0ENG0001/p1727200009000200?thread_ts=1727200000.123456&cid=C0ENG0001";
const GABE_DM_MESSAGE = "https://acme-test.slack.com/archives/D0GABE001/p1727200001000100";
// The card's note names when the thread started (ms), so it says which thread.
const replyNote = (started) => ({
  key: "connectors.approval.slack.notes.replyInThread",
  values: { started },
});

test("a thread link posts the reply in that thread, and the result links the reply in it", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.postedReply)],
  });

  const prepared = await connector.prepare(
    "send_message",
    { destination: "#eng", text: "On it", thread: ENG_MESSAGE },
    BOUND
  );
  assert.equal(prepared.status, "ready");
  assert.deepEqual(prepared.preview.notes, [replyNote("1727200000123")]);
  assert.deepEqual(slack.methods(), ["users.conversations"]);

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(posts(slack)[0].params.channel, "C0ENG0001");
  assert.equal(posts(slack)[0].params.thread_ts, "1727200000.123456");
  // Slack's own link to a reply, so replying to it again stays in the thread.
  assert.deepEqual(result, { state: "sent", url: ENG_REPLY });
});

test("a link to a message as the destination replies in its thread", async () => {
  // The thread's first message, or a reply in it.
  for (const destination of [ENG_MESSAGE, ENG_REPLY]) {
    const { connector, slack } = await setupSlack({
      ...channelsOnly,
      "chat.postMessage": [ok(FIXTURES.postedReply)],
    });

    const prepared = await connector.prepare("send_message", { destination, text: "On it" }, BOUND);
    assert.equal(prepared.status, "ready", destination);
    assert.deepEqual(prepared.preview.notes, [replyNote("1727200000123")], destination);
    await connector.commit("send_message", prepared.payload, {}, BOUND);

    assert.equal(posts(slack)[0].params.channel, "C0ENG0001", destination);
    assert.equal(posts(slack)[0].params.thread_ts, "1727200000.123456", destination);
  }
});

test("the Reply in thread note shows when the thread started, in every language", async () => {
  const i18next = (await import("i18next")).default.createInstance();
  const languages = fs
    .readdirSync(path.join(__dirname, "../../../src/locales"))
    .filter((name) =>
      fs.existsSync(path.join(__dirname, "../../../src/locales", name, "translation.json"))
    );
  await i18next.init({
    lng: "en",
    resources: Object.fromEntries(
      languages.map((language) => [
        language,
        { translation: require(`../../../src/locales/${language}/translation.json`) },
      ])
    ),
    interpolation: { escapeValue: false },
  });
  const key = "connectors.approval.slack.notes.replyInThread";
  assert.ok(languages.length >= 11);
  for (const language of languages) {
    const note = i18next.t(key, { lng: language, started: "1727200000123" });
    assert.notEqual(note, key, language);
    assert.doesNotMatch(note, /\{\{|datetime/, language);
  }
  assert.match(
    i18next.t(key, { started: "1727200000123" }),
    /^Reply in thread started Sep 2\d, 2024/
  );
});

test("a reply Slack didn't thread is linked as the message it is", async () => {
  const { message } = FIXTURES.postedReply;
  const { connector } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [
      ok({ ...FIXTURES.postedReply, message: { ...message, thread_ts: undefined } }),
    ],
  });
  const prepared = await connector.prepare(
    "send_message",
    { destination: "#eng", text: "On it", thread: ENG_MESSAGE },
    BOUND
  );

  const result = await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.deepEqual(result, {
    state: "sent",
    url: "https://acme-test.slack.com/archives/C0ENG0001/p1727200009000200",
    outsideThread: true,
  });
});

test("a reply's link replies in its thread, not under the reply", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.postedReply)],
  });

  const prepared = await connector.prepare(
    "send_message",
    { destination: "#eng", text: "Same thread", thread: ENG_REPLY },
    BOUND
  );
  await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(posts(slack)[0].params.thread_ts, "1727200000.123456");
});

test("without a thread nothing changes: no note, no thread_ts", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.posted)],
  });
  for (const thread of [undefined, null, "", "  "]) {
    const prepared = await connector.prepare(
      "send_message",
      { destination: "#eng", text: "Ship it", thread },
      BOUND
    );
    assert.equal(prepared.preview.notes, undefined, String(thread));
  }
  const prepared = await prepareEng(connector);
  await connector.commit("send_message", prepared.payload, {}, BOUND);
  assert.equal("thread_ts" in posts(slack)[0].params, false);
});

test("a thread in another conversation than the destination is refused before Slack is written to", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });

  for (const destination of ["#eng-backend", "Gabe Smith"]) {
    const refused = await connector.prepare(
      "send_message",
      { destination, text: "hi", thread: ENG_MESSAGE },
      BOUND
    );
    assert.equal(refused.status, "failed", destination);
    assert.equal(refused.errorCode, "thread_mismatch", destination);
  }
  // A DM no Send opened here isn't known by its person: asked about first.
  const asked = await connector.prepare(
    "send_message",
    { destination: GABE_DM_MESSAGE, text: "hi", thread: ENG_MESSAGE },
    BOUND
  );
  assert.equal(asked.status, "needs_clarification");
  assert.equal(
    slack
      .methods()
      .some((method) => method === "chat.postMessage" || method === "conversations.open"),
    false
  );
});

test("a DM thread for a person is checked against the DM opened at Send", async () => {
  const other = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [ok({ ok: true, channel: { id: "D0OTHER01" } })],
  });
  const prepared = await other.connector.prepare(
    "send_message",
    { destination: "Gabe Smith", text: "hi", thread: GABE_DM_MESSAGE },
    BOUND
  );
  assert.equal(prepared.status, "ready");
  assert.deepEqual(prepared.preview.notes, [replyNote("1727200001000")]);

  const refused = await other.connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(refused.state, "failed");
  assert.equal(refused.errorCode, "thread_mismatch");
  assert.equal(posts(other.slack).length, 0, "nothing posted after the mismatch");

  const same = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "conversations.open": [ok(FIXTURES.dmOpen)],
    "chat.postMessage": [ok(FIXTURES.postedDm)],
  });
  const ready = await same.connector.prepare(
    "send_message",
    { destination: "Gabe Smith", text: "hi", thread: GABE_DM_MESSAGE },
    BOUND
  );
  const sent = await same.connector.commit("send_message", ready.payload, {}, BOUND);
  assert.equal(sent.state, "sent");
  assert.deepEqual(posts(same.slack)[0].params, {
    channel: "D0GABE001",
    markdown_text: "hi",
    thread_ts: "1727200001.000100",
  });
});

test("a link that isn't to a Slack message, or whose cid disagrees with it, is refused before calling Slack", async () => {
  const { connector, slack } = await setupSlack(channelsOnly);
  for (const thread of [
    "https://acme-test.slack.com/archives/C0ENG0001",
    "https://acme-test.slack.com/archives/C0ENG0001/p1727200000123456?thread_ts=soon",
    `${ENG_MESSAGE}?cid=C0OTHER01`,
    // Not shaped like a Slack id.
    "https://acme-test.slack.com/archives/D1/p1727200000123456",
    "https://acme-test.slack.com/archives/DESIGN/p1727200000123456",
    `${ENG_REPLY.replace("cid=C0ENG0001", "cid=C0OTHER01")}`,
    "https://example.com/archives/C0ENG0001/p1727200000123456",
    "https://slack.com.example.net/archives/C0ENG0001/p1727200000123456",
    "http://acme-test.slack.com/archives/C0ENG0001/p1727200000123456",
    "1727200000.123456",
  ]) {
    const refused = await connector.prepare(
      "send_message",
      { destination: "#eng", text: "hi", thread },
      BOUND
    );
    assert.equal(refused.status, "failed", thread);
    assert.equal(refused.errorCode, "invalid_thread", thread);
    assert.equal(typeof refused.message, "string");
  }
  assert.deepEqual(slack.calls, []);
});

// Enterprise Grid and Slack Connect links aren't on the workspace's own
// domain; the conversation is pinned by its id either way.
test("a link on another Slack domain is taken by its conversation", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "chat.postMessage": [ok(FIXTURES.postedReply)],
  });

  const prepared = await connector.prepare(
    "send_message",
    {
      destination: "https://partner.slack.com/archives/C0ENG0001",
      text: "hi",
      thread: "https://acme.enterprise.slack.com/archives/C0ENG0001/p1727200000123456",
    },
    BOUND
  );
  assert.equal(prepared.status, "ready");
  assert.deepEqual(prepared.payload.target, { kind: "channel", id: "C0ENG0001", label: "#eng" });
  await connector.commit("send_message", prepared.payload, {}, BOUND);

  assert.equal(posts(slack)[0].params.thread_ts, "1727200000.123456");
});

test("Slack refusing a reply in that thread is failed, not unknown", async () => {
  for (const code of [
    "cannot_reply_to_message",
    "restricted_action_thread_locked",
    "restricted_action_non_threadable_channel",
  ]) {
    const { connector } = await setupSlack({
      ...channelsOnly,
      "chat.postMessage": [slackError(code)],
    });
    const prepared = await connector.prepare(
      "send_message",
      { destination: "#eng", text: "hi", thread: ENG_MESSAGE },
      BOUND
    );
    const result = await connector.commit("send_message", prepared.payload, {}, BOUND);
    assert.equal(result.state, "failed", code);
    assert.equal(result.errorCode, code);
    assert.match(result.message, /thread/, code);
  }
});

test("a channel, person or DM named by id, or by a link, resolves exactly", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "users.info": [ok(FIXTURES.lookupGabe)],
    "conversations.open": [ok(FIXTURES.dmOpen)],
    "chat.postMessage": [ok(FIXTURES.postedDm)],
  });
  const target = async (destination) => {
    const prepared = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(prepared.status, "ready", destination);
    return prepared.payload.target;
  };

  assert.deepEqual(await target("C0ENGBE01"), {
    kind: "channel",
    id: "C0ENGBE01",
    label: "#eng-backend",
  });
  assert.deepEqual(await target("G0LEADS01"), {
    kind: "channel",
    id: "G0LEADS01",
    label: "#leads",
  });
  assert.deepEqual(await target(ENG_MESSAGE), { kind: "channel", id: "C0ENG0001", label: "#eng" });
  assert.deepEqual(await target("U0GABE001"), {
    kind: "user",
    id: "U0GABE001",
    label: "Gabe Smith (@gabe)",
  });
  assert.deepEqual(slack.calls.at(-1), {
    method: "users.info",
    params: { user: "U0GABE001" },
    authorization: "Bearer xoxe.xoxp-1-test-access",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(slack.methods().includes("users.list"), false, "an id needs no directory");

  // Without im:read Slack won't say whose DM it is, and the card must name who
  // gets the message: a DM id is known once a Send opened it with that person.
  const unknownDm = await connector.prepare(
    "send_message",
    { destination: "D0GABE001", text: "hi" },
    BOUND
  );
  assert.equal(unknownDm.status, "needs_clarification");
  assert.match(unknownDm.message, /whose direct message D0GABE001 is/);

  const toGabe = await connector.prepare(
    "send_message",
    { destination: "U0GABE001", text: "hi" },
    BOUND
  );
  assert.equal((await connector.commit("send_message", toGabe.payload, {}, BOUND)).state, "sent");
  assert.equal(posts(slack)[0].params.channel, "D0GABE001");

  const dm = await target("D0GABE001");
  assert.deepEqual(dm, { kind: "dm", id: "D0GABE001", label: "Gabe Smith (@gabe)" });
  assert.deepEqual(await target(GABE_DM_MESSAGE), dm);
  const opens = slack.methods().filter((method) => method === "conversations.open").length;
  const prepared = await connector.prepare(
    "send_message",
    { destination: "D0GABE001", text: "again" },
    BOUND
  );
  assert.equal(prepared.preview.destinationLabel, "Gabe Smith (@gabe)");
  const sent = await connector.commit("send_message", prepared.payload, {}, BOUND);
  assert.equal(sent.state, "sent");
  assert.equal(posts(slack).at(-1).params.channel, "D0GABE001");
  assert.equal(
    slack.methods().filter((method) => method === "conversations.open").length,
    opens,
    "a known DM is posted to as is"
  );
});

test("a thread in another person's DM that a Send opened here is refused before any DM opens", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "users.info": [ok(FIXTURES.lookupGabe)],
    "conversations.open": [ok(FIXTURES.dmOpen)],
    "chat.postMessage": [ok(FIXTURES.postedDm)],
  });
  const toGabe = await connector.prepare(
    "send_message",
    { destination: "U0GABE001", text: "hi" },
    BOUND
  );
  await connector.commit("send_message", toGabe.payload, {}, BOUND);
  const opens = slack.methods().filter((method) => method === "conversations.open").length;

  const refused = await connector.prepare(
    "send_message",
    { destination: "@gstone", text: "hi", thread: GABE_DM_MESSAGE },
    BOUND
  );

  assert.equal(refused.status, "failed");
  assert.equal(refused.errorCode, "thread_mismatch");
  assert.equal(slack.methods().filter((method) => method === "conversations.open").length, opens);
});

test("a DM is known by its person only while the app that opened it runs", async () => {
  const script = {
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "users.info": [ok(FIXTURES.lookupGabe)],
    "conversations.open": [ok(FIXTURES.dmOpen)],
    "chat.postMessage": [ok(FIXTURES.postedDm)],
  };
  const first = await setupSlack(script);
  const toGabe = await first.connector.prepare(
    "send_message",
    { destination: "U0GABE001", text: "hi" },
    BOUND
  );
  await first.connector.commit("send_message", toGabe.payload, {}, BOUND);

  const restarted = await setupSlack(script);
  const asked = await restarted.connector.prepare(
    "send_message",
    { destination: "D0GABE001", text: "hi" },
    BOUND
  );
  assert.equal(asked.status, "needs_clarification");
});

test("an id or link that finds nothing asks", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
    "users.info": [slackError("user_not_found")],
  });
  for (const destination of [
    "C0NOPE001",
    "U0NOPE001",
    "https://acme-test.slack.com/archives/C0NOPE001/p1727200000123456",
    // Another workspace's channel isn't among the user's.
    "https://other-team.slack.com/archives/C0THEIRS1/p1727200000123456",
  ]) {
    const asked = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(asked.status, "needs_clarification", destination);
  }
  assert.equal(posts(slack).length, 0);
});

test("a channel link missing from a cut-off list is said to be possibly cut off", async () => {
  const { connector } = await setupSlack({
    "users.conversations": [
      ok({
        ok: true,
        channels: [FIXTURES.channels.channels[0]],
        response_metadata: { next_cursor: "more" },
      }),
    ],
    "users.list": [ok(FIXTURES.people)],
  });
  const found = await connector.prepare(
    "send_message",
    { destination: "C0ENG0001", text: "hi" },
    BOUND
  );
  assert.equal(found.status, "ready");
  // A link, and a bare id that matches no name either, say the same.
  for (const destination of ["https://acme-test.slack.com/archives/C0NOPE001", "C0NOPE001"]) {
    const missed = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(missed.status, "needs_clarification", destination);
    assert.match(missed.message, /more Slack channels than can be listed/, destination);
  }
});

test("a link to a conversation not shaped like a Slack id is no link", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });
  for (const destination of [
    "https://acme-test.slack.com/archives/D1/p1727200000123456",
    "https://acme-test.slack.com/archives/DESIGN",
  ]) {
    const prepared = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(prepared.status, "needs_clarification", destination);
  }
  assert.equal(posts(slack).length, 0);
});

test("a name that only looks like an id is still a name", async () => {
  const channel = (id, name) => ({ id, name, is_channel: true, is_archived: false });
  const { connector } = await setupSlack({
    "users.conversations": [
      ok({
        ok: true,
        channels: [
          channel("C0D2CTEAM", "d2c"),
          channel("C0DEVTWO1", "dev2"),
          channel("C0W3CSPEC", "w3c"),
          channel("C0DROIDS1", "c3po"),
          channel("C0DESIGN1", "design2025"),
          channel("C0CUSTOM1", "customers1"),
          channel("C0STOCKS1", "warehouse1"),
        ],
        response_metadata: { next_cursor: "" },
      }),
    ],
    "users.list": [ok(FIXTURES.people)],
    "users.info": [slackError("user_not_found")],
  });
  // Too short to be ids, or shaped like one but nobody's id: names either way.
  for (const [destination, label] of [
    ["GABE", "Gabe Smith (@gabe)"],
    ["D2C", "#d2c"],
    ["DEV2", "#dev2"],
    ["W3C", "#w3c"],
    ["C3PO", "#c3po"],
    ["DESIGN2025", "#design2025"],
    ["CUSTOMERS1", "#customers1"],
    ["WAREHOUSE1", "#warehouse1"],
  ]) {
    const prepared = await connector.prepare("send_message", { destination, text: "hi" }, BOUND);
    assert.equal(prepared.status, "ready", destination);
    assert.equal(prepared.preview.destinationLabel, label, destination);
  }
});

// The Slack window the agent hotkey was pressed over, as main hands it to prepare.
const pressedOver = (slackWindowTitle) => ({ ...BOUND, slackWindowTitle });

test("a post with no destination goes to the conversation the Slack window's title names", async () => {
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });
  const cases = [
    ["eng (Channel) - Acme Test - Slack", "#eng"],
    // As Slack's desktop app and Chrome title them.
    ["eng (Channel) - Acme Test - 28 new items - Slack", "#eng"],
    [
      "eng (Channel) - Acme Test - 28 new items - Slack - Google Chrome – Chad Test (acme.test)",
      "#eng",
    ],
    [
      "Gabe Smith, Gabriel Stone (DM) - Acme Test - 3 new items - Slack",
      "Gabe Smith (@gabe), Gabriel Stone (@gstone)",
    ],
    ["* eng-backend | Acme Test | Slack", "#eng-backend"],
    ["Slack | #leads | Acme Test", "#leads"],
    ["Gabe Smith (DM) - Acme Test - Slack - Google Chrome", "Gabe Smith (@gabe)"],
    [
      "Gabe Smith, Gabriel Stone - Acme Test - Slack",
      "Gabe Smith (@gabe), Gabriel Stone (@gstone)",
    ],
  ];
  for (const [title, label] of cases) {
    const prepared = await connector.prepare(
      "send_message",
      { text: "Ship it" },
      pressedOver(title)
    );
    assert.equal(prepared.status, "ready", title);
    assert.equal(prepared.preview.destinationLabel, label, title);
  }
});

test("a Slack window title that names no conversation, or more than one, asks where, without the title", async () => {
  const { connector, slack } = await setupSlack({
    ...channelsOnly,
    "users.list": [ok(FIXTURES.people)],
  });
  const ask = {
    status: "needs_clarification",
    message: "Ask the user which Slack channel or person to send this to.",
    candidates: [],
  };
  for (const title of [
    "Acme Test - Slack",
    "Threads - Acme Test - Slack",
    "eng - leads - Acme Test - Slack",
    // Slack can show another workspace, whose #eng isn't this one's.
    "eng (Channel) - OtherCo - Slack",
    "eng (Channel) - Slack",
    // Only an exact name counts: no loose match picks where a post goes.
    "Eng (Channel) - Acme Test - Slack",
    "en - Acme Test - Slack",
    // A browser's profile after the workspace is no conversation, even when it names someone.
    "Saved - Acme Test - Slack - Google Chrome – Chad Test (acme.test)",
    "Slack | Threads | Acme Test - Google Chrome – Chad Test (acme.test)",
  ]) {
    assert.deepEqual(
      await connector.prepare("send_message", { text: "Ship it" }, pressedOver(title)),
      ask,
      title
    );
  }
  slack.calls.length = 0;
  assert.deepEqual(await connector.prepare("send_message", { text: "Ship it" }, BOUND), ask);
  assert.deepEqual(slack.calls, [], "without a Slack window nothing is looked up");
});

test("a Slack window title whose name could be a channel the user isn't in never picks a person", async () => {
  const person = (id, name, displayName) => ({
    id,
    name,
    deleted: false,
    is_bot: false,
    profile: { real_name: "Dee Sign", display_name: displayName },
  });
  const { connector } = await setupSlack({
    ...channelsOnly,
    "users.list": [
      ok({
        ...FIXTURES.people,
        members: [...FIXTURES.people.members, person("U0DESIGN1", "design", "")],
      }),
    ],
  });
  // #design isn't among the user's channels, and @design is a person.
  const prepared = await connector.prepare(
    "send_message",
    { text: "Ship it" },
    pressedOver("design (Channel) - Acme Test - Slack")
  );
  assert.equal(prepared.status, "needs_clarification");
  // A name no channel can have still finds them.
  const byName = await connector.prepare(
    "send_message",
    { text: "Ship it" },
    pressedOver("Dee Sign (DM) - Acme Test - Slack")
  );
  assert.equal(byName.preview.destinationLabel, "Dee Sign (@design)");
});

test("a Slack window title asks where when Slack's lists were cut off", async () => {
  const endless = (key, items) => ({
    ok: true,
    [key]: items,
    response_metadata: { next_cursor: "more" },
  });
  const { connector } = await setupSlack({
    "users.conversations": [ok(endless("channels", FIXTURES.channels.channels))],
    "users.list": [ok(FIXTURES.people)],
  });
  const prepared = await connector.prepare(
    "send_message",
    { text: "Ship it" },
    pressedOver("eng (Channel) - Acme Test - Slack")
  );
  assert.equal(prepared.status, "needs_clarification");
});

test("a destination the model names wins over the open Slack window", async () => {
  const { connector } = await setupSlack(channelsOnly);
  const prepared = await connector.prepare(
    "send_message",
    { destination: "#leads", text: "Ship it" },
    pressedOver("eng (Channel) - Acme Test - Slack")
  );
  assert.equal(prepared.preview.destinationLabel, "#leads");
});
