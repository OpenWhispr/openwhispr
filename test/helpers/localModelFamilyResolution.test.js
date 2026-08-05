const test = require("node:test");
const assert = require("node:assert/strict");

const { MainProcessInference } = require("../../src/helpers/mainProcessInference.js");
const registry = require("../../src/models/modelRegistryData.json");

// MainProcessInference recovers when a model family has been written into the
// provider field. Its family list drifted from the registry — it missed
// "openai-oss" and "liquidai" and carried "phi"/"gpt-oss", which are not
// families — so the safety net failed for exactly the values it exists for.
test("every local family in the registry resolves to the local provider", () => {
  for (const provider of registry.localProviders) {
    assert.equal(
      MainProcessInference.resolveProvider(provider.id, ""),
      "local",
      `provider field "${provider.id}" should resolve to "local"`
    );
  }
});

test("a real provider is not rewritten by the family safety net", () => {
  for (const provider of MainProcessInference.SUPPORTED_PROVIDERS) {
    assert.equal(MainProcessInference.resolveProvider(provider, ""), provider);
  }
});

test("an unrecognised provider is left as-is so the error names it", () => {
  assert.equal(MainProcessInference.resolveProvider("phi", ""), "phi");
  assert.equal(MainProcessInference.resolveProvider("gpt-oss", ""), "gpt-oss");
});
