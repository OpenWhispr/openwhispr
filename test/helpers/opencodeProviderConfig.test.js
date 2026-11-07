const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OPENCODE_PROVIDERS,
  getOpencodeProvider,
  isOpencodeProvider,
  opencodeHeaders,
} = require("../../src/helpers/opencodeProviderConfig");
const { resolveProviderRequest } = require("../../src/helpers/providerConnectionTest");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
const { isSelectableOpencodeModelId } = require("../../src/config/opencodeModelPolicy.js");
const modelData = require("../../src/models/modelRegistryData.json");

// OpenCode Go and Zen are separate subscriptions on one host, so the two ids
// must never collapse into one entry: each needs its own base URL and key.

test("Go and Zen are distinct providers on distinct bases", () => {
  const go = getOpencodeProvider("opencode-go");
  const zen = getOpencodeProvider("opencode-zen");

  assert.equal(go.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(zen.baseUrl, "https://opencode.ai/zen/v1");
  assert.notEqual(go.baseUrl, zen.baseUrl);
  assert.notEqual(go.keyGetter, zen.keyGetter);
});

test("each provider id has its own key manifest entry and env var", () => {
  for (const provider of Object.values(OPENCODE_PROVIDERS)) {
    const entry = BYOK_API_KEYS.find((key) => key.get === provider.keyGetter);
    assert.ok(entry, `${provider.id} has a BYOK key entry`);
    assert.ok(entry.env.startsWith("OPENCODE_"), `${provider.id} uses an OPENCODE_ env var`);
    assert.ok(entry.storeKey, `${provider.id} has a settings store key`);
  }

  const envs = Object.values(OPENCODE_PROVIDERS).map(
    (provider) => BYOK_API_KEYS.find((key) => key.get === provider.keyGetter).env
  );
  assert.equal(new Set(envs).size, envs.length, "the two providers share no env var");
});

test("the connection check probes the configured base URL", () => {
  // Drift here would test a key against one host while real requests go to another.
  for (const provider of Object.values(OPENCODE_PROVIDERS)) {
    const request = resolveProviderRequest({ provider: provider.id, apiKey: "sk-test" });
    assert.equal(request.endpoint, `${provider.baseUrl}/models`, provider.id);
  }
});

test("only Go carries the per-conversation session header", () => {
  assert.deepEqual(opencodeHeaders("opencode-go", { randomUUID: () => "fixed-id" }), {
    "x-opencode-session": "fixed-id",
  });
  assert.deepEqual(opencodeHeaders("opencode-zen", { randomUUID: () => "fixed-id" }), {});
});

test("a chat turn's session id is reused instead of minted per request", () => {
  // Every tool step of one turn must read as the same conversation to Go.
  assert.deepEqual(
    opencodeHeaders("opencode-go", { sessionId: "turn-id", randomUUID: () => "fresh" }),
    {
      "x-opencode-session": "turn-id",
    }
  );
  // Zen ignores the header even when a caller supplies one.
  assert.deepEqual(opencodeHeaders("opencode-zen", { sessionId: "turn-id" }), {});
});

test("an unknown or missing provider is refused", () => {
  assert.equal(isOpencodeProvider("opencode-go"), true);
  assert.equal(isOpencodeProvider("opencode"), false);
  assert.equal(isOpencodeProvider(undefined), false);
  assert.throws(() => getOpencodeProvider("opencode"), /Unsupported OpenCode provider/);
});

test("both providers are selectable and their seed lists default to a listed model", () => {
  for (const id of Object.keys(OPENCODE_PROVIDERS)) {
    const provider = modelData.cloudProviders.find((entry) => entry.id === id);
    assert.ok(provider, `${id} is in the model registry`);
    assert.ok(provider.models.length > 0, `${id} seeds at least one model`);
    assert.ok(
      provider.models.some((model) => model.id === provider.defaultModel),
      `${id} defaults to a seeded model`
    );
  }
});

test("the offline seed holds only models the live list would offer", () => {
  // Once OpenCode can be reached the picker shows its live list instead, but
  // offline this seed is all there is, so it must pass the same policy.
  for (const id of Object.keys(OPENCODE_PROVIDERS)) {
    const provider = modelData.cloudProviders.find((entry) => entry.id === id);
    for (const model of provider.models) {
      assert.equal(isSelectableOpencodeModelId(model.id), true, `${id} seeds ${model.id}`);
      assert.equal(
        typeof model.supportsTemperature,
        "boolean",
        `${id}/${model.id} states temperature`
      );
    }
  }
});
