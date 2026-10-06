const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const loadTools = () => import("../../src/services/tools/connectors/githubTools.ts");
const loadModules = () => import("../../src/services/tools/connectors/connectorToolModules.ts");
const loadApprovals = () => import("../../src/stores/connectorApprovalStore.ts");
const loadStatus = () => import("../../src/stores/connectorStatusStore.ts");
const loadScope = () => import("../../src/components/chat/toolExecutionScope.ts");
const loadRegistry = () => import("../../src/services/tools/ToolRegistry.ts");
// Tool-step text is localized; the UI language otherwise follows the machine's locale.
// (tsx loads its ESM default export through CommonJS interop.)
const useEnglish = async () => {
  const mod = await import("../../src/i18n.ts");
  await (mod.default.default ?? mod.default).changeLanguage("en");
};

const GITHUB = {
  id: "github",
  connected: true,
  configured: true,
  accountLabel: "@dana",
  workspaceLabel: "2",
  needsReconnect: false,
  manageUrl: "https://github.com/apps/openwhispr-dev/installations/new",
};

// A fresh turn: counts delivery holds, and caps cards like a real chat send.
async function turn() {
  const { createToolExecutionScope } = await loadScope();
  const holds = { count: 0 };
  const scope = createToolExecutionScope({ onHoldDelivery: () => (holds.count += 1) });
  let next = 0;
  return {
    holds,
    context: () => scope.createContext({ messageId: "m1", toolCallId: `call-${++next}` }),
  };
}

async function setGithubStatus(t, status = GITHUB) {
  const { useConnectorStatusStore } = await loadStatus();
  useConnectorStatusStore.setState({ statuses: status ? { github: status } : {}, loaded: true });
  t.after(() => useConnectorStatusStore.setState({ statuses: {}, loaded: false }));
}

async function resetApprovals() {
  const approvals = await loadApprovals();
  approvals.useConnectorApprovalStore.setState({ entries: {} });
  return approvals;
}

// Waits for the tool's card to appear in the approval store.
async function cardFor(approvals, toolCallId) {
  const key = approvals.approvalKey("m1", toolCallId);
  while (!approvals.useConnectorApprovalStore.getState().entries[key]) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return key;
}

const ISSUE_PREVIEW = {
  verbKey: "issue",
  destinationLabel: "acme/api",
  accountLabel: "@dana",
  body: "Steps to reproduce",
  fields: { title: "Login times out", body: "Steps to reproduce" },
};

test("the GitHub module registers three GitHub tools, only while GitHub is ready", async () => {
  const [
    { githubToolModule },
    { CONNECTOR_TOOL_MODULES, registerConnectorTools },
    { ToolRegistry },
  ] = await Promise.all([loadTools(), loadModules(), loadRegistry()]);
  assert.ok(CONNECTOR_TOOL_MODULES.includes(githubToolModule));
  assert.equal(githubToolModule.connectorId, "github");
  assert.equal(githubToolModule.requiresConnection, true);

  const tools = githubToolModule.createTools({ emailDraftTarget: "gmail" });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["github_search_issues", "github_create_issue", "github_comment"]
  );
  for (const tool of tools) {
    assert.equal(tool.connectorId, "github", tool.name);
    assert.equal(typeof tool.promptInstruction, "string", tool.name);
    assert.match(tool.promptInstruction, new RegExp(tool.name));
  }
  assert.deepEqual(
    tools.map((tool) => tool.readOnly),
    [true, false, false]
  );

  const names = (readyConnectorIds) => {
    const registry = new ToolRegistry();
    registerConnectorTools(registry, { emailDraftTarget: "gmail", readyConnectorIds });
    return registry.getAll().map((tool) => tool.name);
  };
  assert.ok(names(["github"]).includes("github_comment"));
  assert.equal(names(["slack"]).includes("github_search_issues"), false);
});

