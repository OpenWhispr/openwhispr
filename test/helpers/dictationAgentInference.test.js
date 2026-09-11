const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationAgentInference.js");

const baseSettings = {
  useDictationAgent: true,
  dictationAgentMode: "providers",
  dictationAgentProvider: "openai",
  dictationAgentModel: "gpt-5-mini",
  dictationAgentRemoteUrl: "",
  dictationAgentCloudBaseUrl: "",
  dictationAgentCustomApiKey: "",
  dictationAgentDisableThinking: true,
};

test("uses the dictation agent scope, not the cleanup scope", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    // Cleanup is configured completely differently; it must not leak through.
    cleanupProvider: "openai",
    cleanupModel: "gpt-4.1-mini",
  });

  assert.equal(result.model, "gpt-5-mini");
  assert.equal(result.config.provider, "openai");
});

test("a model-required agent is unreachable without an explicit model", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({ ...baseSettings, dictationAgentModel: "" });

  assert.equal(result.reachable, false);
});

test("self-hosted is reachable with no model and forwards the LAN url", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "self-hosted",
    dictationAgentModel: "",
    dictationAgentRemoteUrl: "http://127.0.0.1:8080/v1",
    dictationAgentCustomApiKey: "test-key",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.config.lanUrl, "http://127.0.0.1:8080/v1");
  assert.equal(result.config.customApiKey, "test-key");
});

test("cloud is reachable with no model", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(
    {
      ...baseSettings,
      dictationAgentMode: "openwhispr",
      dictationAgentProvider: "openai",
      dictationAgentModel: "",
    },
    { isCloudAgent: true }
  );

  assert.equal(result.reachable, true);
  assert.equal(result.model, "");
  assert.equal(result.config.provider, "openwhispr");
});

test("a custom provider forwards its base url and api key", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentProvider: "custom",
    dictationAgentCloudBaseUrl: "https://example.test/v1",
    dictationAgentCustomApiKey: "sk-test",
  });

  assert.equal(result.config.baseUrl, "https://example.test/v1");
  assert.equal(result.config.customApiKey, "sk-test");
});

test("a non-custom provider leaks neither base url nor api key", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentCloudBaseUrl: "https://example.test/v1",
    dictationAgentCustomApiKey: "sk-test",
  });

  assert.equal(result.config.baseUrl, undefined);
  assert.equal(result.config.customApiKey, undefined);
});

test("a disabled agent is unreachable", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({ ...baseSettings, useDictationAgent: false });

  assert.equal(result.reachable, false);
});

test("local mode with a leftover cloud provider still routes to llama.cpp", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    useDictationAgent: true,
    dictationAgentMode: "local",
    dictationAgentProvider: "openai",
    dictationAgentModel: "qwen2.5-coder",
  });

  assert.equal(result.config.provider, "local");
});

test("local mode with an empty provider routes to llama.cpp", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "local",
    dictationAgentProvider: "",
  });

  assert.equal(result.config.provider, "local");
});

test("self-hosted mode with a leftover provider routes only via the LAN url", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "self-hosted",
    dictationAgentProvider: "openai",
    dictationAgentModel: "",
    dictationAgentRemoteUrl: "http://127.0.0.1:8080/v1",
  });

  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, "http://127.0.0.1:8080/v1");
});

test("self-hosted mode without a remote url never keeps a leftover provider", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "self-hosted",
    dictationAgentProvider: "openai",
    dictationAgentModel: "gpt-5-mini",
    dictationAgentRemoteUrl: "",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.displayProvider, "self-hosted");
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, undefined);
});

test("providers mode keeps an explicit cloud provider", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentProvider: "openai",
    dictationAgentModel: "gpt-5-mini",
  });

  assert.equal(result.config.provider, "openai");
});

test("providers mode rejects a stale local provider", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentProvider: "qwen",
    dictationAgentModel: "qwen2.5-coder",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.displayProvider, "none");
  assert.equal(result.config.provider, undefined);
});

test("local mode wins over an inconsistent cloud flag", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(
    { ...baseSettings, dictationAgentMode: "local", dictationAgentProvider: "openai" },
    { isCloudAgent: true }
  );

  assert.equal(result.config.provider, "local");
});

test("managed mode never falls through to a stale provider when signed out", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "openwhispr",
    dictationAgentProvider: "openai",
    dictationAgentModel: "gpt-5-mini",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.displayProvider, "openwhispr");
  assert.equal(result.config.provider, undefined);
});

