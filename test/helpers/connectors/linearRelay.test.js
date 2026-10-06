const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const {
  FIXTURES,
  FakeFlowError,
  fakeLinearFetch,
  gql,
  memoryCredentials,
} = require("./linearFixtures");

const RELAY = "https://openwhispr.com/auth/linear/callback";
const silentLogger = { info() {}, warn() {}, error() {} };

// The real loopback flow, with Electron's shell replaced so opening the
// browser only records the authorize URL.
function loadLoopback(opened) {
  const paths = [
    "../../../src/helpers/oauthLoopbackFlow.js",
    "../../../src/helpers/externalUrlOpener.js",
  ].map((file) => require.resolve(file));
  for (const path of paths) delete require.cache[path];
  const originalLoad = Module._load;
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") return { shell: { openExternal: async (url) => opened.push(url) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(paths[0]);
  } finally {
    Module._load = originalLoad;
  }
}

function connectorDeps(overrides = {}) {
  return {
    fetch: async () => {
      throw new Error("no request expected");
    },
    i18n: { t: (key) => key },
    runOAuthLoopbackFlow: () => new Promise(() => {}),
    OAuthFlowError: FakeFlowError,
    credentials: memoryCredentials(null, { connectorId: "linear" }),
    logger: silentLogger,
    env: { LINEAR_CLIENT_ID: "client-1" },
    openExternal: async () => {},
    writeClipboard: () => {},
    getGoogleCalendarAccounts: () => [],
    broadcast: () => {},
    ...overrides,
  };
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

test("the relay URL is openwhispr.com's, and only an https override replaces it", async () => {
  const { linearRedirectUri, LINEAR_RELAY_REDIRECT_URI } =
    await import("../../../src/helpers/connectors/linearAuth.js");
  assert.equal(LINEAR_RELAY_REDIRECT_URI, RELAY);
  assert.equal(linearRedirectUri({}), RELAY);
  assert.equal(linearRedirectUri(undefined), RELAY);
  assert.equal(
    linearRedirectUri({
      LINEAR_OAUTH_REDIRECT_URI: "https://preview.openwhispr.test/auth/linear/callback",
    }),
    "https://preview.openwhispr.test/auth/linear/callback"
  );
  for (const override of ["http://openwhispr.test/auth/linear/callback", "not a url", ""]) {
    assert.equal(linearRedirectUri({ LINEAR_OAUTH_REDIRECT_URI: override }), RELAY, override);
  }
});

test("Connect sends Linear to the relay, and the loopback server still answers on /linear/callback", async () => {
  const { buildLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const flows = [];
  const connector = buildLinearConnector(
    connectorDeps({
      runOAuthLoopbackFlow: (options) => {
        flows.push(options);
        return new Promise(() => {});
      },
    })
  );

  void connector.authorize({ signal: new AbortController().signal });
  await until(() => flows.length);

  assert.equal(flows[0].publicRedirectUri, RELAY);
  assert.equal(flows[0].callbackPath, "/linear/callback");
  const state = `v1.50123.${"a".repeat(64)}`;
  const authUrl = new URL(flows[0].buildAuthUrl(RELAY, state, "challenge-1"));
  assert.equal(authUrl.searchParams.get("redirect_uri"), RELAY);
  assert.equal(authUrl.searchParams.get("state"), state);
});

test("a sign-in forwarded by the relay reaches the loopback server and exchanges with the relay's URL", async (t) => {
  const [{ buildLinearConnector }] = await Promise.all([
    import("../../../src/helpers/connectors/linearConnector.js"),
  ]);
  const opened = [];
  const { runOAuthLoopbackFlow } = loadLoopback(opened);
  const linear = fakeLinearFetch({
    "/oauth/token": [{ body: FIXTURES.exchange }],
    "/graphql": { LinearIdentity: [gql(FIXTURES.identity)] },
  });
  const connector = buildLinearConnector(
    connectorDeps({ fetch: linear.fetchImpl, runOAuthLoopbackFlow })
  );

  // Closes the loopback server if an assertion stops the test early.
  const controller = new AbortController();
  t.after(() => controller.abort());
  const signedIn = connector.authorize({ signal: controller.signal });
  signedIn.catch(() => {});
  const authUrl = new URL(await until(() => opened[0]));
  assert.equal(authUrl.searchParams.get("redirect_uri"), RELAY);
  const state = authUrl.searchParams.get("state");
  const [, port] = /^v1\.(\d+)\.[0-9a-f]{64}$/.exec(state) ?? [];
  assert.ok(port, "state carries the loopback port for the relay");

  // What app/auth/linear/callback/route.ts does with Linear's redirect.
  const page = await get(
    `http://127.0.0.1:${port}/linear/callback?code=code-1&state=${encodeURIComponent(state)}`
  );

  assert.match(page.body, /data-ok="true"/);
  assert.match(page.body, /connectors\.linear\.browser\.connectedTitle/);
  const credential = await signedIn;
  assert.equal(credential.userId, "user-1");
  assert.equal(credential.organizationUrlKey, "acme");
  const exchange = linear.calls.find((call) => call.path === "/oauth/token");
  assert.equal(exchange.form.redirect_uri, RELAY);
  assert.equal(exchange.form.code, "code-1");
  assert.equal("client_secret" in exchange.form, false);
});