test("github_search_issues searches through the query path with its defaults", async (t) => {
  const queries = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async (...args) => {
          queries.push(args);
          return {
            status: "ok",
            items: [{ reference: "acme/api#45", title: "Timeout on login", state: "open" }],
            truncated: false,
          };
        },
      },
    },
  });
  await setGithubStatus(t);
  const { githubSearchIssuesTool } = await loadTools();
  const { context, holds } = await turn();

  // Models often send null for an argument they leave out.
  const result = await githubSearchIssuesTool.execute(
    { query: "  timeout  ", state: null, type: null },
    context()
  );
  // Other people's text shapes the answer, so a voice turn keeps it in the
  // panel rather than pasting it at the caret.
  assert.equal(holds.count, 1);
  await githubSearchIssuesTool.execute(
    { query: "flaky", repo: " acme/api ", state: "all", type: "pr" },
    context()
  );

  assert.deepEqual(queries, [
    ["github", "search_issues", { query: "timeout", state: "open", type: "any" }],
    ["github", "search_issues", { query: "flaky", repo: "acme/api", state: "all", type: "pr" }],
  ]);
  assert.equal(result.data.status, "ok");
  assert.equal(result.data.source, "github");
  assert.equal(result.data.untrusted, true);
  assert.equal(result.data.items[0].reference, "acme/api#45");
});

test("a state or type outside the list is refused, never swapped for the default", async (t) => {
  await useEnglish();
  let queried = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorQuery: async () => (queried += 1) } },
  });
  await setGithubStatus(t);
  const { githubSearchIssuesTool } = await loadTools();
  const { context, holds } = await turn();

  // "closed" used to become open-only: the model would read open issues as
  // the closed ones it asked for.
  const closed = await githubSearchIssuesTool.execute(
    { query: "timeout", state: "closed" },
    context()
  );
  const bug = await githubSearchIssuesTool.execute({ query: "timeout", type: "bug" }, context());

  assert.equal(closed.data.status, "failed");
  assert.equal(closed.data.errorCode, "invalid_input");
  assert.match(closed.data.error, /"all", which includes closed and merged/);
  assert.match(closed.data.error, /is:closed/);
  assert.equal(bug.data.status, "failed");
  assert.equal(bug.data.errorCode, "invalid_input");
  assert.match(bug.data.error, /"issue", "pr" or "any"/);
  // GitHub was never asked, so the tool step doesn't say GitHub refused it.
  assert.equal(closed.displayText, "That didn't work on GitHub.");
  assert.equal(bug.displayText, "That didn't work on GitHub.");
  assert.equal(queried, 0);
  assert.equal(holds.count, 2);
});

test("an empty or over-long search never reaches main", async (t) => {
  let queried = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorQuery: async () => (queried += 1) } },
  });
  await setGithubStatus(t);
  const { githubSearchIssuesTool } = await loadTools();
  const { context } = await turn();

  const empty = await githubSearchIssuesTool.execute({ query: "   " }, context());
  const long = await githubSearchIssuesTool.execute({ query: "x".repeat(201) }, context());

  assert.equal(empty.data.status, "needs_clarification");
  assert.equal(long.data.status, "failed");
  assert.equal(long.data.errorCode, "too_long");
  assert.equal(queried, 0);
});

test("a login GitHub no longer accepts reads as unavailable, with GitHub's reconnect advice", async (t) => {
  await useEnglish();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async () => ({
          status: "failed",
          errorCode: "reconnect_needed",
          message: "Reconnect GitHub.",
        }),
      },
    },
  });
  await setGithubStatus(t);
  const { githubSearchIssuesTool, GITHUB_RECONNECT_GUIDANCE } = await loadTools();
  const { context } = await turn();

  const result = await githubSearchIssuesTool.execute({ query: "timeout" }, context());

  assert.deepEqual(result.data, {
    status: "unavailable",
    reason: "reconnect_needed",
    guidance: GITHUB_RECONNECT_GUIDANCE,
  });
  assert.equal(result.displayText, "GitHub needs to be reconnected.");
});

