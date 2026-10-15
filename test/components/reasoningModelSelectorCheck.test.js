const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const SELECTOR = "/components/ReasoningModelSelector.tsx";
const KEY = "common.apiKey";
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };
const props = (overrides = {}) => ({
  reasoningModel: "gpt-test",
  setReasoningModel() {},
  localReasoningProvider: "openai",
  setLocalReasoningProvider() {},
  cloudReasoningBaseUrl: "",
  setCloudReasoningBaseUrl() {},
  mode: "cloud",
  ...overrides,
});
const mount = (t, { overrides, ...options } = {}) =>
  mountSettingsPanel(t, { module: SELECTOR, props: props(overrides), ...options });

test("a saved key is checked once the panel is shown, with the panel's model", async (t) => {
  const panel = await mount(t, { secrets: { openaiApiKey: "sk-saved" } });
  assert.equal(panel.phase(), "waiting");
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    { scope: "reasoning", provider: "openai", apiKey: "sk-saved", model: "gpt-test" },
  ]);
  await panel.answer({ success: true });
  assert.equal(panel.phase(), "connected");
  assert.equal(panel.announcement(), "connected");
});

test("a provider tab that is only browsed checks its key alone", async (t) => {
  const panel = await mount(t, {
    secrets: { openaiApiKey: "sk-saved", anthropicApiKey: "sk-ant-saved" },
  });
  await panel.selectTab("anthropic");
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    { scope: "reasoning", provider: "anthropic", apiKey: "sk-ant-saved", model: "" },
  ]);
});

test("a hidden panel waits until it is shown, and asks again each time it is shown", async (t) => {
  const panel = await mount(t, { secrets: { openaiApiKey: "sk-saved" }, visible: false });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0);
  assert.equal(panel.phase(), "idle");
  await panel.setVisible(true);
  assert.equal(panel.phase(), "waiting");
  await panel.wait(0);
  assert.equal(panel.requests().length, 1);
  await panel.answer({ success: true });
  assert.equal(panel.phase(), "connected");
  await panel.setVisible(false);
  assert.equal(panel.phase(), "idle", "nothing is shown while hidden");
  await panel.setVisible(true);
  assert.equal(panel.phase(), "waiting");
  await panel.wait(0);
  // The main process answers a check it remembers at once, without asking the provider.
  assert.equal(panel.requests().length, 2, "a shown panel asks again");
  await panel.answer({ success: true });
  assert.equal(panel.phase(), "connected");
});

test("a shown panel with a remembered answer shows it at once, with no pause", async (t) => {
  const panel = await mount(t, { secrets: { openaiApiKey: "sk-saved" }, visible: false });
  await panel.setVisible(true);
  await panel.wait(0); // no time passes
  assert.equal(panel.requests().length, 1, "asked as soon as it is shown");
  // The main process answers a check it remembers at once, without asking the provider.
  await panel.answer({ success: true });
  assert.equal(panel.phase(), "connected");
  assert.equal(panel.announcement(), "connected");
});

test("a key saves trimmed once its check passes or its field is left, never half typed", async (t) => {
  const panel = await mount(t);
  assert.equal(panel.phase(), "idle", "no key, no status");
  await panel.type(KEY, "  sk-pas");
  await panel.type(KEY, "  sk-pasted  ");
  await panel.wait(500);
  assert.equal(panel.requests().at(-1).apiKey, "sk-pasted");
  assert.equal(panel.state().openaiApiKey, "", "nothing is saved while the key is typed");
  await panel.answer({ success: true });
  assert.equal(panel.state().openaiApiKey, "sk-pasted", "a passing key saves at once");
  await panel.type(KEY, "sk-other");
  await panel.blur(KEY, { windowSwitch: true });
  assert.equal(panel.state().openaiApiKey, "sk-other", "leaving the window saves it");
});

