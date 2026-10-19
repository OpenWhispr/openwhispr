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
    onApprovalRequested() {},
    onHoldDelivery() {},
    onInteractionRequested() {},
    attachImage: (image) => images.push(image),
    claimTurnSlot: () => true,
    releaseTurnSlot() {},
    isActionCompleted: () => false,
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

test("the keys the agent may ask for are BYOK keys with a settings setter", async () => {
  const { API_KEY_PROVIDERS } = await load();
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const bases = BYOK_API_KEYS.map((key) => key.base);
  for (const provider of API_KEY_PROVIDERS) {
    assert.ok(bases.includes(provider), provider);
    const setter = `set${provider[0].toUpperCase()}${provider.slice(1)}ApiKey`;
    assert.equal(typeof useSettingsStore.getState()[setter], "function", setter);
  }
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
  assert.equal(result.displayText, "Answered");
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

test("a tool whose service isn't connected yet asks the model to request it", async () => {
  const { requireConnection } = await load();
  let ready = false;
  let ran = 0;
  const tool = requireConnection(
    {
      name: "slack_send_message",
      description: "",
      parameters: {},
      readOnly: false,
      execute: async () => {
        ran += 1;
        return { success: true, data: { status: "sent" }, displayText: "Sent" };
      },
    },
    "slack",
    () => ready
  );
  const refused = await tool.execute({}, undefined);
  assert.equal(refused.data.reason, "not_connected");
  assert.match(refused.data.guidance, /request_connection with target "slack"/);
  assert.equal(ran, 0);
  ready = true;
  assert.equal((await tool.execute({}, undefined)).data.status, "sent");
});

test("the prompt tells the model to ask only when it has to", async () => {
  const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");
  const { createInteractionTools } = await load();
  const withTools = getAgentSystemPrompt(createInteractionTools(NOTHING));
  assert.match(withTools, /Ask the user something only when you really can't decide it yourself/);
  assert.match(withTools, /simple request gets a direct answer with no questions/);
  assert.match(withTools, /Before asking, look it up/);
  assert.equal(getAgentSystemPrompt([{ name: "search_notes" }]).includes("ask_user"), false);
});

test("every interaction tool has its tool-step copy", async () => {
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const { INTERACTION_TOOL_NAMES } = await load();
  for (const name of INTERACTION_TOOL_NAMES) {
    assert.ok(translation.agentMode.tools[`${name}Status`], name);
    assert.ok(translation.agentMode.tools[`${name}Name`], name);
  }
});