test("a login already marked for reconnecting is refused before any IPC", async (t) => {
  let calls = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async () => (calls += 1),
        connectorPrepare: async () => (calls += 1),
      },
    },
  });
  await setGithubStatus(t, { ...GITHUB, needsReconnect: true });
  const { githubSearchIssuesTool, githubCreateIssueTool, githubCommentTool } = await loadTools();
  const { context, holds } = await turn();

  const results = [
    await githubSearchIssuesTool.execute({ query: "timeout" }, context()),
    await githubCreateIssueTool.execute({ title: "Bug" }, context()),
    await githubCommentTool.execute({ target: "acme/api#4", body: "Same here" }, context()),
  ];

  assert.deepEqual(
    results.map((result) => [result.data.status, result.data.reason]),
    [
      ["unavailable", "reconnect_needed"],
      ["unavailable", "reconnect_needed"],
      ["unavailable", "reconnect_needed"],
    ]
  );
  assert.equal(calls, 0);
  assert.equal(holds.count, 3, "every GitHub tool still keeps the turn in the panel");
});

test("no chosen repositories: the model is sent to Settings with the install page", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async () => ({
          status: "failed",
          errorCode: "no_repositories",
          message: "No repositories are installed.",
        }),
      },
    },
  });
  await setGithubStatus(t, { ...GITHUB, workspaceLabel: "0" });
  const { githubSearchIssuesTool } = await loadTools();
  const { context } = await turn();

  const result = await githubSearchIssuesTool.execute({ query: "timeout" }, context());

  assert.equal(result.data.status, "failed");
  assert.equal(result.data.errorCode, "no_repositories");
  assert.match(result.data.guidance, /choose repositories/);
  assert.equal(result.data.installUrl, GITHUB.manageUrl);
});

test("a repository the App isn't on names the fix; without an App slug there's no link", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "failed",
          errorCode: "not_installed",
          message: "Install the OpenWhispr GitHub App on acme/secret.",
        }),
      },
    },
  });
  await setGithubStatus(t, { ...GITHUB, manageUrl: undefined });
  const { githubCreateIssueTool } = await loadTools();
  const { context } = await turn();

  const result = await githubCreateIssueTool.execute(
    { repo: "acme/secret", title: "Bug" },
    context()
  );

  assert.equal(result.data.errorCode, "not_installed");
  assert.match(result.data.error, /acme\/secret/);
  assert.match(result.data.guidance, /install the OpenWhispr GitHub App/);
  assert.equal("installUrl" in result.data, false);
});

test("a repository main may not have seen all of is a name to check, not an install", async (t) => {
  await useEnglish();
  // Keyed on the code alone: main's wording can change freely.
  const answers = [
    { errorCode: "repo_unlisted", message: "acme/api wasn't in the repositories read." },
    { errorCode: "not_installed", message: "Not installed. Ask the user to check the name." },
  ];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({ status: "failed", ...answers.shift() }),
      },
    },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context } = await turn();

  const unlisted = await githubCreateIssueTool.execute(
    { repo: "acme/api", title: "Bug" },
    context()
  );
  const missing = await githubCreateIssueTool.execute(
    { repo: "acme/api", title: "Bug" },
    context()
  );

  assert.equal(unlisted.data.errorCode, "repo_unlisted");
  assert.match(unlisted.data.guidance, /couldn't read every repository/);
  assert.match(unlisted.data.guidance, /check the repository name/);
  assert.equal("installUrl" in unlisted.data, false);
  assert.equal(
    unlisted.displayText,
    "Couldn't confirm the OpenWhispr GitHub App is installed there."
  );
  assert.match(missing.data.guidance, /install the OpenWhispr GitHub App/);
  assert.equal(missing.data.installUrl, GITHUB.manageUrl);
});

