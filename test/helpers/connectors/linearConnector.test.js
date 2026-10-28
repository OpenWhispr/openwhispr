const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NOW,
  FIXTURES,
  CONNECTED,
  BINDING,
  FakeFlowError,
  fakeLinearFetch,
  gql,
  gqlError,
  httpStatus,
  offline,
  reset,
  memoryCredentials,
} = require("./linearFixtures");

const GRAPHQL = "/graphql";
const TOKEN = "/oauth/token";
const BOUND = { binding: BINDING };
const CLIENT_UUID = "5b1c1e7e-6f0a-4d7e-9a53-0c8f2f7a1d11";
const ENG = { id: "team-eng", key: "ENG", name: "Engineering" };
const DES = { id: "team-des", key: "DES", name: "Design" };
const Q4 = { id: "proj-q4", name: "Q4 launch" };
const ISSUE_URL = "https://linear.app/acme/issue/ENG-123/login-fails-after-update";
// Links as main keeps them: without the title slug, which receipts must not hold.
const ISSUE_LINK = "https://linear.app/acme/issue/ENG-123";
const CREATED_LINK = "https://linear.app/acme/issue/ENG-431";
const TEAM_ISSUES = "https://linear.app/acme/team/ENG/all";
const ENG_123 = {
  id: "issue-123",
  identifier: "ENG-123",
  title: "Login fails after update",
  url: ISSUE_URL,
};
const CREATED = gql({
  issueCreate: {
    success: true,
    issue: {
      id: CLIENT_UUID,
      identifier: "ENG-431",
      url: "https://linear.app/acme/issue/ENG-431/crash-on-launch",
    },
  },
});
const FOUND_CREATED = gql({
  issue: {
    id: CLIENT_UUID,
    identifier: "ENG-431",
    title: "Crash on launch",
    url: "https://linear.app/acme/issue/ENG-431/crash-on-launch",
  },
});
const COMMENTED = gql({
  commentCreate: {
    success: true,
    comment: { id: "comment-1", url: `${ISSUE_URL}#comment-1` },
  },
});
const HTTP_401 = {
  status: 401,
  body: {
    errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }],
  },
};
const REFRESHED = { body: FIXTURES.refresh };
const LOGIN_GONE = {
  status: 400,
  body: { error: "invalid_grant", error_description: "synthetic" },
};
const OTHER_LOGIN = {
  ...CONNECTED,
  userId: "user-2",
  userName: "Sam",
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
const CRASH = { team: "ENG", title: "Crash on launch", description: "It crashes." };

// linearTeams behind its interface: named teams resolve by key
// or name, an omitted team resolves only in a one-team workspace, and a
// project not in the team is a question. `replies` answer resolveTeam first.
function stubTeams({ teams = [ENG, DES], projects = { "team-eng": [Q4] }, replies = [] } = {}) {
  const calls = [];
  const queue = [...replies];
  const describe = (team) => `${team.key} · ${team.name}`;
  return {
    calls,
    async list(_binding, token) {
      calls.push(["list", token]);
      return { ok: true, teams };
    },
    async resolveTeam(binding, token, input) {
      calls.push(["resolveTeam", binding, token, input ?? null]);
      if (queue.length > 0) return queue.shift();
      if (!input) {
        return teams.length === 1
          ? { ok: true, team: teams[0] }
          : {
              ok: false,
              clarification: {
                message: "Ask the user which Linear team to use.",
                candidates: teams.map(describe),
              },
            };
      }
      const wanted = input.toLowerCase();
      const team = teams.find(
        (candidate) =>
          candidate.key.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted
      );
      return team
        ? { ok: true, team }
        : {
            ok: false,
            clarification: {
              message: `No Linear team called "${input}". Ask the user which team.`,
              candidates: teams.map(describe),
            },
          };
    },
    async resolveProject(binding, token, teamId, input) {
      calls.push(["resolveProject", binding, token, teamId, input]);
      const project = (projects[teamId] ?? []).find(
        (candidate) => candidate.name.toLowerCase() === input.toLowerCase()
      );
      return project
        ? { ok: true, project }
        : {
            ok: false,
            clarification: {
              message: `No Linear project in this team matches "${input}".`,
              candidates: (projects[teamId] ?? []).map((candidate) => candidate.name),
            },
          };
    },
    clear() {},
  };
}

async function setupLinear(
  script = {},
  {
    credential = CONNECTED,
    configured = true,
    teams = stubTeams(),
    randomId = () => CLIENT_UUID,
  } = {}
) {
  const [connectorModule, { createLinearApi }, { createLinearAuth }] = await Promise.all([
    import("../../../src/helpers/connectors/linearConnector.js"),
    import("../../../src/helpers/connectors/linearApi.js"),
    import("../../../src/helpers/connectors/linearAuth.js"),
  ]);
  const linear = fakeLinearFetch(script);
  const api = createLinearApi({ fetchImpl: linear.fetchImpl, sleep: async () => {} });
  const credentials = memoryCredentials(credential, { connectorId: "linear" });
  const auth = createLinearAuth({
    api,
    credentials,
    getClientId: () => (configured ? "client-1" : null),
    OAuthFlowError: FakeFlowError,
    runOAuthLoopbackFlow: async () => {
      throw new Error("not used in these tests");
    },
    now: () => NOW,
  });
  const connector = connectorModule.createLinearConnector({
    api,
    auth,
    teams,
    credentials,
    randomId,
  });
  return { connector, linear, credentials, teams, ...connectorModule };
}

const ops = (linear, operation) => linear.calls.filter((call) => call.operation === operation);
const tokenCalls = (linear) => linear.calls.filter((call) => call.path === TOKEN);
const slot = (credentials) => credentials.read("acct-1", "linear").credential;

function issueNode(index, overrides = {}) {
  return {
    identifier: `ENG-${100 + index}`,
    title: `Issue ${index}`,
    url: `https://linear.app/acme/issue/ENG-${100 + index}/issue-${index}`,
    updatedAt: new Date(Date.UTC(2026, 8, 1 + index)).toISOString(),
    description: `Description ${index}`,
    state: { name: "In Progress" },
    assignee: { name: "Dana" },
    team: { key: "ENG" },
    labels: { nodes: [{ name: "bug" }] },
    ...overrides,
  };
}
const searchReply = (nodes, hasNextPage = false) =>
  gql({ searchIssues: { nodes, pageInfo: { hasNextPage } } });

async function prepareCrash(connector, args = {}) {
  const prepared = await connector.prepare("create_issue", { ...CRASH, ...args }, BOUND);
  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  return prepared;
}

test("Linear declares one query and two approval actions with their card fields", async () => {
  const { connector, MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_RESULTS, SNIPPET_LENGTH } =
    await setupLinear();
  assert.equal(connector.id, "linear");
  assert.deepEqual(connector.actions, {
    search_issues: { kind: "query" },
    create_issue: { kind: "approval", editable: { title: "line", body: "text" } },
    comment: { kind: "approval", editable: { body: "text" } },
  });
  assert.deepEqual(
    [MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_RESULTS, SNIPPET_LENGTH],
    [256, 65536, 10, 300]
  );
});

test("an issue reference is a key or a link to an issue in this workspace", async () => {
  const { parseIssueReference } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const accepted = [
    ["ENG-123", "ENG-123"],
    ["eng-123", "ENG-123"],
    ["  Eng-7 ", "ENG-7"],
    ["https://linear.app/acme/issue/ENG-123/login-fails-after-update", "ENG-123"],
    ["https://linear.app/acme/issue/eng-123", "ENG-123"],
    ["https://linear.app/acme/issue/ENG-123/slug?utm_source=slack#comment-9", "ENG-123"],
    ["https://linear.app/ACME/issue/ENG-123/slug", "ENG-123"],
    ["linear.app/acme/issue/ENG-123/slug", "ENG-123"],
  ];
  for (const [input, identifier] of accepted) {
    assert.deepEqual(parseIssueReference(input, "acme"), { ok: true, identifier }, input);
  }
  assert.deepEqual(parseIssueReference("https://linear.app/other/issue/ENG-123/slug", "acme"), {
    ok: false,
    errorCode: "wrong_workspace",
  });
  for (const input of [
    "123",
    "#123",
    "ENG-",
    "ENG-0",
    "ENG-12a",
    "ENG 123",
    "ENG-123 and ENG-124",
    "https://linear.app.evil.test/acme/issue/ENG-123",
    "https://evil.test/acme/issue/ENG-123",
    "http://linear.app/acme/issue/ENG-123",
    "https://linear.app/acme/project/q4-launch",
    "https://linear.app/acme/issue/",
    "",
    null,
    42,
  ]) {
    assert.deepEqual(
      parseIssueReference(input, "acme"),
      { ok: false, errorCode: "invalid_reference" },
      String(input)
    );
  }
});

test("search sends one filtered query and returns Linear's ten most relevant, newest first", async () => {
  // Linear's order is relevance; here the least relevant match is also the
  // newest, so a date sort before the cut would keep it.
  const nodes = Array.from({ length: 11 }, (_, index) => issueNode(index));
  const { connector, linear, teams } = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [searchReply(nodes)] },
  });

  const result = await connector.query(
    "search_issues",
    { query: "  login bug ", team: "eng", assignedToMe: true },
    BOUND
  );

  assert.equal(result.status, "ok");
  assert.equal(result.truncated, true, "an 11th match means more exist");
  assert.equal(result.items.length, 10);
  assert.deepEqual(
    result.items.map((item) => item.reference),
    [
      "ENG-109",
      "ENG-108",
      "ENG-107",
      "ENG-106",
      "ENG-105",
      "ENG-104",
      "ENG-103",
      "ENG-102",
      "ENG-101",
      "ENG-100",
    ],
    "the 11th by relevance (ENG-110) is the one cut, though it is the newest"
  );
  assert.deepEqual(result.items[0], {
    reference: "ENG-109",
    title: "Issue 9",
    state: "In Progress",
    url: "https://linear.app/acme/issue/ENG-109/issue-9",
    updatedAt: "2026-09-10T00:00:00.000Z",
    assignee: "Dana",
    team: "ENG",
    labels: ["bug"],
    snippet: "Description 9",
  });
  const [search] = ops(linear, "LinearSearchIssues");
  assert.deepEqual(search.variables, {
    term: "login bug",
    first: 11,
    filter: {
      team: { id: { eq: "team-eng" } },
      assignee: { isMe: { eq: true } },
      state: { type: { nin: ["completed", "canceled"] } },
    },
  });
  assert.equal(search.authorization, "Bearer access-1");
  assert.deepEqual(
    teams.calls.map((call) => call.slice(0, 1).concat(call.slice(2))),
    [["resolveTeam", "access-1", "eng"]]
  );
  assert.deepEqual(linear.operations(), ["LinearSearchIssues"], "the token was fresh");
});

