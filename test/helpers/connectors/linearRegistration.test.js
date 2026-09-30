const test = require("node:test");
const assert = require("node:assert/strict");
const { CONNECTED, FakeFlowError, memoryCredentials } = require("./linearFixtures");

const silentLogger = { info() {}, warn() {}, error() {} };
const NO_RESULTS = { data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false } } } };

// The deps main.js passes to createConnectors (foundation spec §9.3).
function connectorDeps(overrides = {}) {
  const fetched = [];
  const flows = [];
  const deps = {
    fetch: async (url, init) => {
      fetched.push({ url, authorization: init.headers.Authorization ?? null });
      return new Response(JSON.stringify(NO_RESULTS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    i18n: { t: (key) => `t:${key}` },
    runOAuthLoopbackFlow: (options) => {
      flows.push(options);
      // The browser round trip never finishes in these tests.
      return new Promise(() => {});
    },
    OAuthFlowError: FakeFlowError,
    credentials: memoryCredentials(null, { connectorId: "linear" }),
    logger: silentLogger,
    env: {},
    openExternal: async () => {},
    writeClipboard: () => {},
    getGoogleCalendarAccounts: () => [],
    broadcast: () => {},
    ...overrides,
  };
  return { deps, fetched, flows };
}

test("buildLinearConnector reads the client id at each use, not once at startup", async () => {
  const { buildLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const { deps } = connectorDeps();
  const connector = buildLinearConnector(deps);

  assert.equal(connector.id, "linear");
  assert.equal((await connector.getStatus()).configured, false);
  deps.env.LINEAR_CLIENT_ID = "client-1";
  assert.equal((await connector.getStatus()).configured, true);
});

test("buildLinearConnector signs in through the loopback flow and ends on Linear's own page", async () => {
  const { buildLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const { deps, flows } = connectorDeps({ env: { LINEAR_CLIENT_ID: "client-1" } });
  const connector = buildLinearConnector(deps);

  void connector.authorize({ signal: new AbortController().signal });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(flows.length, 1);
  assert.equal(flows[0].errorParam, "linear_error");
  const authUrl = new URL(flows[0].buildAuthUrl("http://127.0.0.1:5000/linear/callback", "s", "c"));
  assert.equal(authUrl.searchParams.get("client_id"), "client-1");
  // main.js passes no page renderer, so this is the shared result page.
  const connected = flows[0].renderResultPage({ ok: true });
  const failed = flows[0].renderResultPage({ ok: false });
  assert.match(connected, /data-ok="true"/);
  assert.match(connected, /t:connectors\.linear\.browser\.connectedTitle/);
  assert.match(connected, /t:connectors\.linear\.browser\.connectedBody/);
  assert.match(failed, /data-ok="false"/);
  assert.match(failed, /t:connectors\.linear\.browser\.failedTitle/);
  assert.match(failed, /t:connectors\.linear\.browser\.failedBody/);
});

test("buildLinearConnector sends Linear's requests through the shared fetch", async () => {
  const { buildLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const { deps, fetched } = connectorDeps({
    env: { LINEAR_CLIENT_ID: "client-1" },
    credentials: memoryCredentials(CONNECTED, { connectorId: "linear" }),
  });
  const connector = buildLinearConnector(deps);

  const result = await connector.query(
    "search_issues",
    { query: "login", state: "all" },
    { binding: await connector.getBinding() }
  );

  assert.deepEqual(result, { status: "ok", items: [], truncated: false });
  assert.deepEqual(fetched, [
    { url: "https://api.linear.app/graphql", authorization: "Bearer access-1" },
  ]);
});

test("createConnectors builds Linear once, just before GitHub, from the shared deps", async () => {
  const { createConnectors } = await import("../../../src/helpers/connectors/createConnectors.js");
  const { deps } = connectorDeps();

  const ids = createConnectors(deps).map((connector) => connector.id);

  assert.deepEqual(ids.slice(-2), ["linear", "github"]);
  assert.equal(ids.filter((id) => id === "linear").length, 1);
});