test("github_create_issue prepares a card with one-line title, body and labels", async (t) => {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (...args) => {
          prepared.push(args);
          return { status: "ready", actionId: "a1", preview: ISSUE_PREVIEW };
        },
        connectorCommit: async () => ({
          state: "sent",
          url: "https://github.com/acme/api/issues/212",
          resultLabel: "acme/api#212",
        }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool }, approvals] = await Promise.all([loadTools(), resetApprovals()]);
  const { context, holds } = await turn();

  const pending = githubCreateIssueTool.execute(
    {
      repo: " acme/api ",
      title: " Login times out\n on Safari ",
      body: "Steps to reproduce",
      labels: ["bug", "auth"],
    },
    context()
  );
  await approvals.approveAction(await cardFor(approvals, "call-1"));
  const result = await pending;

  assert.deepEqual(prepared, [
    [
      "github",
      "create_issue",
      {
        repo: "acme/api",
        title: "Login times out on Safari",
        body: "Steps to reproduce",
        labels: ["bug", "auth"],
      },
    ],
  ]);
  assert.equal(result.data.status, "sent");
  assert.equal(result.data.url, "https://github.com/acme/api/issues/212");
  assert.equal(holds.count, 1);
});

test("github_create_issue takes a single label given as a string", async (t) => {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (...args) => {
          prepared.push(args[2]);
          return { status: "failed", errorCode: "invalid", message: "stop here" };
        },
      },
    },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context } = await turn();

  await githubCreateIssueTool.execute({ title: "Bug", labels: "bug" }, context());
  await githubCreateIssueTool.execute({ title: "Bug", labels: null, body: null }, context());

  assert.deepEqual(
    prepared.map((args) => [args.labels, args.body]),
    [
      [["bug"], ""],
      [undefined, ""],
    ]
  );
});

test("a description or label that isn't text is refused, never dropped", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorPrepare: async () => (prepared += 1) } },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context, holds } = await turn();

  const results = [
    // The card would open with an empty description.
    await githubCreateIssueTool.execute({ title: "Bug", body: { text: "Steps" } }, context()),
    await githubCreateIssueTool.execute({ title: "Bug", body: 42 }, context()),
    // The issue would be filed without a label that was asked for.
    await githubCreateIssueTool.execute({ title: "Bug", labels: ["bug", 7] }, context()),
    await githubCreateIssueTool.execute({ title: "Bug", labels: 7 }, context()),
  ];

  assert.deepEqual(
    results.map((result) => [result.data.status, result.data.errorCode]),
    Array(4).fill(["failed", "invalid_input"])
  );
  assert.match(results[0].data.error, /body is the description, as Markdown text/);
  assert.match(results[2].data.error, /labels is a list of existing label names/);
  assert.equal(prepared, 0);
  assert.equal(holds.count, 4);
});

test("a repo that isn't text is refused, never widened to every repository", async (t) => {
  let asked = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorQuery: async () => (asked += 1),
        connectorPrepare: async () => (asked += 1),
      },
    },
  });
  await setGithubStatus(t);
  const { githubSearchIssuesTool, githubCreateIssueTool } = await loadTools();
  const { context } = await turn();

  const results = [
    await githubSearchIssuesTool.execute({ query: "timeout", repo: ["acme/api"] }, context()),
    await githubCreateIssueTool.execute({ title: "Bug", repo: { name: "acme/api" } }, context()),
  ];

  for (const result of results) {
    assert.equal(result.data.status, "failed");
    assert.equal(result.data.errorCode, "invalid_input");
    assert.match(result.data.error, /repo is owner\/name or a repository name, as text/);
  }
  assert.equal(asked, 0);
});

