const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationAgentInference.js");

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
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference({
    ...baseSettings,
    // Cleanup is configured completely differently; it must not leak through.
    cleanupProvider: "openai",
    cleanupModel: "gpt-4.1-mini",
  });

  assert.equal(result.model, "llama-3.1-8b-instruct-q4_k_m");
  assert.equal(result.config.provider, "llama");
});

test("a local agent is unreachable without an explicit model", async () => {
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
    { ...baseSettings, dictationAgentModel: "" },
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

  // Reproduction from the report: a provider left behind by a previous
  // configuration must not send a local-mode agent request to a cloud API.
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
    dictationAgentRemoteUrl: "",
  });

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

test("cloud agent mode overrides the stored provider regardless of mode", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(
    { ...baseSettings, dictationAgentMode: "local", dictationAgentProvider: "openai" },
    { isCloudAgent: true }
  );

  assert.equal(result.config.provider, "openwhispr");
});