test("search results cut titles and excerpts on whole characters and collapse whitespace", async () => {
  const longText = `${"😀".repeat(400)}`;
  const { connector } = await setupLinear({
    [GRAPHQL]: {
      LinearSearchIssues: [
        searchReply([
          issueNode(1, {
            title: `Title\nwith   breaks ${"x".repeat(300)}`,
            description: `First line\n\n\tsecond   line ${longText}`,
            assignee: null,
            state: null,
            labels: { nodes: [{ name: "auth" }, { name: null }, {}] },
          }),
          issueNode(2, { description: null }),
          { identifier: "ENG-999", title: "no url" },
        ]),
      ],
    },
  });

  const { items, truncated } = await connector.query("search_issues", { query: "x" }, BOUND);

  assert.equal(truncated, false);
  assert.equal(items.length, 2, "a result without a link is dropped");
  const [second, first] = items;
  assert.equal(second.reference, "ENG-102");
  assert.equal(second.snippet, "");
  assert.equal([...first.title].length, 256);
  assert.match(first.title, /^Title with breaks x+…$/);
  assert.equal([...first.snippet].length, 300);
  assert.match(first.snippet, /^First line second line (?:😀)+…$/u);
  assert.doesNotMatch(first.snippet, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no split emoji");
  assert.equal(first.assignee, null);
  assert.equal(first.state, null);
  assert.deepEqual(first.labels, ["auth"]);
  assert.equal("description" in first, false);
});

test("search: all states drops the state filter, Linear's next page marks the list as cut", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [searchReply([issueNode(1)], true)] },
  });

  const result = await connector.query("search_issues", { query: "login", state: "all" }, BOUND);

  assert.equal(result.truncated, true);
  assert.deepEqual(ops(linear, "LinearSearchIssues")[0].variables, { term: "login", first: 11 });
});

