const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// The module list imports the real tools (i18n, stores), which expect a window.
const loadModules = (t) => {
  installBrowserGlobals(t);
  return import("../../src/services/tools/connectors/connectorToolModules.ts");
};
const loadToolRegistry = () => import("../../src/services/tools/ToolRegistry.ts");

function fakeTool(name, connectorId) {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    readOnly: true,
    connectorId,
    async execute() {
      return { success: true, data: null, displayText: "" };
    },
  };
}

test("a module's tools register when it needs no login or its connector is ready, in list order", async (t) => {
  const [{ registerConnectorTools }, { ToolRegistry }] = await Promise.all([
    loadModules(t),
    loadToolRegistry(),
  ]);
  const envs = [];
  const modules = [
    {
      connectorId: "email",
      requiresConnection: false,
      createTools: (env) => {
        envs.push(env);
        return [fakeTool("find_contact", "email"), fakeTool("email_draft", "email")];
      },
    },
    {
      connectorId: "slack",
      requiresConnection: true,
      createTools: () => [fakeTool("slack_send_message", "slack")],
    },
    {
      connectorId: "linear",
      requiresConnection: true,
      createTools: () => [fakeTool("linear_search_issues", "linear")],
    },
  ];
  const names = (readyConnectorIds) => {
    const registry = new ToolRegistry();
    registerConnectorTools(registry, { emailDraftTarget: "gmail", readyConnectorIds }, modules);
    return registry.getAll().map((tool) => tool.name);
  };

  assert.deepEqual(names([]), ["find_contact", "email_draft"]);
  assert.deepEqual(names(["linear"]), ["find_contact", "email_draft", "linear_search_issues"]);
  assert.deepEqual(names(["linear", "slack"]), [
    "find_contact",
    "email_draft",
    "slack_send_message",
    "linear_search_issues",
  ]);
  assert.deepEqual(envs.at(-1), { emailDraftTarget: "gmail" });
});

test("two tools with one name is a build fault, not a silent replacement", async (t) => {
  const [{ registerConnectorTools }, { ToolRegistry }] = await Promise.all([
    loadModules(t),
    loadToolRegistry(),
  ]);
  const modules = [
    {
      connectorId: "a",
      requiresConnection: false,
      createTools: () => [fakeTool("search_issues", "a")],
    },
    {
      connectorId: "b",
      requiresConnection: false,
      createTools: () => [fakeTool("search_issues", "b")],
    },
  ];

  assert.throws(
    () =>
      registerConnectorTools(
        new ToolRegistry(),
        { emailDraftTarget: "gmail", readyConnectorIds: [] },
        modules
      ),
    /connector tool "search_issues" is registered twice/
  );
});

test("the shipped list is email, Slack, Linear then GitHub, and every connector tool names its connector and prompt line", async (t) => {
  const { CONNECTOR_TOOL_MODULES } = await loadModules(t);

  assert.deepEqual(
    CONNECTOR_TOOL_MODULES.map((entry) => [entry.connectorId, entry.requiresConnection]),
    [
      ["email", false],
      ["slack", true],
      ["linear", true],
      ["github", true],
    ]
  );
  for (const entry of CONNECTOR_TOOL_MODULES) {
    for (const emailDraftTarget of ["gmail", "gmailSend"]) {
      for (const tool of entry.createTools({ emailDraftTarget })) {
        assert.equal(typeof tool.connectorId, "string", tool.name);
        assert.match(tool.promptInstruction ?? "", new RegExp(`^Use ${tool.name}\\b`), tool.name);
      }
    }
  }
});
