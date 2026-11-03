const test = require("node:test");
const assert = require("node:assert/strict");

const {
  OPENCODE_PROVIDERS,
  getOpencodeProvider,
  isOpencodeProvider,
  opencodeHeaders,
} = require("../../src/helpers/opencodeProviderConfig");
const { BYOK_API_KEYS } = require("../../src/config/secretKeys");
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

test("only Go carries the per-conversation session header", () => {
  assert.deepEqual(
    opencodeHeaders("opencode-go", () => "fixed-id"),
    {
      "x-opencode-session": "fixed-id",
    }
  );
  assert.deepEqual(
    opencodeHeaders("opencode-zen", () => "fixed-id"),
    {}
  );
});

test("an unknown or missing provider is refused", () => {
  assert.equal(isOpencodeProvider("opencode-go"), true);
  assert.equal(isOpencodeProvider("opencode"), false);
  assert.equal(isOpencodeProvider(undefined), false);
  assert.throws(() => getOpencodeProvider("opencode"), /Unsupported OpenCode provider/);
});

test("both providers are selectable and have a handler and models", () => {
  for (const id of Object.keys(OPENCODE_PROVIDERS)) {
    const provider = modelData.cloudProviders.find((entry) => entry.id === id);
    assert.ok(provider, `${id} is in the model registry`);
    assert.ok(provider.models.length > 0, `${id} lists at least one model`);
    assert.ok(
      provider.models.some((model) => model.id === provider.defaultModel),
      `${id} defaults to a listed model`
    );
  }
});

test("free and contributor tiers stay out of the catalog", () => {
  // Those tiers may log prompts or train on them. The app dictates private
  // speech, so only paid tiers are offered.
  for (const id of Object.keys(OPENCODE_PROVIDERS)) {
    const provider = modelData.cloudProviders.find((entry) => entry.id === id);
    const exposed = provider.models.filter(
      (model) => model.id.endsWith("-free") || model.id.includes("contributor")
    );
    assert.deepEqual(
      exposed.map((model) => model.id),
      [],
      `${id} lists no free tier`
    );
  }
});