test("search refuses what it can't run, and asks which team, without searching", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [searchReply([])] },
  });

  assert.equal(
    (await connector.query("search_issues", { query: "  " }, BOUND)).status,
    "needs_clarification"
  );
  assert.equal(
    (await connector.query("search_issues", { query: "x".repeat(201) }, BOUND)).errorCode,
    "too_long"
  );
  assert.equal(
    (await connector.query("search_issues", { query: "x", state: "closed" }, BOUND)).errorCode,
    "invalid_input"
  );
  assert.equal(
    (await connector.query("search_issues", { query: "x", assignedToMe: "yes" }, BOUND)).errorCode,
    "invalid_input"
  );
  const unknownTeam = await connector.query("search_issues", { query: "x", team: "Ops" }, BOUND);
  assert.equal(unknownTeam.status, "needs_clarification");
  assert.deepEqual(unknownTeam.candidates, ["ENG · Engineering", "DES · Design"]);
  assert.deepEqual(linear.calls, []);
});

test("search: a refused token refreshes the same login once; refused again needs a reconnect", async () => {
  const once = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [HTTP_401, searchReply([issueNode(1)])] },
    [TOKEN]: [REFRESHED],
  });
  const found = await once.connector.query("search_issues", { query: "x" }, BOUND);
  assert.equal(found.status, "ok");
  assert.deepEqual(
    ops(once.linear, "LinearSearchIssues").map((call) => call.authorization),
    ["Bearer access-1", "Bearer access-2"]
  );

  const twice = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [gqlError("AUTHENTICATION_ERROR")] },
    [TOKEN]: [REFRESHED],
  });
  const refused = await twice.connector.query("search_issues", { query: "x" }, BOUND);
  assert.deepEqual([refused.status, refused.errorCode], ["failed", "reconnect_needed"]);
  assert.equal(slot(twice.credentials).needsReconnect, true);
  assert.equal(ops(twice.linear, "LinearSearchIssues").length, 2);
});

test("search: no network or a Linear outage fails with network", async () => {
  for (const reply of [offline(), httpStatus(503), reset()]) {
    const { connector } = await setupLinear({ [GRAPHQL]: { LinearSearchIssues: [reply] } });
    const result = await connector.query("search_issues", { query: "x" }, BOUND);
    assert.deepEqual([result.status, result.errorCode], ["failed", "network"]);
    assert.equal(typeof result.message, "string");
  }
});

test("prepare shows the issue the card will create, without calling Linear", async () => {
  const { connector, linear, teams } = await setupLinear();

  const prepared = await connector.prepare(
    "create_issue",
    {
      team: "Engineering",
      title: " Crash\r\non launch ",
      description: "Steps:\n1. Open the app",
      priority: "high",
      assignToMe: true,
      project: "q4 launch",
    },
    BOUND
  );

  assert.deepEqual(prepared, {
    status: "ready",
    payload: {
      id: CLIENT_UUID,
      teamId: "team-eng",
      teamKey: "ENG",
      title: "Crash on launch",
      description: "Steps:\n1. Open the app",
      priority: 2,
      assigneeId: "user-1",
      projectId: "proj-q4",
    },
    preview: {
      verbKey: "issue",
      destinationLabel: "ENG",
      accountLabel: "Dana",
      workspaceLabel: "Acme",
      body: "Steps:\n1. Open the app",
      fields: { title: "Crash on launch", body: "Steps:\n1. Open the app" },
      notes: [
        { key: "connectors.linear.notes.priority.high" },
        { key: "connectors.approval.issue.notes.assignee", values: { assignee: "Dana" } },
        { key: "connectors.approval.issue.notes.project", values: { project: "Q4 launch" } },
      ],
    },
  });
  assert.deepEqual(linear.calls, []);
  assert.deepEqual(
    teams.calls.map(([name, binding, token]) => [name, binding, token]),
    [
      ["resolveTeam", BINDING, "access-1"],
      ["resolveProject", BINDING, "access-1"],
    ]
  );
});

test("with no team named, one team is used and several are a question listing them", async () => {
  const single = await setupLinear({}, { teams: stubTeams({ teams: [ENG] }) });
  const used = await prepareCrash(single.connector, { team: undefined });
  assert.equal(used.preview.destinationLabel, "ENG");

  const several = await setupLinear();
  const asked = await several.connector.prepare(
    "create_issue",
    { ...CRASH, team: undefined },
    BOUND
  );
  assert.equal(asked.status, "needs_clarification");
  assert.deepEqual(asked.candidates, ["ENG · Engineering", "DES · Design"]);
});

test("a project that isn't in the team is a question listing the team's projects, never dropped", async () => {
  const { connector } = await setupLinear();

  const asked = await connector.prepare("create_issue", { ...CRASH, project: "Roadmap" }, BOUND);

  assert.deepEqual(asked, {
    status: "needs_clarification",
    message: 'No Linear project in this team matches "Roadmap".',
    candidates: ["Q4 launch"],
  });
});

test("assignToMe with no Linear name still shows an assignee note, and always sends the assigneeId with one", async () => {
  const { connector } = await setupLinear({}, { credential: { ...CONNECTED, userName: null } });

  const prepared = await prepareCrash(connector, { assignToMe: true });

  assert.equal(prepared.payload.assigneeId, "user-1");
  assert.deepEqual(prepared.preview.notes, [{ key: "connectors.linear.notes.assignedToYou" }]);
});

