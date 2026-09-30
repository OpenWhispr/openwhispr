const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryCredentials } = require("./slackFixtures");

const load = () => import("../../../src/helpers/connectors/createConnectors.js");

function fakeDeps(overrides = {}) {
  return {
    fetch: async () => {
      throw new Error("no network in tests");
    },
    i18n: { t: (key) => `t:${key}` },
    runOAuthLoopbackFlow: async () => {
      throw new Error("no browser in tests");
    },
    OAuthFlowError: class OAuthFlowError extends Error {},
    renderOAuthResultPage: (page) => JSON.stringify(page),
    credentials: memoryCredentials(),
    logger: { info() {}, warn() {}, error() {} },
    env: {},
    openExternal: async () => {},
    writeClipboard: () => {},
    getGoogleCalendarAccounts: () => [],
    broadcast: () => {},
    ...overrides,
  };
}

test("every factory builds from the same deps, in list order", async () => {
  const { createConnectors } = await load();
  const deps = fakeDeps();
  const seen = [];
  const build = (id) => (received) => {
    seen.push(received);
    return { id, actions: {} };
  };

  const connectors = createConnectors(deps, [build("a"), build("b")]);

  assert.deepEqual(
    connectors.map((connector) => connector.id),
    ["a", "b"]
  );
  assert.ok(seen.every((received) => received === deps));
});

test("two connectors with one id is a build fault", async () => {
  const { createConnectors } = await load();
  const same = () => ({ id: "a", actions: {} });

  assert.throws(() => createConnectors(fakeDeps(), [same, same]), /connector id "a" is used twice/);
});

test("the shipped connectors are email, Slack, Gmail and Linear, built from the deps", async () => {
  const { createConnectors } = await load();

  const connectors = createConnectors(fakeDeps());
  assert.deepEqual(
    connectors.map((connector) => connector.id),
    ["email", "slack", "gmail", "linear"]
  );
});

// Gmail reads its Google client from deps.env lazily (a getter closure over
// deps.env, not a value captured when the connector is built), so a client
// id saved after startup takes effect without rebuilding the connector list.
// Built once, then mutating the SAME env object catches a build-time read
// that two separately-built connector lists (one per env object) would not.
test("Gmail reads its Google client from deps.env lazily, not at build time", async () => {
  const { createConnectors } = await load();
  const env = {};
  const connectors = createConnectors(fakeDeps({ env }));
  const gmail = connectors.find((connector) => connector.id === "gmail");

  assert.equal((await gmail.getStatus()).configured, false);

  env.GOOGLE_CALENDAR_CLIENT_ID = "client-id";
  env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";

  assert.equal((await gmail.getStatus()).configured, true);
});

// Slack's client id is read at sign-in, the same way: one saved after startup
// is used without rebuilding the connector list.
test("Slack reads its client id from deps.env lazily, not at build time", async () => {
  const { createConnectors } = await load();
  const env = {};
  const authUrls = [];
  const connectors = createConnectors(
    fakeDeps({
      env,
      runOAuthLoopbackFlow: async ({ buildAuthUrl }) => {
        authUrls.push(buildAuthUrl("http://127.0.0.1:1/slack/callback", "state", "challenge"));
        throw new Error("no browser in tests");
      },
    })
  );
  const slack = connectors.find((connector) => connector.id === "slack");

  await assert.rejects(slack.authorize(), { code: "not_configured" });
  assert.deepEqual(authUrls, [], "no browser opens without a client id");

  env.SLACK_CLIENT_ID = "slack-client";
  await assert.rejects(slack.authorize(), /no browser in tests/);
  assert.equal(new URL(authUrls[0]).searchParams.get("client_id"), "slack-client");
});

// Revoke must check the login's own issuing client, not today's
// GMAIL_CLIENT_ID: a stale login issued under an older Gmail client (or the
// calendar's client, from the pre-split flow) must still be checked against
// the calendar client under the project it was actually issued to — reading
// "today's" GMAIL_CLIENT_ID would wrongly conclude the grant isn't shared
// and revoke a still-shared calendar login.
test("Gmail's sharesGrant is called with the login's own client id, not deps.env's current Gmail client id", async () => {
  const { buildGmailConnector } = await import("../../../src/helpers/connectors/gmailConnector.js");
  const revokeCalls = [];
  const deps = fakeDeps({
    fetch: async (url) => {
      revokeCalls.push(url);
      return { status: 200, ok: true, json: async () => ({}) };
    },
    env: {
      // A *different* project than the login was issued under: if
      // sharesGrant read this instead of the credential's own clientId, the
      // shared-grant check would wrongly fail.
      GMAIL_CLIENT_ID: "111111111111-currentgmail.apps.googleusercontent.com",
      GMAIL_CLIENT_SECRET: "current-secret",
      GOOGLE_CALENDAR_CLIENT_ID: "999999999999-calendar.apps.googleusercontent.com",
      GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-secret",
    },
    getGoogleCalendarAccounts: () => [{ email: "user@example.com" }],
  });

  const gmail = buildGmailConnector(deps);
  const result = await gmail.revoke(
    {
      email: "user@example.com",
      refreshToken: "refresh-token",
      // Issued under the *same* project as the connected calendar.
      clientId: "999999999999-oldgmail.apps.googleusercontent.com",
    },
    {}
  );

  // sharesGrant found the grant shared (matching project + email), so
  // nothing was revoked over the network and the caller is told it kept it.
  assert.deepEqual(result, { kept: true });
  assert.deepEqual(revokeCalls, []);
});

// 0ef42cb3b: the shared-grant check reads the calendar accounts only once the
// login's project matches the calendar's, so a separate Gmail project never
// touches the calendar database (whose failure would otherwise read as
// "shared" and skip the revoke).
test("Gmail's sharesGrant reads the calendar accounts only once the Google projects match", async () => {
  const { buildGmailConnector } = await import("../../../src/helpers/connectors/gmailConnector.js");
  const revokeCalls = [];
  let calendarReads = 0;
  const deps = fakeDeps({
    fetch: async (url) => {
      revokeCalls.push(url);
      return { status: 200, ok: true, json: async () => ({}) };
    },
    env: {
      GOOGLE_CALENDAR_CLIENT_ID: "999999999999-calendar.apps.googleusercontent.com",
      GOOGLE_CALENDAR_CLIENT_SECRET: "calendar-secret",
    },
    getGoogleCalendarAccounts: () => {
      calendarReads += 1;
      return [{ email: "user@example.com" }];
    },
  });
  const gmail = buildGmailConnector(deps);

  // Issued under another project: revoked without reading the calendar.
  const separate = await gmail.revoke(
    {
      email: "user@example.com",
      refreshToken: "separate-token",
      clientId: "111111111111-gmail.apps.googleusercontent.com",
    },
    {}
  );
  assert.equal(separate, null);
  assert.equal(calendarReads, 0);
  assert.equal(revokeCalls.length, 1);

  // The calendar's project: read now, and the shared grant is kept.
  const shared = await gmail.revoke(
    {
      email: "user@example.com",
      refreshToken: "shared-token",
      clientId: "999999999999-gmail.apps.googleusercontent.com",
    },
    {}
  );
  assert.deepEqual(shared, { kept: true });
  assert.equal(calendarReads, 1);
  assert.equal(revokeCalls.length, 1);
});
