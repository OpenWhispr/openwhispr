const test = require("node:test");
const { after, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

let vite;
const cleanups = [];
const scope = { after: (fn) => cleanups.push(fn) };
before(async () => {
  installBrowserGlobals(scope, { window: { electronAPI: {} } });
  vite = await createRendererServer(scope, { cachePrefix: "openwhispr-interaction-tools-test-" });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
});
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const load = () => vite.ssrLoadModule("/services/tools/interactionTools.ts");
const loadStore = () => vite.ssrLoadModule("/stores/agentInteractionStore.ts");

function context(toolCallId, images = []) {
  return {
    messageId: "m1",
    toolCallId,
    signal: new AbortController().signal,
    onInteraction() {},
    attachImage: (image) => images.push(image),
    claimTurnSlot: () => true,
    releaseTurnSlot() {},
    claimAction: () => true,
    releaseAction() {},
    sentEarlier: () => false,
    recordCompletedAction() {},
  };
}

const names = (tools) => tools.map((tool) => tool.name);
const NOTHING = { connectionTargets: [], missingKeyProviders: [], screenAccess: false };

test("each interaction tool registers only when it can act", async () => {
  const { createInteractionTools } = await load();
  assert.deepEqual(names(createInteractionTools(NOTHING)), ["ask_user", "open_settings"]);
  assert.deepEqual(
    names(
      createInteractionTools({
        connectionTargets: ["slack"],
        missingKeyProviders: ["openai"],
        screenAccess: true,
      })
    ),
    ["ask_user", "request_connection", "request_access", "request_api_key", "open_settings"]
  );
  const [, connection] = createInteractionTools({
    ...NOTHING,
    connectionTargets: ["slack", "calendar"],
  });
  assert.deepEqual(connection.parameters.properties.target.enum, ["slack", "calendar"]);
});

test("the keys the agent may ask for are BYOK keys", async () => {
  const { API_KEY_PROVIDERS } = await loadStore();
  const bases = BYOK_API_KEYS.map((key) => key.base);
  for (const provider of API_KEY_PROVIDERS) assert.ok(bases.includes(provider), provider);
});

test("ask_user refuses a malformed question without asking anything", async () => {
  const { createInteractionTools } = await load();
  const askUser = createInteractionTools(NOTHING)[0];
  const store = await loadStore();
  store.useAgentInteractionStore.setState({ entries: {} });

  const result = await askUser.execute(
    {
      questions: [{ id: "a", kind: "single", prompt: "Pick", options: [{ id: "x", label: "X" }] }],
    },
    context("bad")
  );
  assert.equal(result.data.status, "invalid");
  assert.deepEqual(store.useAgentInteractionStore.getState().entries, {});
});

test("ask_user returns the chosen labels to the model", async () => {
  const { createInteractionTools } = await load();
  const store = await loadStore();
  const askUser = createInteractionTools(NOTHING)[0];
  const running = askUser.execute(
    {
      questions: [
        {
          id: "channel",
          kind: "single",
          prompt: "Which channel?",
          options: [
            { id: "eng", label: "#eng", recommended: true },
            { id: "general", label: "#general" },
          ],
        },
        { id: "tone", kind: "text", prompt: "Tone?" },
      ],
    },
    context("q1")
  );
  store.updateInteractionDraft("m1::q1", { channel: "general", tone: "casual" });
  store.answerQuestions("m1::q1");
  const result = await running;
  assert.deepEqual(result.data, {
    status: "answered",
    answers: { channel: "#general", tone: "casual" },
  });
  assert.equal(result.displayText, "Answered\nWhich channel? #general\nTone? casual");
});

test("a dismissed connection tells the model not to ask again", async () => {
  const { createInteractionTools } = await load();
  const store = await loadStore();
  const [, connection] = createInteractionTools({ ...NOTHING, connectionTargets: ["slack"] });
  const running = connection.execute(
    { target: "slack", reason: "So I can post the update" },
    context("c1")
  );
  assert.deepEqual(store.useAgentInteractionStore.getState().entries["m1::c1"].payload, {
    kind: "connection",
    target: "slack",
    reason: "So I can post the update",
  });
  store.cancelInteraction("m1::c1");
  const result = await running;
  assert.equal(result.data.status, "cancelled_by_user");
  assert.match(result.data.guidance, /Don't ask the same thing again/);

  assert.equal(
    (await connection.execute({ target: "gmail" }, context("c2"))).data.status,
    "invalid"
  );
});

test("connecting Gmail points the model at email_draft, whose description predates it", async () => {
  const { createInteractionTools } = await load();
  const store = await loadStore();
  globalThis.window.electronAPI = {
    connectorConnect: async () => ({
      status: "connected",
      accountLabel: "a",
      workspaceLabel: null,
    }),
    connectorStatus: async () => [
      { id: "gmail", connected: true, configured: true, accountLabel: "a", needsReconnect: false },
    ],
  };
  const [, connection] = createInteractionTools({ ...NOTHING, connectionTargets: ["gmail"] });
  const running = connection.execute({ target: "gmail" }, context("g1"));
  await store.connectInteraction("m1::g1");
  const result = await running;
  assert.equal(result.data.status, "connected");
  assert.match(result.data.guidance, /Continue with email_draft/);
});

test("a saved key reaches the model only as saved", async () => {
  const { createInteractionTools } = await load();
  const store = await loadStore();
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ setOpenaiApiKey() {} });
  const apiKeyTool = createInteractionTools({ ...NOTHING, missingKeyProviders: ["openai"] }).find(
    (tool) => tool.name === "request_api_key"
  );
  const running = apiKeyTool.execute({ provider: "openai" }, context("k1"));
  await store.submitApiKey("m1::k1", "sk-test-secret");
  const result = await running;
  assert.equal(result.data.status, "saved");
  assert.equal(JSON.stringify(result).includes("sk-test-secret"), false);
});