test("prepare refuses a title or description Linear can't take, before any lookup", async () => {
  const { connector, linear, teams } = await setupLinear();
  for (const [args, errorCode] of [
    [{ title: "  " }, "missing_title"],
    [{ title: "\r\n" }, "missing_title"],
    [{ title: "x".repeat(257) }, "too_long"],
    [{ description: "y".repeat(65537) }, "too_long"],
    [{ priority: "p1" }, "invalid_input"],
    [{ priority: "toString" }, "invalid_input"],
    [{ priority: "constructor" }, "invalid_input"],
    [{ priority: "__proto__" }, "invalid_input"],
  ]) {
    const prepared = await connector.prepare("create_issue", { ...CRASH, ...args }, BOUND);
    assert.deepEqual([prepared.status, prepared.errorCode], ["failed", errorCode], errorCode);
  }
  assert.equal((await prepareCrash(connector, { title: "x".repeat(256) })).status, "ready");
  assert.equal((await prepareCrash(connector, { description: "y".repeat(65536) })).status, "ready");
  assert.deepEqual(linear.calls, []);
  assert.equal(teams.calls.length, 2, "only the two that passed looked the team up");
});

test("lengths count characters as the card does, so a title of 256 emoji is ready", async () => {
  const { connector } = await setupLinear();
  assert.equal((await prepareCrash(connector, { title: "😀".repeat(256) })).status, "ready");
  const over = await connector.prepare(
    "create_issue",
    { ...CRASH, title: "😀".repeat(257) },
    BOUND
  );
  assert.deepEqual([over.status, over.errorCode], ["failed", "too_long"]);

  const prepared = await prepareCrash(connector);
  const { linear, connector: sending } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [CREATED] },
  });
  const sent = await sending.commit(
    "create_issue",
    prepared.payload,
    { title: "😀".repeat(256), body: "🧪".repeat(65536) },
    BOUND
  );
  assert.equal(sent.state, "sent", "the card allowed it, so Send does too");
  assert.equal(ops(linear, "LinearIssueCreate").length, 1);
});

test("an optional argument sent as null is left out, as if it weren't there", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearSearchIssues: [searchReply([issueNode(1)])] },
  });

  const prepared = await prepareCrash(connector, {
    description: null,
    priority: null,
    assignToMe: null,
    project: null,
  });
  assert.equal(prepared.payload.description, "");
  assert.equal("priority" in prepared.payload, false);
  assert.equal("assigneeId" in prepared.payload, false);
  assert.equal("projectId" in prepared.payload, false);
  assert.deepEqual(prepared.preview.notes, []);

  const found = await connector.query(
    "search_issues",
    { query: "login", team: null, assignedToMe: null, state: null },
    BOUND
  );
  assert.equal(found.status, "ok");
  assert.deepEqual(ops(linear, "LinearSearchIssues")[0].variables.filter, {
    state: { type: { nin: ["completed", "canceled"] } },
  });
});

test("links keep no title slug or query, and a link that isn't Linear's is never kept", async () => {
  const { connector } = await setupLinear({
    [GRAPHQL]: {
      LinearIssue: [
        gql({ issue: { ...ENG_123, url: `${ISSUE_URL}?utm_source=x` } }),
        gql({ issue: { ...ENG_123, url: "https://linear.example/acme/issue/ENG-123/x" } }),
      ],
    },
  });
  const kept = await connector.prepare("comment", { issue: "ENG-123", body: "hi" }, BOUND);
  assert.equal(kept.payload.issueUrl, ISSUE_LINK);

  const foreign = await connector.prepare("comment", { issue: "ENG-123", body: "hi" }, BOUND);
  assert.deepEqual([foreign.status, foreign.errorCode], ["failed", "refused"]);

  // A create whose answer links elsewhere isn't taken as sent: it is looked up.
  const create = await setupLinear({
    [GRAPHQL]: {
      LinearIssueCreate: [
        gql({
          issueCreate: {
            success: true,
            issue: {
              id: CLIENT_UUID,
              identifier: "ENG-431",
              url: "http://linear.app/acme/issue/ENG-431",
            },
          },
        }),
      ],
      LinearIssue: [FOUND_CREATED],
    },
  });
  const result = await create.connector.commit(
    "create_issue",
    (await prepareCrash(create.connector)).payload,
    {},
    BOUND
  );
  assert.deepEqual(result, { state: "sent", url: CREATED_LINK, resultLabel: "ENG-431" });
  assert.deepEqual(create.linear.operations(), ["LinearIssueCreate", "LinearIssue"]);
});

test("Send creates exactly the card's issue, with its client id, and reports the new key", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [CREATED] },
  });
  const prepared = await prepareCrash(connector, { priority: "none", assignToMe: true });

  const result = await connector.commit(
    "create_issue",
    { ...prepared.payload, stateId: "state-done", labelIds: ["label-1"] },
    {
      title: "Crash on launch (macOS)",
      body: "Edited on the card.",
      teamId: "team-des",
      assigneeId: "user-9",
      description: "not from the card",
    },
    BOUND
  );

  assert.deepEqual(result, {
    state: "sent",
    url: CREATED_LINK,
    resultLabel: "ENG-431",
  });
  const [create] = ops(linear, "LinearIssueCreate");
  assert.deepEqual(create.variables, {
    input: {
      id: CLIENT_UUID,
      teamId: "team-eng",
      title: "Crash on launch (macOS)",
      description: "Edited on the card.",
      priority: 0,
      assigneeId: "user-1",
    },
  });
  assert.equal(create.authorization, "Bearer access-1");
  assert.deepEqual(linear.operations(), ["LinearIssueCreate"]);
});

