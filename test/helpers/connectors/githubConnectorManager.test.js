const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONNECTED,
  fakeGithubFetch,
  hang,
  json,
  oauthError,
  memoryCredentials,
} = require("./githubFixtures");

const INSTALLATIONS = "GET /user/installations";
const REPOSITORIES = "GET /user/installations/7/repositories";
const CREATE = "POST /repos/acme/api/issues";
const TOKEN = "POST /login/oauth/access_token";
const ALLOWED = { policyState: "allowed", accountId: "acct-1" };
const INSTALL_URL = "https://github.com/apps/openwhispr-dev/installations/new";
const ENV = { GITHUB_APP_CLIENT_ID: "Iv1.test-client", GITHUB_APP_SLUG: "openwhispr-dev" };
const silentLogger = { info() {}, warn() {}, error() {} };
const INSTALLED = {
  [INSTALLATIONS]: [json({ total_count: 1, installations: [{ id: 7 }] })],
  [REPOSITORIES]: [
    json({
      total_count: 1,
      repositories: [
        {
          name: "api",
          full_name: "acme/api",
          owner: { login: "acme" },
          private: true,
          updated_at: "2026-09-27T10:00:00Z",
        },
      ],
    }),
  ],
};
const CREATED = json({ number: 212, html_url: "https://github.com/acme/api/issues/212" }, 201);
const ISSUE = { repo: "acme/api", title: "Login times out", body: "After 30 s." };
const OTHER_LOGIN = { ...CONNECTED, userId: 43, login: "sam", accessToken: "ghu-other" };

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

// The connector exactly as main builds it (buildGithubConnector), driven
// through the real manager.
async function setup({ script = {}, credential = CONNECTED, env = ENV, others = [] } = {}) {
  const [{ createConnectorManager }, { createPendingActions }, { buildGithubConnector }] =
    await Promise.all([
      import("../../../src/helpers/connectors/connectorManager.js"),
      import("../../../src/helpers/connectors/pendingActions.js"),
      import("../../../src/helpers/connectors/githubConnector.js"),
    ]);
  const github = fakeGithubFetch({ ...INSTALLED, ...script });
  const credentials = memoryCredentials(credential, { connectorId: "github" });
  const broadcasts = [];
  const statusBroadcasts = [];
  let manager = null;
  const connector = buildGithubConnector({
    fetch: github.fetchImpl,
    credentials,
    env,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    logger: silentLogger,
    notifyStatusChanged: () => void manager?.notifyStatusChanged(),
  });
  const log = fakeLog();
  manager = createConnectorManager({
    connectors: [...others, connector],
    pendingActions: createPendingActions(),
    actionLog: log,
    logger: silentLogger,
    getAccountId: () => credentials.activeAccountId(),
    credentials,
    onStatusChanged: (statuses) => statusBroadcasts.push(statuses),
  });
  return { manager, connector, github, credentials, log, broadcasts, statusBroadcasts };
}

const hits = (github, key) => github.calls.filter((call) => `${call.method} ${call.path}` === key);

// The connector with a real api, installations and token handling, driven
// through the real manager, but with the sign-in and the token revoke
// recorded: GitHub's own endpoints for those are githubAuth's to test.
async function setupRevokes({ signsIn }) {
  const [
    { createConnectorManager },
    { createPendingActions },
    { createGithubConnector },
    { createGithubApi },
    { createGithubAuth },
    { createGithubInstallations },
  ] = await Promise.all([
    import("../../../src/helpers/connectors/connectorManager.js"),
    import("../../../src/helpers/connectors/pendingActions.js"),
    import("../../../src/helpers/connectors/githubConnector.js"),
    import("../../../src/helpers/connectors/githubApi.js"),
    import("../../../src/helpers/connectors/githubAuth.js"),
    import("../../../src/helpers/connectors/githubInstallations.js"),
  ]);
  const api = createGithubApi({ fetchImpl: fakeGithubFetch(INSTALLED).fetchImpl });
  const credentials = memoryCredentials(CONNECTED, { connectorId: "github" });
  const revoked = [];
  const auth = {
    ...createGithubAuth({ api, credentials, getClientId: () => ENV.GITHUB_APP_CLIENT_ID }),
    authorize: async () => signsIn,
    revoke: async (credential) => {
      revoked.push(credential);
    },
  };
  const connector = createGithubConnector({
    api,
    auth,
    installations: createGithubInstallations({ api }),
    credentials,
    getSlug: () => ENV.GITHUB_APP_SLUG,
  });
  const manager = createConnectorManager({
    connectors: [connector],
    pendingActions: createPendingActions(),
    actionLog: fakeLog(),
    logger: silentLogger,
    getAccountId: () => credentials.activeAccountId(),
    credentials,
    onStatusChanged: () => {},
  });
  return { manager, credentials, revoked };
}

