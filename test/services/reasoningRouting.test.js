const test = require("node:test");
const assert = require("node:assert/strict");

const scopes = ["dictationCleanup", "dictationAgent", "noteFormatting", "chatIntelligence"];

test("signed-out local reasoning routes every scope to the local provider", async () => {
  const { resolveReasoningRequest } = await import("../../src/services/reasoningRouting.ts");

  for (const scope of scopes) {
    const result = resolveReasoningRequest({
      isSignedIn: false,
      config: {
        scope,
        mode: "local",
        provider: "qwen",
        model: "qwen3-4b",
        disableThinking: true,
      },
    });

    assert.equal(result.usable, true);
    assert.equal(result.provider, "local");
    assert.equal(result.modelId, "qwen3-4b");
    assert.equal(result.config.provider, "local");
  }
});

test("signed-out provider reasoning routes every scope through BYOK provider config", async () => {
  const { resolveReasoningRequest } = await import("../../src/services/reasoningRouting.ts");

  for (const scope of scopes) {
    const result = resolveReasoningRequest({
      isSignedIn: false,
      config: {
        scope,
        mode: "providers",
        provider: "openai",
        model: "gpt-5-mini",
        cloudBaseUrl: "https://api.openai.com/v1",
        disableThinking: false,
      },
    });

    assert.equal(result.usable, true);
    assert.equal(result.provider, "openai");
    assert.equal(result.modelId, "gpt-5-mini");
    assert.equal(result.config.provider, "openai");
    assert.equal(result.config.baseUrl, "https://api.openai.com/v1");
  }
});

test("signed-in OpenWhispr reasoning keeps the hosted provider route", async () => {
  const { resolveReasoningRequest } = await import("../../src/services/reasoningRouting.ts");

  const result = resolveReasoningRequest({
    isSignedIn: true,
    config: {
      scope: "dictationCleanup",
      mode: "openwhispr",
      provider: "",
      model: "",
      cloudMode: "openwhispr",
      disableThinking: true,
    },
  });

  assert.equal(result.usable, true);
  assert.equal(result.provider, "openwhispr");
  assert.equal(result.modelId, "");
  assert.equal(result.config.provider, "openwhispr");
});

test("signed-out OpenWhispr reasoning returns local and BYOK alternatives", async () => {
  const { resolveReasoningRequest } = await import("../../src/services/reasoningRouting.ts");

  const result = resolveReasoningRequest({
    isSignedIn: false,
    config: {
      scope: "noteFormatting",
      mode: "openwhispr",
      provider: "",
      model: "",
      cloudMode: "openwhispr",
      disableThinking: true,
    },
  });

  assert.equal(result.usable, false);
  assert.equal(result.reason, "account_required_for_hosted");
  assert.deepEqual(result.alternatives, ["local", "providers"]);
});

test("self-hosted reasoning routes through the LAN provider", async () => {
  const { resolveReasoningRequest } = await import("../../src/services/reasoningRouting.ts");

  const result = resolveReasoningRequest({
    isSignedIn: false,
    config: {
      scope: "dictationAgent",
      mode: "self-hosted",
      provider: "",
      model: "qwen",
      remoteUrl: " http://127.0.0.1:11434/v1 ",
      customApiKey: "local-key",
      disableThinking: false,
    },
  });

  assert.equal(result.usable, true);
  assert.equal(result.provider, "lan");
  assert.equal(result.modelId, "qwen");
  assert.equal(result.config.provider, "lan");
  assert.equal(result.config.lanUrl, "http://127.0.0.1:11434/v1");
  assert.equal(result.config.customApiKey, "local-key");
});
