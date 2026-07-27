const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/promptTestConfig.js");

const baseSettings = {
  useDictationAgent: true,
  dictationAgentMode: "providers",
  dictationAgentProvider: "llama",
  dictationAgentModel: "llama-3.1-8b-instruct-q4_k_m",
  dictationAgentRemoteUrl: "",
  dictationAgentCloudBaseUrl: "",
  dictationAgentCustomApiKey: "",
  dictationAgentDisableThinking: true,
};

test("uses the dictation agent scope, not the cleanup scope", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
    ...baseSettings,
    // Cleanup is configured completely differently; it must not leak through.
    cleanupProvider: "openai",
    cleanupModel: "gpt-4.1-mini",
  });

  assert.equal(result.model, "llama-3.1-8b-instruct-q4_k_m");
  assert.equal(result.config.provider, "llama");
});

test("a local agent is unreachable without an explicit model", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
    ...baseSettings,
    dictationAgentModel: "",
  });

  assert.equal(result.enabled, true);
  assert.equal(result.reachable, false);
});

test("self-hosted is reachable with no model and forwards the LAN url", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
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

test("cloud is reachable with no model and falls back to auto", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig(
    { ...baseSettings, dictationAgentModel: "" },
    { isCloudAgent: true }
  );

  assert.equal(result.reachable, true);
  assert.equal(result.model, "auto");
  assert.equal(result.config.provider, "openwhispr");
});

test("a custom provider forwards its base url and api key", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
    ...baseSettings,
    dictationAgentProvider: "custom",
    dictationAgentCloudBaseUrl: "https://example.test/v1",
    dictationAgentCustomApiKey: "sk-test",
  });

  assert.equal(result.config.baseUrl, "https://example.test/v1");
  assert.equal(result.config.customApiKey, "sk-test");
});

test("a non-custom provider leaks neither base url nor api key", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
    ...baseSettings,
    dictationAgentCloudBaseUrl: "https://example.test/v1",
    dictationAgentCustomApiKey: "sk-test",
  });

  assert.equal(result.config.baseUrl, undefined);
  assert.equal(result.config.customApiKey, undefined);
});

test("a disabled agent is neither enabled nor reachable", async () => {
  const { resolveDictationAgentTestConfig } = await load();

  const result = resolveDictationAgentTestConfig({
    ...baseSettings,
    useDictationAgent: false,
  });

  assert.equal(result.enabled, false);
  assert.equal(result.reachable, false);
});
