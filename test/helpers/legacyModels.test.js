const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

// Pickers hide legacy models, but a provider's default still comes from its
// list (pickProviderDefaultModel: the named default, else the first entry), so
// a new user must never land on one.
test("no provider with a current model defaults to a legacy one", async () => {
  const { pickProviderDefaultModel } = await import("../../src/models/providerDefaultModel.ts");
  const providers = [
    ...modelData.cloudProviders,
    ...modelData.enterpriseProviders,
    ...modelData.transcriptionProviders,
    ...modelData.localProviders,
  ].filter((provider) => provider.models.some((model) => !model.legacy));
  for (const provider of providers) {
    const model = pickProviderDefaultModel(provider.models, provider.defaultModel);
    assert.notEqual(model.legacy, true, `${provider.id} defaults to legacy ${model.id}`);
  }
});

test("no legacy model is recommended", () => {
  const models = [
    ...modelData.cloudProviders.flatMap((provider) => provider.models),
    ...modelData.enterpriseProviders.flatMap((provider) => provider.models),
    ...modelData.transcriptionProviders.flatMap((provider) => provider.models),
    ...modelData.localProviders.flatMap((provider) => provider.models),
  ];
  for (const model of models) {
    if (model.legacy) assert.notEqual(model.recommended, true, model.id);
  }
});

// The Whisper and Parakeet pickers don't read the flag, so marking one legacy
// would silently keep offering it to everyone.
test("no local speech-to-text model is legacy until its pickers honor the flag", () => {
  for (const [id, model] of Object.entries({
    ...modelData.whisperModels,
    ...modelData.parakeetModels,
  })) {
    assert.notEqual(model.legacy, true, id);
  }
});

test("a legacy model is listed only while selected or still downloaded", async () => {
  const { isListedModel } = await import("../../src/models/legacyModels.ts");
  assert.equal(isListedModel({}, false), true);
  assert.equal(isListedModel({ legacy: true }, false), false);
  assert.equal(isListedModel({ legacy: true }, true), true);
  assert.equal(isListedModel({ legacy: true }, false, true), true);
});