test("the GitHub tools tell the model their limits and short targets", async () => {
  const { githubSearchIssuesTool, githubCreateIssueTool, githubCommentTool } = await loadTools();
  const describe = (tool, name) => tool.parameters.properties[name].description;

  assert.match(describe(githubSearchIssuesTool, "query"), /200 characters/);
  assert.match(describe(githubSearchIssuesTool, "state"), /all, which includes closed and merged/);
  assert.match(describe(githubCreateIssueTool, "title"), /256 characters/);
  assert.match(describe(githubCreateIssueTool, "body"), /65,536 characters/);
  assert.match(describe(githubCreateIssueTool, "labels"), /10 at most/);
  // Main refuses more (too_many_labels).
  assert.equal(githubCreateIssueTool.parameters.properties.labels.maxItems, 10);
  assert.match(describe(githubCommentTool, "body"), /65,536 characters/);
  assert.match(describe(githubCommentTool, "target"), /repo#12, #12/);
  assert.match(githubCreateIssueTool.promptInstruction, /one call per issue/);
  assert.match(githubCommentTool.promptInstruction, /repo#12 and #12/);
});

test("github_create_issue without a repo leaves the choice to main, and passes its question on", async (t) => {
  const prepared = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (...args) => {
          prepared.push(args);
          return {
            status: "needs_clarification",
            message: "Which repository? Ask the user.",
            candidates: ["acme/api", "acme/web"],
          };
        },
      },
    },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context, holds } = await turn();

  const result = await githubCreateIssueTool.execute({ title: "Bug", repo: "  " }, context());

  assert.deepEqual(prepared, [["github", "create_issue", { title: "Bug", body: "" }]]);
  assert.equal(result.data.status, "needs_clarification");
  assert.deepEqual(result.data.candidates, ["acme/api", "acme/web"]);
  assert.equal(holds.count, 1, "the question stays in the panel");
});

test("github_create_issue checks its title and description before any IPC", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorPrepare: async () => (prepared += 1) } },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context, holds } = await turn();

  const results = [
    await githubCreateIssueTool.execute({ title: " \n " }, context()),
    await githubCreateIssueTool.execute({ title: "x".repeat(257) }, context()),
    await githubCreateIssueTool.execute({ title: "Bug", body: "x".repeat(65537) }, context()),
  ];

  assert.deepEqual(
    results.map((result) => [result.data.status, result.data.errorCode]),
    [
      ["needs_clarification", undefined],
      ["failed", "too_long"],
      ["failed", "too_long"],
    ]
  );
  assert.equal(prepared, 0);
  assert.equal(holds.count, 3);
});

test("github_comment accepts owner/repo#12, repo#12, #12 and github.com issue or PR links only", async (t) => {
  const targets = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (_connector, _action, args) => {
          targets.push(args.target);
          return { status: "failed", errorCode: "not_found", message: "Not found." };
        },
      },
    },
  });
  await setGithubStatus(t);
  const { githubCommentTool } = await loadTools();
  const { context, holds } = await turn();
  const accepted = [
    "acme/api#12",
    "api#12",
    "#12",
    "https://github.com/acme/api/issues/12",
    "https://github.com/acme/api/pull/12",
    "https://github.com/acme/api/pull/12/files?diff=split#r1",
    // Main reads the scheme and host case-insensitively, as `new URL` does.
    "HTTPS://GitHub.COM/acme/api/issues/12",
  ];
  const refused = [
    "#",
    "api#",
    "acme/api",
    "acme/api#",
    "/api#12",
    "acme/api/x#12",
    "acme/api#12#3",
    "ENG-12",
    "http://github.com/acme/api/issues/12",
    "https://github.com.evil.test/acme/api/issues/12",
    "https://github.com/acme/api/commit/12",
    // The path is compared as given.
    "https://github.com/acme/api/Issues/12",
    "https://gitlab.com/acme/api/issues/12",
  ];

  for (const target of accepted) {
    const result = await githubCommentTool.execute(
      { target: ` ${target} `, body: "+1" },
      context()
    );
    assert.equal(result.data.errorCode, "not_found", target);
  }
  for (const target of refused) {
    const result = await githubCommentTool.execute({ target, body: "+1" }, context());
    assert.equal(result.data.errorCode, "invalid_reference", target);
  }

  assert.deepEqual(targets, accepted);
  assert.equal(holds.count, accepted.length + refused.length);
});