test("allowed access attaches the screenshot for the next step", async () => {
  const { createInteractionTools } = await load();
  const store = await loadStore();
  globalThis.window.electronAPI = {
    getPlatform: () => "linux",
    checkScreenRecordingAccess: async () => ({ granted: true }),
    captureScreenContext: async () => ({ data: "IMG", mediaType: "image/jpeg" }),
  };
  const images = [];
  const access = createInteractionTools({ ...NOTHING, screenAccess: true }).find(
    (tool) => tool.name === "request_access"
  );
  const running = access.execute({ resource: "screen", reason: "see it" }, context("a1", images));
  await store.respondToAccess("m1::a1", true);
  const result = await running;
  assert.equal(result.data.status, "granted");
  assert.equal(JSON.stringify(result).includes("IMG"), false);
  assert.deepEqual(images, [{ image: "IMG", mediaType: "image/jpeg" }]);
});

test("a tool whose service isn't connected asks to connect it, then does what it was asked", async () => {
  const { requireConnection } = await load();
  const store = await loadStore();
  let ready = false;
  const ran = [];
  const tool = requireConnection(
    {
      name: "slack_send_message",
      description: "",
      parameters: {},
      readOnly: false,
      execute: async (args) => {
        ran.push(args);
        return { success: true, data: { status: "sent" }, displayText: "Sent" };
      },
    },
    "slack",
    () => ready
  );

  const declined = tool.execute({ text: "first" }, context("w1"));
  assert.deepEqual(store.useAgentInteractionStore.getState().entries["m1::w1"].payload, {
    kind: "connection",
    target: "slack",
  });
  store.cancelInteraction("m1::w1");
  assert.equal((await declined).data.status, "cancelled_by_user");
  assert.deepEqual(ran, []);

  const running = tool.execute({ text: "second" }, context("w2"));
  ready = true;
  globalThis.window.electronAPI = {
    connectorConnect: async () => ({ status: "connected", accountLabel: "a", workspaceLabel: "w" }),
    connectorStatus: async () => [
      {
        id: "slack",
        connected: true,
        configured: true,
        accountLabel: "a",
        workspaceLabel: "w",
        needsReconnect: false,
      },
    ],
  };
  await store.connectInteraction("m1::w2");
  assert.equal((await running).data.status, "sent");
  assert.deepEqual(ran, [{ text: "second" }]);
  assert.equal((await tool.execute({ text: "third" }, context("w3"))).data.status, "sent");
  assert.deepEqual(store.useAgentInteractionStore.getState().entries["m1::w3"], undefined);
});

test("calls that need the same service at once share one connection card", async () => {
  const { requireConnection } = await load();
  const store = await loadStore();
  store.useAgentInteractionStore.setState({ entries: {} });
  let ready = false;
  const ran = [];
  const tool = requireConnection(
    {
      name: "slack_send_message",
      description: "",
      parameters: {},
      readOnly: false,
      execute: async (args) => {
        ran.push(args.destination);
        return { success: true, data: { status: "sent" }, displayText: "Sent" };
      },
    },
    "slack",
    () => ready
  );
  const first = tool.execute({ destination: "#eng" }, context("p1"));
  const joined = [];
  const second = tool.execute(
    { destination: "#design" },
    {
      ...context("p2"),
      onInteraction: (record) => joined.push(record.state),
    }
  );
  assert.deepEqual(Object.keys(store.useAgentInteractionStore.getState().entries), ["m1::p1"]);
  assert.deepEqual(joined, ["pending"], "the joined call waits too, so a stop marks it unsent");

  ready = true;
  globalThis.window.electronAPI = {
    connectorConnect: async () => ({ status: "connected", accountLabel: "a", workspaceLabel: "w" }),
    connectorStatus: async () => [
      { id: "slack", connected: true, configured: true, accountLabel: "a", needsReconnect: false },
    ],
  };
  await store.connectInteraction("m1::p1");
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.data.status),
    ["sent", "sent"]
  );
  assert.deepEqual(ran.sort(), ["#design", "#eng"]);
  assert.deepEqual(joined, ["pending", "settled"]);
});

test("the prompt has the model look things up before asking, naming only this turn's tools", async () => {
  const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");
  const { createInteractionTools } = await load();
  const asking = createInteractionTools(NOTHING);
  const withTools = getAgentSystemPrompt([{ name: "search_notes" }, ...asking]);
  assert.match(withTools, /look it up/i);
  assert.match(withTools, /with search_notes/);
  assert.doesNotMatch(withTools, /find_contact|github_search_issues/);
  // Every key is set here, so request_api_key isn't offered; the rule still is.
  assert.match(withTools, /never ask the user to type or paste an API key/i);
  assert.equal(getAgentSystemPrompt([{ name: "search_notes" }]).includes("ask_user"), false);
});

test("every interaction tool has its tool-step copy", async () => {
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const { createInteractionTools } = await load();
  const tools = createInteractionTools({
    connectionTargets: ["slack"],
    missingKeyProviders: ["openai"],
    screenAccess: true,
  });
  for (const { name } of tools) {
    assert.ok(translation.agentMode.tools[`${name}Status`], name);
    assert.ok(translation.agentMode.tools[`${name}Name`], name);
  }
});