test("a typed key saves when another provider takes its field or the panel unmounts", async (t) => {
  const panel = await mount(t);
  await panel.type(KEY, "sk-typed");
  // The scope's provider changes elsewhere, so the focused field shows Anthropic's key.
  await panel.setProps({ localReasoningProvider: "anthropic" });
  await panel.type(KEY, "sk-ant-typed");
  assert.equal(panel.state().openaiApiKey, "sk-typed");
  await panel.unmount(); // Escape closing Settings fires no blur
  assert.equal(panel.state().anthropicApiKey, "sk-ant-typed");
});

test("typing keeps the 0.5 s pause, and leaving the field sends at once", async (t) => {
  const panel = await mount(t);
  await panel.type(KEY, "sk-first");
  assert.equal(panel.phase(), "waiting");
  await panel.wait(499);
  assert.equal(panel.requests().length, 0, "nothing while the pause runs");
  await panel.wait(1);
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["sk-first"]
  );
  await panel.type(KEY, "sk-second");
  await panel.wait(200);
  await panel.blur(KEY); // mid-pause
  await panel.wait(0);
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["sk-first", "sk-second"]
  );
});

test("a key typed in another shown panel still waits for the pause", async (t) => {
  const panel = await mount(t, { secrets: { anthropicApiKey: "sk-ant-saved" } });
  // The hosted key is shared: another shown panel types it, so no field here has focus.
  await panel.setStore({ openaiApiKey: "s" });
  assert.equal(panel.phase(), "waiting");
  await panel.wait(499);
  assert.equal(panel.requests().length, 0, "a half-typed key is not sent");
  await panel.setStore({ openaiApiKey: "sk" });
  await panel.wait(499);
  assert.equal(panel.requests().length, 0, "each change starts the pause over");
  await panel.wait(1);
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["sk"]
  );
  await panel.selectTab("anthropic");
  await panel.wait(0); // a tab switch checks at once, though it shows another key
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["sk", "sk-ant-saved"]
  );
});

test("a rejected key keeps its reason and Retry, and stays saved", async (t) => {
  const panel = await mount(t, { secrets: { openaiApiKey: "sk-saved" } });
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.checkField().props.check.failure.errorCode, "credentialsRejected");
  assert.equal(panel.checkField().props.invalidOn, "credentialsRejected", "the key is at fault");
  assert.equal(panel.state().openaiApiKey, "sk-saved");
  await panel.retry();
  assert.equal(panel.requests().length, 2, "Retry does not wait for the pause");
});

test("each hosted provider shows one shared key field under Settings' heading", async (t) => {
  for (const [provider, url] of [
    ["openai", "https://platform.openai.com/api-keys"],
    ["anthropic", "https://console.anthropic.com/settings/keys"],
    ["gemini", "https://aistudio.google.com/app/api-keys"],
    ["groq", "https://console.groq.com/keys"],
    ["corti", "https://www.corti.ai/?utm_source=referral&utm_campaign=openwhispr"],
  ]) {
    await t.test(provider, async (t) => {
      const panel = await mount(t, { overrides: { localReasoningProvider: provider } });
      assert.equal(panel.field(KEY).props.type, "password");
      assert.ok(panel.field(KEY).props.check, "the key carries the status");
      assert.equal(panel.find((node) => node.props?.url === url).length, 1);
      const euOnly = panel.find((node) => node.props?.children === "reasoning.corti.euOnly");
      assert.equal(euOnly.length, provider === "corti" ? 1 : 0);
    });
  }
});

test("local mode, OpenRouter and Custom send nothing from this panel", async (t) => {
  for (const [name, overrides] of [
    ["local", { mode: "local", localReasoningProvider: "qwen" }],
    ["openrouter", { localReasoningProvider: "openrouter" }],
    ["custom", { localReasoningProvider: "custom" }],
  ]) {
    await t.test(name, async (t) => {
      const panel = await mount(t, {
        overrides,
        secrets: { openaiApiKey: "sk-saved", openrouterApiKey: "sk-or-saved" },
      });
      await panel.wait(1000);
      assert.equal(panel.requests().length, 0);
      assert.equal(panel.field(KEY), undefined);
      if (name === "openrouter") {
        assert.equal(panel.find((node) => node.props?.provider === "openrouter").length, 1);
      }
    });
  }
});