test("github_comment asks for a body rather than posting an empty comment", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorPrepare: async () => (prepared += 1) } },
  });
  await setGithubStatus(t);
  const { githubCommentTool } = await loadTools();
  const { context } = await turn();

  const empty = await githubCommentTool.execute({ target: "acme/api#4", body: "  " }, context());
  const long = await githubCommentTool.execute(
    { target: "acme/api#4", body: "x".repeat(65537) },
    context()
  );

  assert.equal(empty.data.status, "needs_clarification");
  assert.equal(long.data.errorCode, "too_long");
  assert.equal(prepared, 0);
});

test("create and comment hold delivery on every outcome", async (t) => {
  // Made on demand, so the rejection is always awaited.
  const answers = [
    () => Promise.reject(new Error("IPC gone")),
    async () => ({ status: "failed", errorCode: "locked", message: "Locked." }),
    async () => ({ status: "unavailable", reason: "policy_blocked" }),
    async () => ({ status: "ready", actionId: "a1", preview: ISSUE_PREVIEW }),
    async () => ({ status: "ready", actionId: "a2", preview: ISSUE_PREVIEW }),
  ];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: () => answers.shift()(),
        connectorCommit: async () => ({
          state: "unknown",
          checkUrl: "https://github.com/acme/api/issues",
        }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool, githubCommentTool }, approvals] = await Promise.all([
    loadTools(),
    resetApprovals(),
  ]);
  const { context, holds } = await turn();

  const statuses = [];
  statuses.push((await githubCreateIssueTool.execute({ title: "Bug" }, context())).data.status);
  statuses.push(
    (await githubCommentTool.execute({ target: "acme/api#4", body: "+1" }, context())).data.status
  );
  statuses.push((await githubCreateIssueTool.execute({ title: "Bug" }, context())).data.status);
  const cancelled = githubCreateIssueTool.execute({ title: "Bug" }, context());
  approvals.cancelApproval(await cardFor(approvals, "call-4"));
  statuses.push((await cancelled).data.status);
  const unknown = githubCommentTool.execute({ target: "acme/api#4", body: "+1" }, context());
  await approvals.approveAction(await cardFor(approvals, "call-5"));
  statuses.push((await unknown).data.status);

  assert.deepEqual(statuses, [
    "unavailable",
    "failed",
    "unavailable",
    "cancelled_by_user",
    "unknown",
  ]);
  assert.equal(holds.count, 5);
});

test("an unconfirmed issue or comment sends the user to GitHub to check before retrying", async (t) => {
  await useEnglish();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async (_connector, action) => ({
          status: "ready",
          actionId: "a1",
          preview:
            action === "comment"
              ? { ...ISSUE_PREVIEW, verbKey: "comment", destinationLabel: "acme/api#4" }
              : ISSUE_PREVIEW,
        }),
        connectorCommit: async () => ({
          state: "unknown",
          checkUrl: "https://github.com/acme/api/issues",
        }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool, githubCommentTool }, approvals] = await Promise.all([
    loadTools(),
    resetApprovals(),
  ]);
  const { context } = await turn();

  const created = githubCreateIssueTool.execute({ title: "Bug" }, context());
  await approvals.approveAction(await cardFor(approvals, "call-1"));
  const commented = githubCommentTool.execute({ target: "acme/api#4", body: "+1" }, context());
  await approvals.approveAction(await cardFor(approvals, "call-2"));

  const issueResult = await created;
  const commentResult = await commented;
  const issue = issueResult.data;
  const comment = commentResult.data;
  // The tool step names what may not exist, as the card does.
  assert.equal(
    issueResult.displayText,
    "Couldn't confirm the issue was created. Check acme/api before trying again."
  );
  assert.equal(
    commentResult.displayText,
    "Couldn't confirm the comment was posted. Check acme/api#4 before trying again."
  );
  assert.equal(issue.status, "unknown");
  assert.equal(issue.checkUrl, "https://github.com/acme/api/issues");
  assert.match(
    issue.guidance,
    /check the repository's issues on GitHub \(checkUrl, when there is one\)/
  );
  assert.equal(comment.status, "unknown");
  // A commit whose IPC threw has no checkUrl, so the guidance never assumes one.
  assert.match(comment.guidance, /on GitHub \(checkUrl, when there is one\)/);
  assert.match(comment.guidance, /before asking for the comment again/);
});