test("enterprise mode with a missing provider fails closed", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    dictationAgentMode: "enterprise",
    dictationAgentProvider: "",
    dictationAgentModel: "anthropic.claude-sonnet-4",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.config.provider, undefined);
});

test("vision override runs as the dictation agent scope and inherits key with endpoint", async () => {
  const { resolveDictationAgentVisionInference } = await load();

  const result = resolveDictationAgentVisionInference({
    ...baseSettings,
    dictationAgentProvider: "custom",
    dictationAgentCloudBaseUrl: "https://agent.example.com/v1",
    dictationAgentCustomApiKey: "agent-key",
    useDictationAgentVisionModel: true,
    dictationAgentVisionMode: "providers",
    dictationAgentVisionProvider: "",
    dictationAgentVisionModel: "vision-model",
    dictationAgentVisionCloudBaseUrl: "",
    dictationAgentVisionCustomApiKey: "",
  });

  assert.equal(result.config.inferenceScope, "dictationAgent");
  assert.equal(result.config.baseUrl, "https://agent.example.com/v1");
  assert.equal(
    result.config.customApiKey,
    "agent-key",
    "an inherited endpoint must carry the agent's key with it"
  );
});

test("a vision scope with its own endpoint never borrows the agent's key", async () => {
  const { resolveDictationAgentVisionInference } = await load();

  const result = resolveDictationAgentVisionInference({
    ...baseSettings,
    dictationAgentProvider: "custom",
    dictationAgentCloudBaseUrl: "https://agent.example.com/v1",
    dictationAgentCustomApiKey: "agent-key",
    useDictationAgentVisionModel: true,
    dictationAgentVisionMode: "providers",
    dictationAgentVisionProvider: "custom",
    dictationAgentVisionModel: "vision-model",
    dictationAgentVisionCloudBaseUrl: "https://vision.example.com/v1",
    dictationAgentVisionCustomApiKey: "",
  });

  assert.equal(result.config.baseUrl, "https://vision.example.com/v1");
  assert.equal(
    result.config.customApiKey,
    undefined,
    "the agent's key must not ride to the vision scope's own endpoint"
  );
});

// The assistant panel answers spoken commands on the Voice Assistant scope —
// the tab the user actually edits — and gates screenshots exactly like the
// dictation route does.
const imageWired = (providerId) =>
  ["openai", "anthropic", "gemini", "openwhispr"].includes(providerId);
const panelSettings = {
  ...baseSettings,
  isSignedIn: false,
  chatAgentMode: "providers",
  chatAgentProvider: "anthropic",
  chatAgentModel: "claude-sonnet-4-5",
  useDictationAgentVisionModel: false,
  dictationAgentVisionMode: "",
  dictationAgentVisionProvider: "",
  dictationAgentVisionModel: "",
  dictationAgentVisionCloudBaseUrl: "",
  dictationAgentVisionCustomApiKey: "",
};
const panel = (settings, options = {}) =>
  resolveChatStreamingInference(settings, {
    inferenceScope: "dictationAgent",
    isProviderImageWired: imageWired,
    ...options,
  });
let resolveChatStreamingInference;
test.before(async () => {
  ({ resolveChatStreamingInference } = await load());
});

test("typed chat surfaces stay on the Chat scope even when the Voice Assistant scope is reachable", () => {
  const { config, attachScreenContext } = resolveChatStreamingInference(panelSettings, {
    hasScreenContext: true,
    isProviderImageWired: imageWired,
  });

  assert.equal(config.scope, "chatIntelligence");
  assert.equal(config.model, "claude-sonnet-4-5");
  assert.equal(attachScreenContext, true, "Chat's own model can see images");
});

test("an unreachable Voice Assistant scope falls the panel back to the Chat scope", () => {
  const { config, attachScreenContext } = panel(
    {
      ...panelSettings,
      dictationAgentMode: "providers",
      dictationAgentProvider: "",
      dictationAgentModel: "",
    },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "chatIntelligence");
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "claude-sonnet-4-5");
  assert.equal(attachScreenContext, true, "the fallback is gated on Chat's model, not the agent's");
});