test("a write's client id is made once at prepare and reused by every attempt and its lookup", async () => {
  let made = 0;
  const randomId = () => `client-id-${(made += 1)}`;

  const create = await setupLinear(
    {
      [GRAPHQL]: { LinearIssueCreate: [HTTP_401, reset()], LinearIssue: [FOUND_CREATED] },
      [TOKEN]: [REFRESHED],
    },
    { randomId }
  );
  const prepared = await prepareCrash(create.connector);
  assert.equal(prepared.payload.id, "client-id-1");
  const created = await create.connector.commit("create_issue", prepared.payload, {}, BOUND);
  assert.equal(created.state, "sent");
  const creates = ops(create.linear, "LinearIssueCreate");
  assert.deepEqual(
    creates.map((call) => call.variables.input.id),
    ["client-id-1", "client-id-1"],
    "the retry after a refresh sends the same id"
  );
  assert.deepEqual(ops(create.linear, "LinearIssue")[0].variables, { id: "client-id-1" });

  const comment = await setupLinear(
    {
      [GRAPHQL]: {
        LinearIssue: [gql({ issue: ENG_123 })],
        LinearCommentCreate: [HTTP_401, reset()],
        LinearComment: [gql({ comment: { id: "c", url: `${ISSUE_URL}#comment-1` } })],
      },
      [TOKEN]: [REFRESHED],
    },
    { randomId }
  );
  const drafted = await comment.connector.prepare(
    "comment",
    { issue: "ENG-123", body: "hi" },
    BOUND
  );
  assert.equal(drafted.payload.id, "client-id-2");
  const posted = await comment.connector.commit("comment", drafted.payload, {}, BOUND);
  assert.equal(posted.state, "sent");
  assert.deepEqual(
    ops(comment.linear, "LinearCommentCreate").map((call) => call.variables.input.id),
    ["client-id-2", "client-id-2"]
  );
  assert.deepEqual(ops(comment.linear, "LinearComment")[0].variables, { id: "client-id-2" });
  assert.equal(made, 2, "one id per prepared write, none made at Send");
});

test("an edit that breaks a rule at Send is refused without calling Linear", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [CREATED] },
  });
  const prepared = await prepareCrash(connector);

  for (const [edits, errorCode] of [
    [{ title: "" }, "missing_title"],
    [{ title: "   " }, "missing_title"],
    [{ title: "Crash\nBcc" }, "invalid_input"],
    [{ title: "x".repeat(257) }, "too_long"],
    [{ body: "y".repeat(65537) }, "too_long"],
  ]) {
    const result = await connector.commit("create_issue", prepared.payload, edits, BOUND);
    assert.deepEqual([result.state, result.errorCode], ["failed", errorCode], errorCode);
    assert.equal(typeof result.message, "string");
  }
  assert.deepEqual(linear.calls, []);
});

test("an uncertain create found by its client id is sent, with its key", async () => {
  for (const uncertain of [
    httpStatus(503),
    reset(),
    gqlError("INTERNAL_SERVER_ERROR"),
    gql({ issueCreate: { success: true, issue: null } }),
    gqlError("INPUT_ERROR", { message: "conflict on insert of Issue" }),
  ]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: { LinearIssueCreate: [uncertain], LinearIssue: [FOUND_CREATED] },
    });
    const prepared = await prepareCrash(connector);

    const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

    assert.deepEqual(result, {
      state: "sent",
      url: CREATED_LINK,
      resultLabel: "ENG-431",
    });
    assert.deepEqual(linear.operations(), ["LinearIssueCreate", "LinearIssue"]);
    assert.deepEqual(ops(linear, "LinearIssue")[0].variables, { id: CLIENT_UUID });
  }
});

test("an uncertain create that Linear says doesn't exist failed: nothing was created", async () => {
  // The create's own uncertainty must be a completed 200 (an unlisted
  // GraphQL error), never a transport failure or a 5xx: only then does a
  // lookup miss prove nothing was created.
  for (const notThere of [
    gql({ issue: null }),
    gqlError("ENTITY_NOT_FOUND"),
    gqlError("INPUT_ERROR", { message: "Entity not found: Issue" }),
  ]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: {
        LinearIssueCreate: [gqlError("INTERNAL_SERVER_ERROR")],
        LinearIssue: [notThere],
      },
    });
    const prepared = await prepareCrash(connector);

    const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

    assert.deepEqual([result.state, result.errorCode], ["failed", "not_created"]);
    assert.equal(ops(linear, "LinearIssueCreate").length, 1, "never created again");
  }
});

test("an uncertain create after a timeout, reset or 5xx whose lookup finds nothing stays unknown", async () => {
  // Linear may still commit the insert later, so a miss after our own
  // uncertainty (not a completed answer) is never reported as not_created.
  for (const createReply of [httpStatus(502), reset(), httpStatus(503)]) {
    for (const lookup of [
      gql({ issue: null }),
      gqlError("INPUT_ERROR", { message: "Entity not found: Issue" }),
    ]) {
      const { connector, linear } = await setupLinear({
        [GRAPHQL]: { LinearIssueCreate: [createReply], LinearIssue: [lookup] },
      });
      const prepared = await prepareCrash(connector);

      const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

      assert.equal(result.state, "unknown");
      assert.equal(result.checkUrl, TEAM_ISSUES);
      assert.deepEqual(linear.operations(), ["LinearIssueCreate", "LinearIssue"]);
      assert.equal(ops(linear, "LinearIssueCreate").length, 1);
    }
  }
});

test("an uncertain create whose lookup is uncertain too stays unknown, pointing at the team's issues", async () => {
  for (const lookup of [httpStatus(503), reset(), offline(), gqlError("INTERNAL_SERVER_ERROR")]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: { LinearIssueCreate: [reset()], LinearIssue: [lookup] },
    });
    const prepared = await prepareCrash(connector);

    const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

    assert.equal(result.state, "unknown");
    assert.equal(result.checkUrl, TEAM_ISSUES);
    assert.deepEqual(linear.operations(), ["LinearIssueCreate", "LinearIssue"]);
  }
});