test("buildGithubConnector reads the client id and App slug from the environment when asked", async () => {
  const env = {};
  const { connector, manager } = await setup({ credential: null, env });

  assert.equal(connector.id, "github");
  assert.equal((await connector.getStatus()).configured, false);
  // process.env is read lazily, so a value set after startup still counts.
  Object.assign(env, ENV);
  const [status] = await manager.status();
  assert.equal(status.configured, true);
  assert.equal(status.manageUrl, INSTALL_URL);
});

test("the status through the manager keeps the GitHub manage link, and the repository count arrives as a status change", async () => {
  const { manager, github, statusBroadcasts } = await setup();
  const status = {
    id: "github",
    connected: true,
    configured: true,
    accountLabel: "@dana",
    workspaceLabel: null,
    needsReconnect: false,
    manageUrl: INSTALL_URL,
  };

  assert.deepEqual(await manager.status(), [{ ...status, workspaceLabelPending: true }]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(statusBroadcasts.at(-1), [{ ...status, workspaceLabel: "1" }]);
  // Every request went through the fetch main passes in, with GitHub's headers.
  assert.equal(hits(github, INSTALLATIONS)[0].authorization, "Bearer ghu-1");
});

test("another connector's status never waits on a GitHub repository read", async () => {
  const slack = {
    id: "slack",
    actions: {},
    // Only a literal true passes, so no other status gains the field.
    getStatus: async () => ({ connected: true, accountLabel: "chad", workspaceLabelPending: 1 }),
    getBinding: async () => null,
  };
  const { manager } = await setup({ script: { [INSTALLATIONS]: [hang()] }, others: [slack] });

  const started = Date.now();
  const statuses = await manager.status();

  assert.ok(Date.now() - started < 500, `${Date.now() - started} ms`);
  assert.deepEqual(
    statuses.map((status) => [status.id, status.connected, status.workspaceLabelPending]),
    [
      ["slack", true, undefined],
      ["github", true, true],
    ]
  );
  assert.equal("workspaceLabelPending" in statuses[0], false);
});

test("Send creates exactly the card's edited issue, and the receipt holds the repo only", async () => {
  const { manager, github, log } = await setup({ script: { [CREATE]: [CREATED] } });

  const prepared = await manager.prepare("github", "create_issue", ISSUE, ALLOWED);
  assert.equal(prepared.status, "ready");
  const sent = await manager.commit(
    prepared.actionId,
    { title: "Login times out after 30 s", body: "Edited.", labels: ["smuggled"] },
    ALLOWED
  );

  assert.equal(sent.state, "sent");
  assert.equal(sent.url, "https://github.com/acme/api/issues/212");
  assert.deepEqual(hits(github, CREATE)[0].json, {
    title: "Login times out after 30 s",
    body: "Edited.",
  });
  const [row] = log.rows.values();
  assert.equal(row.destinationLabel, "acme/api");
  assert.doesNotMatch(JSON.stringify([...log.rows.values()]), /Login times out|Edited/);
});

test("a title edited to two lines is refused before anything reaches GitHub", async () => {
  const { manager, github } = await setup({ script: { [CREATE]: [CREATED] } });
  const prepared = await manager.prepare("github", "create_issue", ISSUE, ALLOWED);

  assert.deepEqual(await manager.commit(prepared.actionId, { title: "Two\nlines" }, ALLOWED), {
    state: "not_sent",
    reason: "invalid_edit",
  });
  assert.equal(hits(github, CREATE).length, 0);
});

test("a card never sends after an OpenWhispr account switch or a GitHub reconnect", async () => {
  const switched = await setup({ script: { [CREATE]: [CREATED] } });
  const first = await switched.manager.prepare("github", "create_issue", ISSUE, ALLOWED);
  switched.credentials.switchAccount("acct-2");
  const refused = await switched.manager.commit(
    first.actionId,
    {},
    { ...ALLOWED, accountId: "acct-2" }
  );
  assert.deepEqual(refused, { state: "not_sent", reason: "account_changed" });
  assert.equal(hits(switched.github, CREATE).length, 0);

  const reconnected = await setup({ script: { [CREATE]: [CREATED] } });
  const second = await reconnected.manager.prepare("github", "create_issue", ISSUE, ALLOWED);
  reconnected.credentials.replace("acct-1", "github", OTHER_LOGIN, 1);
  assert.deepEqual(await reconnected.manager.commit(second.actionId, {}, ALLOWED), {
    state: "not_sent",
    reason: "connection_changed",
  });
  assert.equal(hits(reconnected.github, CREATE).length, 0);
});

test("createConnectors registers GitHub once, built from the shared deps", async () => {
  const { createConnectors } = await import("../../../src/helpers/connectors/createConnectors.js");
  const github = fakeGithubFetch(INSTALLED);
  const deps = {
    fetch: github.fetchImpl,
    i18n: { t: (key) => key },
    runOAuthLoopbackFlow: async () => {
      throw new Error("not used in this test");
    },
    OAuthFlowError: Error,
    renderOAuthResultPage: () => "",
    credentials: memoryCredentials(CONNECTED, { connectorId: "github" }),
    logger: silentLogger,
    env: ENV,
    openExternal: () => {},
    writeClipboard: () => {},
    getGoogleCalendarAccounts: () => [],
    broadcast: () => {},
  };

  const connectors = createConnectors(deps);

  const githubConnectors = connectors.filter((connector) => connector.id === "github");
  assert.equal(githubConnectors.length, 1);
  assert.deepEqual(Object.keys(githubConnectors[0].actions), [
    "search_issues",
    "create_issue",
    "comment",
  ]);
  await githubConnectors[0].getStatus();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = await githubConnectors[0].getStatus();
  assert.equal(status.workspaceLabel, "1");
  assert.equal(status.manageUrl, INSTALL_URL);
  assert.ok(github.calls.length > 0);
});

test("a status read whose token refresh GitHub refuses announces that the login needs reconnecting", async () => {
  const { manager, github, credentials, statusBroadcasts } = await setup({
    script: { [TOKEN]: [oauthError("bad_refresh_token")] },
    credential: { ...CONNECTED, expiresAt: Date.now() - 1000 },
  });

  const [first] = await manager.status();
  assert.equal(first.needsReconnect, false);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(hits(github, TOKEN).length, 1);
  assert.equal(credentials.read("acct-1", "github").credential.needsReconnect, true);
  // Without the announcement Settings would keep saying connected, with no
  // Reconnect, and the tools would stay offered.
  assert.equal(statusBroadcasts.at(-1)?.[0].needsReconnect, true);
});

test("Disconnect deletes the GitHub login without revoking it", async () => {
  const { manager, credentials, revoked } = await setupRevokes({ signsIn: null });

  assert.deepEqual(await manager.disconnect("github"), { status: "disconnected" });

  // GitHub's revoke emails the user as if a token had leaked.
  assert.deepEqual(revoked, []);
  assert.equal(credentials.read("acct-1", "github"), null);
});

test("reconnecting GitHub replaces the login without revoking the old one", async () => {
  const renewed = { ...CONNECTED, accessToken: "ghu-9", refreshToken: "ghr-9" };
  const { manager, credentials, revoked } = await setupRevokes({ signsIn: renewed });

  assert.equal((await manager.connect("github", "allowed")).status, "connected");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(revoked, []);
  assert.deepEqual(credentials.read("acct-1", "github").credential, renewed);
});

test("account deletion and Reset app data revoke the GitHub login", async () => {
  for (const removeAll of [
    (manager) => manager.disconnectAll({ erasingDevice: false }),
    (manager) => manager.revokeAllStored(),
  ]) {
    const { manager, revoked } = await setupRevokes({ signsIn: null });

    await removeAll(manager);

    assert.deepEqual(revoked, [CONNECTED]);
  }
});
