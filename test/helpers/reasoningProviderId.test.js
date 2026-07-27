const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/reasoningProviderId.js");

// Mirrors the ids in modelRegistryData.json -> localProviders.
const LOCAL_PROVIDER_IDS = ["qwen", "mistral", "llama", "openai-oss", "gemma", "liquidai"];

test("every local vendor id normalizes to the local provider", async () => {
  const { normalizeReasoningProviderId } = await load();

  for (const vendor of LOCAL_PROVIDER_IDS) {
    assert.equal(
      normalizeReasoningProviderId(vendor, LOCAL_PROVIDER_IDS),
      "local",
      `${vendor} should map to "local"`
    );
  }
});

test("real provider ids pass through untouched", async () => {
  const { normalizeReasoningProviderId } = await load();

  for (const provider of [
    "openai",
    "anthropic",
    "gemini",
    "groq",
    "openwhispr",
    "lan",
    "local",
    "custom",
    "openrouter",
    "bedrock",
  ]) {
    assert.equal(normalizeReasoningProviderId(provider, LOCAL_PROVIDER_IDS), provider);
  }
});

test("an empty provider is left alone so callers can fall back", async () => {
  const { normalizeReasoningProviderId } = await load();

  assert.equal(normalizeReasoningProviderId("", LOCAL_PROVIDER_IDS), "");
  assert.equal(normalizeReasoningProviderId(undefined, LOCAL_PROVIDER_IDS), undefined);
});

test("an unknown provider is not silently rewritten", async () => {
  const { normalizeReasoningProviderId } = await load();

  // Better to surface "Unsupported reasoning provider: totally-made-up" than to
  // guess wrong and route the request somewhere it does not belong.
  assert.equal(
    normalizeReasoningProviderId("totally-made-up", LOCAL_PROVIDER_IDS),
    "totally-made-up"
  );
});

test("defaults to no local ids when the list is omitted", async () => {
  const { normalizeReasoningProviderId } = await load();

  assert.equal(normalizeReasoningProviderId("llama"), "llama");
});