test("a listed refusal inside a 200 failed and isn't looked up", async () => {
  for (const [code, errorCode] of [
    ["INVALID_INPUT", "invalid_input"],
    ["FORBIDDEN", "forbidden"],
    ["ENTITY_NOT_FOUND", "not_found"],
    ["INPUT_ERROR", "invalid_input"],
  ]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: { LinearIssueCreate: [gqlError(code)] },
    });
    const prepared = await prepareCrash(connector);

    const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

    assert.deepEqual([result.state, result.errorCode], ["failed", errorCode], code);
    assert.deepEqual(linear.operations(), ["LinearIssueCreate"], code);
  }
});

test("a rate limit with a long wait fails with rate_limited, after one attempt", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [httpStatus(429, { "retry-after": "60" })] },
  });
  const prepared = await prepareCrash(connector);

  const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

  assert.deepEqual([result.state, result.errorCode], ["failed", "rate_limited"]);
  assert.equal(ops(linear, "LinearIssueCreate").length, 1);
});

test("a 401 refreshes the same login once and creates the same issue once more", async () => {
  const { connector, linear, credentials } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [HTTP_401, CREATED] },
    [TOKEN]: [REFRESHED],
  });
  const prepared = await prepareCrash(connector);

  const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

  assert.equal(result.state, "sent");
  const creates = ops(linear, "LinearIssueCreate");
  assert.deepEqual(
    creates.map((call) => call.authorization),
    ["Bearer access-1", "Bearer access-2"]
  );
  assert.deepEqual(creates[0].variables, creates[1].variables);
  assert.equal(tokenCalls(linear)[0].form.refresh_token, "refresh-1");
  assert.equal(slot(credentials).accessToken, "access-2");
  assert.equal(credentials.generation("acct-1", "linear"), 1, "pending cards stay valid");
});

test("an AUTHENTICATION_ERROR right after a refresh needs a reconnect, with two attempts in all", async () => {
  const { connector, linear, credentials } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [gqlError("AUTHENTICATION_ERROR")] },
    [TOKEN]: [REFRESHED],
  });
  const prepared = await prepareCrash(connector);

  const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

  assert.deepEqual([result.state, result.errorCode], ["failed", "reconnect_needed"]);
  assert.equal(slot(credentials).needsReconnect, true);
  assert.equal(ops(linear, "LinearIssueCreate").length, 2);
  assert.equal(ops(linear, "LinearIssue").length, 0, "a refusal is never looked up");
});

test("a 401 whose refresh Linear refuses needs a reconnect, after one attempt", async () => {
  const { connector, linear, credentials } = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [HTTP_401] },
    [TOKEN]: [LOGIN_GONE],
  });
  const prepared = await prepareCrash(connector);

  const result = await connector.commit("create_issue", prepared.payload, {}, BOUND);

  assert.equal(result.errorCode, "reconnect_needed");
  assert.equal(slot(credentials).needsReconnect, true);
  assert.equal(ops(linear, "LinearIssueCreate").length, 1);
});

test("a reconnect as another Linear user, or a disconnect, before Send sends nothing", async () => {
  const reconnected = await setupLinear({ [GRAPHQL]: { LinearIssueCreate: [CREATED] } });
  const first = await prepareCrash(reconnected.connector);
  reconnected.credentials.replace("acct-1", "linear", OTHER_LOGIN, 1);
  assert.deepEqual(await reconnected.connector.commit("create_issue", first.payload, {}, BOUND), {
    state: "failed",
    errorCode: "connection_changed",
    message: "The Linear connection changed before sending, so nothing was sent.",
  });
  assert.deepEqual(reconnected.linear.calls, []);

  const disconnected = await setupLinear({ [GRAPHQL]: { LinearIssueCreate: [CREATED] } });
  const second = await prepareCrash(disconnected.connector);
  disconnected.credentials.clear("acct-1", "linear", 1);
  const result = await disconnected.connector.commit("create_issue", second.payload, {}, BOUND);
  assert.equal(result.errorCode, "connection_changed");
  assert.deepEqual(disconnected.linear.calls, []);
});

test("a reconnect while refreshing after a 401 never creates as the new login", async () => {
  let credentials;
  const setup = await setupLinear({
    [GRAPHQL]: { LinearIssueCreate: [HTTP_401, CREATED] },
    [TOKEN]: [
      { ...REFRESHED, during: () => credentials.replace("acct-1", "linear", OTHER_LOGIN, 1) },
    ],
  });
  credentials = setup.credentials;
  const prepared = await prepareCrash(setup.connector);

  const result = await setup.connector.commit("create_issue", prepared.payload, {}, BOUND);

  assert.deepEqual([result.state, result.errorCode], ["failed", "connection_changed"]);
  assert.deepEqual(
    ops(setup.linear, "LinearIssueCreate").map((call) => call.authorization),
    ["Bearer access-1"]
  );
  assert.deepEqual(slot(credentials), OTHER_LOGIN, "nothing was written to the new login");
});

test("a comment card names the issue it goes on, from a key or a link", async () => {
  for (const issue of [
    "eng-123",
    "https://linear.app/acme/issue/ENG-123/login-fails-after-update?utm=1#comment-4",
  ]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: { LinearIssue: [gql({ issue: ENG_123 })] },
    });

    const prepared = await connector.prepare("comment", { issue, body: "Fixed in 1.9.1." }, BOUND);

    assert.deepEqual(prepared, {
      status: "ready",
      payload: {
        id: CLIENT_UUID,
        issueId: "issue-123",
        identifier: "ENG-123",
        issueUrl: ISSUE_LINK,
        body: "Fixed in 1.9.1.",
      },
      preview: {
        verbKey: "comment",
        destinationLabel: "ENG-123",
        accountLabel: "Dana",
        workspaceLabel: "Acme",
        body: "Fixed in 1.9.1.",
        fields: { body: "Fixed in 1.9.1." },
        notes: [
          {
            key: "connectors.approval.comment.notes.targetTitle",
            values: { title: "Login fails after update" },
          },
        ],
      },
    });
    assert.deepEqual(ops(linear, "LinearIssue")[0].variables, { id: "ENG-123" });
  }
});

