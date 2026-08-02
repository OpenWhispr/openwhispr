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

const cliSettings = {
  useDictationAgent: true,
  dictationAgentMode: "cli",
  dictationAgentProvider: "codex",
  dictationAgentModel: "",
  cliAgentPermissionMode: "bypass",
  cliAgentWorkingDir: "/work",
  cliAgentTimeoutSeconds: 120,
  cliAgentSessionMinutes: 10,
  cliAgentExtraPrompt: "be terse",
};

test("cli mode: reachable with empty model and carries cli config", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(cliSettings, { isCloudAgent: false });

  assert.equal(result.reachable, true);
  assert.equal(result.config.provider, "codex");
  assert.equal(result.config.cliPermissionMode, "bypass");
  assert.equal(result.config.cliWorkingDir, "/work");
  assert.equal(result.config.cliTimeoutSeconds, 120);
  assert.equal(result.config.cliSessionMinutes, 10);
  assert.equal(result.config.cliExtraPrompt, "be terse");
});

test("cli mode: provider defaults to claude-code when unset", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(
    { ...cliSettings, dictationAgentProvider: "" },
    { isCloudAgent: false }
  );

  assert.equal(result.config.provider, "claude-code");
});

test("non-cli mode: no cli fields in config", async () => {
  const { resolveDictationAgentInference } = await load();

  const result = resolveDictationAgentInference(
    {
      useDictationAgent: true,
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5-mini",
    },
    { isCloudAgent: false }
  );

  assert.equal(result.config.cliPermissionMode, undefined);
});
