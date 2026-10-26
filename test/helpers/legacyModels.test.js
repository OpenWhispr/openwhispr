const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");

const load = () => import("../../src/models/legacyModels.ts");

// Pickers hide legacy models, but a provider's default still comes from its
// list (pickProviderDefaultModel: the named default, else the first entry), so
// a new user must never land on one.
test("no provider defaults to a legacy model", () => {
  const providers = [
    ...modelData.cloudProviders,
    ...modelData.enterpriseProviders,
    ...modelData.transcriptionProviders,
  ].filter((provider) => provider.models.length > 0);
  for (const provider of providers) {
    const defaultId = provider.defaultModel ?? provider.models[0].id;
    const model = provider.models.find((entry) => entry.id === defaultId);
    assert.ok(model, `${provider.id} default ${defaultId} is listed`);
    assert.notEqual(model.legacy, true, `${provider.id} defaults to legacy ${defaultId}`);
  }
});

test("no legacy model is recommended", () => {
  const models = [
    ...modelData.cloudProviders.flatMap((provider) => provider.models),
    ...modelData.enterpriseProviders.flatMap((provider) => provider.models),
    ...modelData.transcriptionProviders.flatMap((provider) => provider.models),
    ...modelData.localProviders.flatMap((provider) => provider.models),
    ...Object.values(modelData.whisperModels),
    ...Object.values(modelData.parakeetModels),
  ];
  for (const model of models) {
    if (model.legacy) assert.notEqual(model.recommended, true, model.id ?? model.name);
  }
});

test("a legacy model is listed only while selected or still downloaded", async () => {
  const { isListedModel } = await load();
  assert.equal(isListedModel({}, false), true);
  assert.equal(isListedModel({ legacy: true }, false), false);
  assert.equal(isListedModel({ legacy: true }, false, false), false);
  assert.equal(isListedModel({ legacy: true }, true), true);
  assert.equal(isListedModel({ legacy: true }, false, true), true);
});