test("a comment on another workspace's issue, or on something that isn't an issue, is refused before any call", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearIssue: [gql({ issue: ENG_123 })] },
  });
  for (const [issue, errorCode] of [
    ["https://linear.app/other/issue/ENG-123/login", "wrong_workspace"],
    ["123", "invalid_reference"],
    ["the login bug", "invalid_reference"],
  ]) {
    const prepared = await connector.prepare("comment", { issue, body: "hi" }, BOUND);
    assert.deepEqual([prepared.status, prepared.errorCode], ["failed", errorCode], issue);
  }
  for (const [body, errorCode] of [
    ["  ", "missing_body"],
    ["y".repeat(65537), "too_long"],
  ]) {
    const prepared = await connector.prepare("comment", { issue: "ENG-123", body }, BOUND);
    assert.deepEqual([prepared.status, prepared.errorCode], ["failed", errorCode], errorCode);
  }
  assert.deepEqual(linear.calls, []);
});

test("a comment on an issue Linear can't find asks which issue was meant", async () => {
  for (const reply of [
    gql({ issue: null }),
    gqlError("ENTITY_NOT_FOUND"),
    gqlError("INPUT_ERROR", { message: "Entity not found: Issue" }),
  ]) {
    const { connector } = await setupLinear({ [GRAPHQL]: { LinearIssue: [reply] } });
    const prepared = await connector.prepare("comment", { issue: "ENG-999", body: "hi" }, BOUND);
    assert.equal(prepared.status, "needs_clarification");
    assert.match(prepared.message, /ENG-999/);
  }
});

test("Send posts the card's comment once and links to it", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearIssue: [gql({ issue: ENG_123 })], LinearCommentCreate: [COMMENTED] },
  });
  const prepared = await connector.prepare("comment", { issue: "ENG-123", body: "Draft" }, BOUND);

  const result = await connector.commit(
    "comment",
    { ...prepared.payload, issueId: prepared.payload.issueId },
    { body: "Fixed in 1.9.1, edited.", issueId: "issue-999", id: "another-id" },
    BOUND
  );

  assert.deepEqual(result, { state: "sent", url: `${ISSUE_LINK}#comment-1` });
  assert.deepEqual(ops(linear, "LinearCommentCreate")[0].variables, {
    input: { id: CLIENT_UUID, issueId: "issue-123", body: "Fixed in 1.9.1, edited." },
  });
});

test("a comment prepared by key whose Linear issue.url carries a different workspace key still posts at Send", async () => {
  const renamedUrl = "https://linear.app/renamed/issue/ENG-123/login-fails-after-update";
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: {
      LinearIssue: [gql({ issue: { ...ENG_123, url: renamedUrl } })],
      LinearCommentCreate: [COMMENTED],
    },
  });
  const prepared = await connector.prepare("comment", { issue: "ENG-123", body: "hi" }, BOUND);
  assert.equal(
    prepared.payload.issueUrl,
    "https://linear.app/renamed/issue/ENG-123",
    "prepare stored Linear's own (renamed) link, without its slug"
  );

  const result = await connector.commit("comment", prepared.payload, {}, BOUND);

  assert.deepEqual(result, { state: "sent", url: `${ISSUE_LINK}#comment-1` });
  assert.deepEqual(ops(linear, "LinearCommentCreate")[0].variables, {
    input: { id: CLIENT_UUID, issueId: "issue-123", body: "hi" },
  });
});

test("an uncertain comment found by its client id is sent, and is never repeated", async () => {
  for (const reply of [httpStatus(503), reset(), gqlError("INTERNAL_SERVER_ERROR"), gql({})]) {
    const { connector, linear } = await setupLinear({
      [GRAPHQL]: {
        LinearIssue: [gql({ issue: ENG_123 })],
        LinearCommentCreate: [reply],
        LinearComment: [gql({ comment: { id: CLIENT_UUID, url: `${ISSUE_URL}#comment-1` } })],
      },
    });
    const prepared = await connector.prepare("comment", { issue: "ENG-123", body: "hi" }, BOUND);

    const result = await connector.commit("comment", prepared.payload, {}, BOUND);

    assert.deepEqual(result, { state: "sent", url: `${ISSUE_LINK}#comment-1` });
    assert.equal(ops(linear, "LinearCommentCreate").length, 1);
    assert.deepEqual(ops(linear, "LinearComment")[0].variables, { id: CLIENT_UUID });
  }
});

test("an uncertain comment its lookup doesn't find stays unknown, points at the issue, and is never repeated", async () => {
  // Unlike a create, even a completed answer's miss never reads as "not
  // posted": a comment's client id was never checked against a live workspace.
  for (const reply of [httpStatus(503), reset(), gqlError("INTERNAL_SERVER_ERROR"), gql({})]) {
    for (const lookup of [
      gqlError("INPUT_ERROR", { message: "Entity not found: Comment" }),
      gql({ comment: null }),
      httpStatus(503),
      reset(),
    ]) {
      const { connector, linear } = await setupLinear({
        [GRAPHQL]: {
          LinearIssue: [gql({ issue: ENG_123 })],
          LinearCommentCreate: [reply],
          LinearComment: [lookup],
        },
      });
      const prepared = await connector.prepare("comment", { issue: "ENG-123", body: "hi" }, BOUND);

      const result = await connector.commit("comment", prepared.payload, {}, BOUND);

      assert.equal(result.state, "unknown");
      assert.equal(result.checkUrl, ISSUE_LINK);
      assert.deepEqual(ops(linear, "LinearCommentCreate").length, 1);
      assert.equal(ops(linear, "LinearComment").length, 1);
    }
  }
});

test("a comment edited empty or too long is refused at Send, without calling Linear", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearCommentCreate: [COMMENTED] },
  });
  const payload = { issueId: "issue-123", identifier: "ENG-123", issueUrl: ISSUE_URL, body: "hi" };
  for (const [edits, errorCode] of [
    [{ body: " " }, "missing_body"],
    [{ body: "y".repeat(65537) }, "too_long"],
  ]) {
    const result = await connector.commit("comment", payload, edits, BOUND);
    assert.deepEqual([result.state, result.errorCode], ["failed", errorCode]);
  }
  assert.deepEqual(linear.calls, []);
});