test("a sent issue tells the model who GitHub notified, from the card as sent", async (t) => {
  const answers = [
    { ...ISSUE_PREVIEW, fields: { title: "Ping @alice", body: "See `@bob` and @Alice" } },
    ISSUE_PREVIEW,
  ];
  let prepared = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: `a${++prepared}`,
          preview: answers.shift(),
        }),
        connectorCommit: async () => ({
          state: "sent",
          url: "https://github.com/acme/api/issues/212",
          resultLabel: "acme/api#212",
        }),
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool }, approvals] = await Promise.all([loadTools(), resetApprovals()]);
  const { context } = await turn();

  const mentioned = githubCreateIssueTool.execute({ title: "Ping @alice" }, context());
  const key = await cardFor(approvals, "call-1");
  // The user adds someone on the card before Send.
  approvals.updateApprovalDraft(key, { fields: { body: "See `@bob` and @Alice, cc @carol" } });
  await approvals.approveAction(key);
  const quiet = githubCreateIssueTool.execute({ title: "Login times out" }, context());
  await approvals.approveAction(await cardFor(approvals, "call-2"));

  assert.deepEqual((await mentioned).data.notified, ["@alice", "@carol"]);
  assert.equal("notified" in (await quiet).data, false);
});

test("an unedited send reports who GitHub notified from what the call prepared", async (t) => {
  // The card reports final fields only when the user edited them.
  const answers = [
    { ...ISSUE_PREVIEW, fields: { title: "Ping @alice", body: "cc @bob" } },
    {
      verbKey: "comment",
      destinationLabel: "acme/api#4",
      body: "Thanks @carol",
      fields: { body: "Thanks @carol" },
    },
  ];
  let prepared = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({
          status: "ready",
          actionId: `a${++prepared}`,
          preview: answers.shift(),
        }),
        connectorCommit: async () => ({
          state: "sent",
          url: "https://github.com/acme/api/issues/4",
        }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool, githubCommentTool }, approvals] = await Promise.all([
    loadTools(),
    resetApprovals(),
  ]);
  const { context } = await turn();

  const created = githubCreateIssueTool.execute(
    { title: "Ping\n@alice", body: "cc @bob" },
    context()
  );
  await approvals.approveAction(await cardFor(approvals, "call-1"));
  const commented = githubCommentTool.execute(
    { target: "acme/api#4", body: "Thanks @carol" },
    context()
  );
  await approvals.approveAction(await cardFor(approvals, "call-2"));

  const issue = (await created).data;
  const comment = (await commented).data;
  assert.equal("final" in issue, false);
  assert.deepEqual(issue.notified, ["@alice", "@bob"]);
  assert.equal("final" in comment, false);
  assert.deepEqual(comment.notified, ["@carol"]);
});

test("titles and bodies are measured in characters, as the card and main measure them", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => {
          prepared += 1;
          return { status: "failed", errorCode: "invalid", message: "stop here" };
        },
      },
    },
  });
  await setGithubStatus(t);
  const { githubCreateIssueTool } = await loadTools();
  const { context } = await turn();

  // 256 emoji are 512 UTF-16 units but 256 characters: within the limit.
  const fits = await githubCreateIssueTool.execute({ title: "😀".repeat(256) }, context());
  const over = await githubCreateIssueTool.execute({ title: "😀".repeat(257) }, context());

  assert.equal(fits.data.errorCode, "invalid");
  assert.equal(over.data.errorCode, "too_long");
  assert.equal(prepared, 1);
});

