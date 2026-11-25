const test = require("node:test");
const assert = require("node:assert/strict");
const { rollbackCatalog } = require("../lib/rollback.cjs");
const { assertCompatibleCatalog, validateCatalog } = require("../lib/schema.cjs");
const { readCatalog } = require("../lib/catalog.cjs");

const base = readCatalog();
const openai = (data) => data.cloudProviders.find((p) => p.id === "openai");

test("rolling back keeps retirements and shelves what was added since, reversibly", () => {
  const current = structuredClone(base);
  openai(current).models.push({ id: "bad-add", name: "Bad", description: "Fixture" });
  openai(current).defaultModel = "bad-add";
  Object.assign(openai(current).models.find((m) => m.id === "gpt-5.5"), {
    retired: true,
    replacement: "gpt-6-luna",
  });
  current.whisperModels["bad-whisper"] = {
    ...structuredClone(current.whisperModels.base),
    fileName: "ggml-bad.bin",
  };
  const rolled = rollbackCatalog(base, current);
  assert.doesNotThrow(() => validateCatalog(rolled));
  assert.doesNotThrow(() => assertCompatibleCatalog(rolled, current));
  const models = openai(rolled).models;
  assert.equal(models.find((m) => m.id === "bad-add").legacy, true);
  assert.equal(models.find((m) => m.id === "bad-add").retired, undefined);
  assert.equal(models.find((m) => m.id === "gpt-5.5").replacement, "gpt-6-luna");
  assert.equal(openai(rolled).defaultModel, openai(base).defaultModel);
  assert.equal(rolled.whisperModels["bad-whisper"].legacy, true);
  assert.doesNotThrow(
    () => assertCompatibleCatalog(current, rolled),
    "the fixed main can publish the shelved models again"
  );
});

test("a provider added since the target comes back at the end, its models shelved", () => {
  const current = structuredClone(base);
  current.transcriptionProviders.push({
    id: "newprovider",
    name: "New",
    baseUrl: "https://new.example/v1",
    models: [{ id: "new/model", name: "New", description: "Fixture", minAppVersion: "1.11.1" }],
    defaultModel: "new/model",
  });
  const rolled = rollbackCatalog(base, current);
  assert.doesNotThrow(() => validateCatalog(rolled));
  assert.doesNotThrow(() => assertCompatibleCatalog(rolled, current));
  const added = rolled.transcriptionProviders.at(-1);
  assert.equal(added.id, "newprovider");
  assert.equal(added.models[0].legacy, true);
  assert.doesNotThrow(
    () => assertCompatibleCatalog(current, rolled),
    "the fixed main can publish the provider again"
  );
});

test("a rollback drops a Whisper replacement that only exists after the target", () => {
  const current = structuredClone(base);
  current.whisperModels["large-v9"] = {
    ...structuredClone(current.whisperModels.base),
    fileName: "ggml-large-v9.bin",
  };
  Object.assign(current.whisperModels.base, { retired: true, replacement: "large-v9" });
  const rolled = rollbackCatalog(base, current);
  assert.equal(rolled.whisperModels.base.retired, true);
  assert.equal(rolled.whisperModels.base.replacement, undefined);
  assert.doesNotThrow(() => validateCatalog(rolled));
  assert.doesNotThrow(() => assertCompatibleCatalog(rolled, current));
});
