const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/agentCapabilities.ts");

const LOCATIONS = {
  account: "Settings → Profile",
  plans: "Settings → Plans & Billing",
  calendars: "Integrations → Calendars",
  connectors: "Integrations → Connectors",
  models: "Settings → Language Models",
};

const READY = { connected: true, configured: true, needsReconnect: false };

function input(overrides = {}) {
  return {
    supportsTools: true,
    isSignedIn: true,
    webSearch: { allowed: true, blockedByOrg: false },
    calendarConnected: true,
    connectors: {
      hasPlan: true,
      allowed: true,
      blockedByOrg: false,
      statuses: { slack: READY, linear: READY, github: READY },
    },
    locations: LOCATIONS,
    ...overrides,
  };
}

test("everything usable leaves nothing to name", async () => {
  const { resolveUnavailableCapabilities, describeUnavailable } = await load();
  const unavailable = resolveUnavailableCapabilities(input());
  assert.deepEqual(unavailable, []);
  assert.equal(describeUnavailable(unavailable), "");
});

test("a model too small for tools names that alone, with where to pick another", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const unavailable = resolveUnavailableCapabilities(
    input({ supportsTools: false, isSignedIn: false, calendarConnected: false })
  );
  assert.deepEqual(
    unavailable.map((item) => [item.name, item.reason, item.where]),
    [
      [
        "Tools (web search, calendar, searching or changing notes, integrations)",
        "modelTooSmall",
        LOCATIONS.models,
      ],
    ]
  );
});

test("a model too small for tools never promises integrations a surface doesn't offer", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const [entry] = resolveUnavailableCapabilities(
    input({ supportsTools: false, connectors: undefined })
  );
  assert.equal(entry.name, "Tools (web search, calendar, searching or changing notes)");
});

test("signed out, web search and connectors say to sign in", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const unavailable = resolveUnavailableCapabilities(input({ isSignedIn: false }));
  assert.deepEqual(
    unavailable.map((item) => [item.name.split(" ")[0], item.reason]),
    [
      ["Web", "signedOut"],
      ["Integrations", "signedOut"],
    ]
  );
});

test("web search off by the org reads as policy, while a loading policy is temporary", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const blocked = resolveUnavailableCapabilities(
    input({ webSearch: { allowed: false, blockedByOrg: true } })
  );
  const loading = resolveUnavailableCapabilities(
    input({ webSearch: { allowed: false, blockedByOrg: false } })
  );
  assert.equal(blocked[0].reason, "policyOff");
  assert.equal(loading[0].reason, "policyLoading");
});

test("connectors name the org, then the plan, then a loading policy, as one line", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const connectors = input().connectors;
  const reasonFor = (overrides) =>
    resolveUnavailableCapabilities(input({ connectors: { ...connectors, ...overrides } })).map(
      (item) => item.reason
    );

  // A free member of an org that turned connectors off isn't told to buy a plan.
  assert.deepEqual(reasonFor({ hasPlan: false, allowed: false, blockedByOrg: true }), [
    "policyOff",
  ]);
  assert.deepEqual(reasonFor({ hasPlan: false }), ["planRequired"]);
  assert.deepEqual(reasonFor({ allowed: false, blockedByOrg: true }), ["policyOff"]);
  assert.deepEqual(reasonFor({ allowed: false }), ["policyLoading"]);
});

test("each connector that isn't connected or needs a reconnect is named on its own", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const unavailable = resolveUnavailableCapabilities(
    input({
      calendarConnected: false,
      connectors: {
        ...input().connectors,
        statuses: {
          slack: { ...READY, connected: false },
          linear: { ...READY, needsReconnect: true },
          // A build without GitHub's client hides it, so it's never named.
          github: { ...READY, connected: false, configured: false },
          gmail: { ...READY, connected: false },
        },
      },
    })
  );
  assert.deepEqual(
    unavailable.map((item) => [item.name, item.reason, item.where]),
    [
      ["Calendar", "notConnected", LOCATIONS.calendars],
      ["Slack", "notConnected", LOCATIONS.connectors],
      ["Linear", "needsReconnect", LOCATIONS.connectors],
    ]
  );
});

test("a connector whose status hasn't loaded isn't reported as disconnected", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const unavailable = resolveUnavailableCapabilities(
    input({ connectors: { ...input().connectors, statuses: {} } })
  );
  assert.deepEqual(unavailable, []);
});

test("a surface without connectors never names them", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const unavailable = resolveUnavailableCapabilities(
    input({ isSignedIn: false, connectors: undefined })
  );
  assert.deepEqual(
    unavailable.map((item) => item.name),
    ["Web search"]
  );
});

test("every connector entry is one that sends for the user, and nothing else is", async () => {
  const { resolveUnavailableCapabilities } = await load();
  const signedOut = resolveUnavailableCapabilities(input({ isSignedIn: false }));
  assert.deepEqual(
    signedOut.map((item) => [item.name, item.delivers === true]),
    [
      ["Web search", false],
      ["Integrations (Email, Slack, Linear, GitHub)", true],
    ]
  );
  const notConnected = resolveUnavailableCapabilities(
    input({
      connectors: {
        ...input().connectors,
        statuses: { ...input().connectors.statuses, slack: { ...READY, connected: false } },
      },
    })
  );
  assert.deepEqual(
    notConnected.map((item) => [item.name, item.delivers]),
    [["Slack", true]]
  );
});

test("the description tells the model to explain how to enable each one", async () => {
  const { describeUnavailable } = await load();
  const text = describeUnavailable([
    { name: "Web search", reason: "signedOut", where: LOCATIONS.account },
    { name: "Calendar", reason: "notConnected", where: LOCATIONS.calendars },
  ]);
  assert.match(text, /tell them how to enable it instead of attempting it/);
  assert.match(
    text,
    /^- Web search: needs the user to sign in to OpenWhispr in Settings → Profile\.$/m
  );
  assert.match(
    text,
    /^- Calendar: not connected; the user can connect it in Integrations → Calendars\.$/m
  );
  assert.doesNotMatch(text, /still write it in full/);
});

test("a connector that can't send still gets the text written, with a pitch at the end", async () => {
  const { describeUnavailable } = await load();
  const text = describeUnavailable([
    { name: "Web search", reason: "signedOut", where: LOCATIONS.account },
    { name: "Slack", reason: "notConnected", where: LOCATIONS.connectors, delivers: true },
    { name: "Integrations", reason: "policyOff", delivers: true },
  ]);
  const [general, delivering] = text.split("\n\n");
  assert.match(general, /^- Web search: needs the user to sign in/m);
  assert.doesNotMatch(general, /Slack|Integrations/);
  assert.match(
    delivering,
    /still write it in full in your reply, then end with one short sentence/
  );
  assert.match(delivering, /leave that sentence out when only their admin can turn it on/);
  assert.doesNotMatch(delivering, /instead of attempting it/);
  assert.match(
    delivering,
    /^- Slack: not connected; the user can connect it in Integrations → Connectors\.$/m
  );
  assert.match(delivering, /^- Integrations: turned off by the user's organization/m);
});

test("a model too small for tools may still use the prompt's notes and write text", async () => {
  const { describeUnavailable } = await load();
  const text = describeUnavailable([
    { name: "Tools (web search)", reason: "modelTooSmall", where: LOCATIONS.models },
  ]);
  assert.match(text, /can still use anything already in this prompt, such as note text/);
  assert.match(text, /write any text the user asks for/);
});