test("a sixth card in one turn is refused by the shared card cap", async (t) => {
  let prepared = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => {
          prepared += 1;
          return { status: "ready", actionId: `a${prepared}`, preview: ISSUE_PREVIEW };
        },
        connectorCancel: async () => ({ cancelled: true }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool }, approvals] = await Promise.all([loadTools(), resetApprovals()]);
  const { context, holds } = await turn();

  // The AI SDK runs a step's tool calls in parallel.
  const calls = Array.from({ length: 6 }, (_, index) =>
    githubCreateIssueTool.execute({ title: `Issue ${index + 1}` }, context())
  );
  const sixth = await calls[5];
  for (let index = 1; index <= 5; index += 1) {
    approvals.cancelApproval(await cardFor(approvals, `call-${index}`));
  }
  await Promise.all(calls);

  assert.equal(sixth.data.status, "not_sent");
  assert.equal(sixth.data.reason, "card_limit");
  assert.equal(prepared, 5);
  assert.equal(holds.count, 6);
});

test("a card whose login lapsed by Send tells the model to reconnect GitHub", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorPrepare: async () => ({ status: "ready", actionId: "a1", preview: ISSUE_PREVIEW }),
        connectorCommit: async () => ({
          state: "failed",
          errorCode: "reconnect_needed",
          message: "Reconnect GitHub.",
        }),
      },
    },
  });
  await setGithubStatus(t);
  const [{ githubCreateIssueTool, GITHUB_RECONNECT_GUIDANCE }, approvals] = await Promise.all([
    loadTools(),
    resetApprovals(),
  ]);
  const { context } = await turn();

  const pending = githubCreateIssueTool.execute({ title: "Bug" }, context());
  const key = await cardFor(approvals, "call-1");
  await approvals.approveAction(key);
  const result = await pending;

  assert.equal(result.data.status, "unavailable");
  assert.equal(result.data.guidance, GITHUB_RECONNECT_GUIDANCE);
  // The card itself still says what happened.
  assert.equal(
    approvals.useConnectorApprovalStore.getState().entries[key].errorCode,
    "reconnect_needed"
  );
});

test("each GitHub tool has a step icon, and an English name and working line after find_contact's", async (t) => {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-github-tool-icons-" });
  const [{ githubToolModule }, { toolIcons }] = await Promise.all([
    loadTools(),
    vite.ssrLoadModule("/components/chat/toolIcons.ts"),
  ]);
  const tools = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  ).agentMode.tools;
  const keys = Object.keys(tools);
  const names = githubToolModule
    .createTools({ emailDraftTarget: "gmail" })
    .map((tool) => tool.name);
  assert.deepEqual(names, ["github_search_issues", "github_create_issue", "github_comment"]);
  for (const name of names) assert.ok(toolIcons[name], `${name} has an icon`);
  // Linear's tools of the same kind show the same icons.
  assert.deepEqual(
    names.map((name) => toolIcons[name]),
    ["linear_search_issues", "linear_create_issue", "linear_comment"].map((name) => toolIcons[name])
  );
  // Foundation §9.6: GitHub's keys sit right after find_contact's, in tool order.
  for (const suffix of ["Name", "Status"]) {
    const at = keys.indexOf(`find_contact${suffix}`);
    assert.deepEqual(
      keys.slice(at + 1, at + 4),
      names.map((name) => `${name}${suffix}`)
    );
  }
  assert.deepEqual(
    names.map((name) => [tools[`${name}Name`], tools[`${name}Status`]]),
    [
      ["Search GitHub", "Searching GitHub..."],
      ["GitHub issue", "Preparing a GitHub issue..."],
      ["GitHub comment", "Preparing a GitHub comment..."],
    ]
  );
});

test("the connector rules forbid claiming an issue or comment that wasn't sent", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-github-prompt-rules-" });
  const [{ getAgentSystemPrompt }, { githubToolModule }] = await Promise.all([
    vite.ssrLoadModule("/config/prompts.ts"),
    loadTools(),
  ]);

  const prompt = getAgentSystemPrompt(githubToolModule.createTools({ emailDraftTarget: "gmail" }));

  assert.match(
    prompt,
    /nor that an issue or comment was created or posted unless its status is sent/
  );
});