test("a signed-in cloud Voice Assistant scope is reachable without a model and takes screenshots", () => {
  const { config, attachScreenContext } = panel(
    {
      ...panelSettings,
      isSignedIn: true,
      dictationAgentMode: "openwhispr",
      dictationAgentCloudMode: "openwhispr",
      dictationAgentProvider: "openwhispr",
      dictationAgentModel: "",
    },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgent");
  assert.equal(config.mode, "openwhispr");
  assert.equal(attachScreenContext, true, "cloud vision-routes server-side");
});

test("a signed-out cloud Voice Assistant scope is unreachable and falls back to Chat", () => {
  const { config } = panel({
    ...panelSettings,
    dictationAgentMode: "openwhispr",
    dictationAgentCloudMode: "openwhispr",
    dictationAgentModel: "",
  });

  assert.equal(config.scope, "chatIntelligence");
});

test("the assistant toggled off keeps the panel on the Chat scope", () => {
  const { config } = panel({ ...panelSettings, useDictationAgent: false });

  assert.equal(config.scope, "chatIntelligence");
});

test("the assistant panel resolves the Voice Assistant scope, not the Chat scope", () => {
  const { config, attachScreenContext } = panel(panelSettings);

  assert.equal(config.scope, "dictationAgent");
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-5-mini");
  assert.equal(attachScreenContext, false, "nothing to attach without a screenshot");
});

test("a screenshot attaches to the base scope when its model can see images", () => {
  const { config, attachScreenContext } = panel(panelSettings, { hasScreenContext: true });

  assert.equal(config.scope, "dictationAgent");
  assert.equal(config.model, "gpt-5-mini");
  assert.equal(attachScreenContext, true);
});

test("a screenshot is dropped when the base scope's provider is not image-wired", () => {
  const { config, attachScreenContext } = panel(
    {
      ...panelSettings,
      dictationAgentProvider: "groq",
      dictationAgentModel: "llama-3.3-70b-versatile",
    },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgent");
  assert.equal(attachScreenContext, false);
});

const visionOverride = {
  useDictationAgentVisionModel: true,
  dictationAgentVisionMode: "providers",
  dictationAgentVisionProvider: "gemini",
  // Not in the local registry under gemini: a configured override is trusted
  // to see images, the way the dictation route trusts it.
  dictationAgentVisionModel: "gemini-2.5-flash",
};

test("a screenshot swaps the panel onto the vision override and keeps the image", () => {
  const { config, attachScreenContext } = panel(
    { ...panelSettings, ...visionOverride },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgentVision");
  assert.equal(config.mode, "providers");
  assert.equal(config.provider, "gemini");
  assert.equal(config.model, "gemini-2.5-flash");
  assert.equal(attachScreenContext, true);
});

test("the vision override is ignored without a screenshot", () => {
  const { config } = panel({ ...panelSettings, ...visionOverride });

  assert.equal(config.scope, "dictationAgent");
});

test("the vision override toggle alone does not redirect without a chosen model", () => {
  const { config, attachScreenContext } = panel(
    { ...panelSettings, useDictationAgentVisionModel: true, dictationAgentVisionMode: "providers" },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgent");
  assert.equal(attachScreenContext, true, "the base scope's own gate decides");
});

test("a vision override that cannot see images drops the screenshot instead of redirecting", () => {
  const { config, attachScreenContext } = panel(
    {
      ...panelSettings,
      ...visionOverride,
      // groq's client is not image-wired in the provider registry.
      dictationAgentVisionProvider: "groq",
      dictationAgentVisionModel: "llama-3.3-70b-versatile",
    },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgent");
  assert.equal(attachScreenContext, false);
});

// The cloud vision-routes screenshot commands itself and the settings tab
// offers no BYOK override while the assistant runs there, so a target chosen
// under another mode stays parked: applying it would redirect the request to
// a provider that may hold no key.
const cloudAssistant = {
  isSignedIn: true,
  dictationAgentMode: "openwhispr",
  dictationAgentCloudMode: "openwhispr",
  dictationAgentProvider: "openwhispr",
  dictationAgentModel: "",
};

test("a configured vision override is inactive while the assistant runs on OpenWhispr Cloud", async () => {
  const { resolveDictationAgentVisionInference } = await load();

  const result = resolveDictationAgentVisionInference(
    { ...panelSettings, ...visionOverride, ...cloudAssistant },
    { isSignedIn: true }
  );

  assert.equal(result.active, false);
});

test("a screenshot command stays on the cloud when the assistant runs there", () => {
  const { config, attachScreenContext } = panel(
    { ...panelSettings, ...visionOverride, ...cloudAssistant },
    { hasScreenContext: true }
  );

  assert.equal(config.scope, "dictationAgent");
  assert.equal(config.mode, "openwhispr");
  assert.equal(attachScreenContext, true, "the cloud keeps the screenshot");
});