test("a comment payload missing its issueId or identifier is refused at Send, without calling Linear", async () => {
  const { connector, linear } = await setupLinear({
    [GRAPHQL]: { LinearCommentCreate: [COMMENTED] },
  });
  const payload = { issueId: "issue-123", identifier: "ENG-123", issueUrl: ISSUE_URL, body: "hi" };
  for (const broken of [
    { ...payload, issueId: "" },
    { ...payload, issueId: null },
    { ...payload, identifier: "" },
    { ...payload, identifier: undefined },
  ]) {
    const result = await connector.commit("comment", broken, {}, BOUND);
    assert.deepEqual([result.state, result.errorCode], ["failed", "refused"]);
  }
  assert.deepEqual(linear.calls, []);
});

test("an unknown action is refused by query, prepare and commit", async () => {
  const { connector, linear } = await setupLinear();
  const refusal = { errorCode: "unknown_action", message: "Unknown Linear action." };
  assert.deepEqual(await connector.query("create_issue", CRASH, BOUND), {
    status: "failed",
    ...refusal,
  });
  assert.deepEqual(await connector.prepare("search_issues", CRASH, BOUND), {
    status: "failed",
    ...refusal,
  });
  assert.deepEqual(await connector.commit("delete_issue", {}, {}, BOUND), {
    state: "failed",
    ...refusal,
  });
  assert.deepEqual(linear.calls, []);
});

test("the binding and status follow the active account's Linear login", async () => {
  const { connector, credentials } = await setupLinear();
  assert.deepEqual(await connector.getBinding(), BINDING);
  assert.deepEqual(await connector.getStatus(), {
    connected: true,
    configured: true,
    accountLabel: "Dana",
    workspaceLabel: "Acme",
    needsReconnect: false,
  });

  credentials.replace("acct-1", "linear", OTHER_LOGIN, 1);
  assert.deepEqual(await connector.getBinding(), {
    ownerAccountId: "acct-1",
    accountId: "user-2",
    workspaceId: "org-1",
    generation: 2,
  });

  credentials.switchAccount("acct-2");
  assert.equal(await connector.getBinding(), null);
  assert.deepEqual(await connector.getStatus(), NOT_CONNECTED);
});

test("without a client id the row is hidden, unless a login is left to disconnect", async () => {
  const none = await setupLinear({}, { credential: null, configured: false });
  assert.deepEqual(await none.connector.getStatus(), { ...NOT_CONNECTED, configured: false });

  const leftover = await setupLinear({}, { configured: false });
  const status = await leftover.connector.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.configured, true);
});

test("a Linear login is the same account only for the same user in the same workspace", async () => {
  const { createLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const { loginKey } = createLinearConnector({
    api: null,
    auth: null,
    teams: null,
    credentials: null,
  });
  const login = { userId: "u-1", organizationId: "org-1" };
  assert.equal(loginKey(login), loginKey({ ...login, accessToken: "newer" }));
  assert.notEqual(loginKey(login), loginKey({ ...login, userId: "u-2" }));
  assert.notEqual(loginKey(login), loginKey({ ...login, organizationId: "org-2" }));
});

test("authorize and revoke go to Linear auth, and revoking forgets the cached teams", async () => {
  const { createLinearConnector } =
    await import("../../../src/helpers/connectors/linearConnector.js");
  const seen = [];
  const connector = createLinearConnector({
    api: null,
    credentials: null,
    teams: { clear: (...args) => seen.push(["clear", ...args]) },
    auth: {
      authorize: async (options) => seen.push(["authorize", options]),
      revoke: async (credential, options) => {
        seen.push(["revoke", credential, options]);
        throw new Error("Linear unreachable");
      },
    },
  });
  const controller = new AbortController();

  await connector.authorize({ signal: controller.signal });
  await assert.rejects(connector.revoke(CONNECTED, { erasingDevice: true }));

  assert.equal(seen[0][1].signal, controller.signal);
  assert.deepEqual(seen.slice(1), [["revoke", CONNECTED, { erasingDevice: true }], ["clear"]]);
});

test("after a disconnect, a new login lists its teams again instead of reusing the old ones", async () => {
  const [{ createLinearConnector }, { createLinearTeams }] = await Promise.all([
    import("../../../src/helpers/connectors/linearConnector.js"),
    import("../../../src/helpers/connectors/linearTeams.js"),
  ]);
  const listed = [];
  const api = {
    graphql: async (query, _variables, { token }) => {
      listed.push(token);
      return { ok: true, data: { teams: { nodes: [ENG], pageInfo: { hasNextPage: false } } } };
    },
  };
  const teams = createLinearTeams({ api, now: () => NOW });
  const connector = createLinearConnector({
    api,
    teams,
    credentials: null,
    auth: { revoke: async () => {} },
  });

  await teams.list(BINDING, "access-1");
  await teams.list(BINDING, "access-1");
  await connector.revoke(CONNECTED);
  await teams.list(BINDING, "access-1");

  assert.deepEqual(listed, ["access-1", "access-1"], "cached once, listed again after revoke");
});

test("a team lookup Linear refuses for its token refreshes the same login and asks once more", async () => {
  const teams = stubTeams({
    replies: [{ ok: false, outcome: "failed", errorCode: "unauthorized" }],
  });
  const { connector, linear } = await setupLinear({ [TOKEN]: [REFRESHED] }, { teams });

  const prepared = await prepareCrash(connector);

  assert.equal(prepared.preview.destinationLabel, "ENG");
  assert.deepEqual(
    teams.calls.map(([name, , token]) => [name, token]),
    [
      ["resolveTeam", "access-1"],
      ["resolveTeam", "access-2"],
    ]
  );
  assert.equal(tokenCalls(linear).length, 1);
});
