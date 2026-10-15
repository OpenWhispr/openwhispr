const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateCatalog,
  assertCompatibleCatalog,
  selectCatalog,
} = require("../../src/models/registrySchema.cjs");
const { isModelSupported } = require("../../src/models/registrySelection.js");
const seed = require("../../src/models/modelRegistryData.json");

const withCloudModel = (model) => {
  const data = structuredClone(seed);
  data.cloudProviders[0].models.push({
    id: "new-model",
    name: "New",
    description: "Fixture",
    ...model,
  });
  return data;
};

test("prerelease desktop versions initialize with SemVer-compatible selection", () => {
  const data = withCloudModel({ minAppVersion: "1.11.0" });
  for (const [running, supported] of [
    ["1.11.0-beta.1", false],
    ["1.11.0-rc.10+build.123", false],
    ["1.11.0+build.123", true],
    ["1.11.1-beta.1", true],
    ["2.0.0-alpha", true],
  ]) {
    const selected = selectCatalog(data, {}, running);
    assert.equal(
      selected.cloudProviders[0].models.some((m) => m.id === "new-model"),
      supported,
      running
    );
    assert.equal(
      isModelSupported(data.cloudProviders[0].models.at(-1), running),
      supported,
      running
    );
  }
});

test("prerelease minimum versions use numeric identifiers and ignore build metadata", () => {
  for (const [minimum, running, expected] of [
    ["1.11.0-beta.2", "1.11.0-beta.10", true],
    ["1.11.0-beta.10", "1.11.0-beta.2", false],
    ["1.11.0-alpha", "1.11.0-alpha.1", true],
    ["1.11.0-alpha.1", "1.11.0-alpha", false],
    ["1.11.0-1", "1.11.0-alpha", true],
    ["1.11.0-beta+one", "1.11.0-beta+two", true],
    ["1.11.0-beta", "1.11.0", true],
  ]) {
    const data = withCloudModel({ minAppVersion: minimum });
    assert.equal(
      selectCatalog(data, {}, running).cloudProviders[0].models.at(-1).id === "new-model",
      expected
    );
    assert.equal(isModelSupported({ minAppVersion: minimum }, running), expected);
  }
  for (const version of [
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-beta..1",
    "1.2.3+",
    "9007199254740992.0.0",
  ]) {
    assert.throws(() => selectCatalog(seed, {}, version), undefined, version);
    assert.equal(isModelSupported({ minAppVersion: "1.0.0" }, version), false, version);
  }
});

test("model IDs reject unsafe path segments without losing supported provider IDs", () => {
  for (const id of [
    "gemini/..",
    "gemini/../models",
    "gemini/./model",
    "gemini//model",
    "gemini/",
    "C:/model",
    "gemini\\model",
    "gemini/%2e%2e/model",
  ]) {
    assert.throws(() => validateCatalog(withCloudModel({ id })), undefined, id);
  }
  for (const id of [
    "openai/gpt-oss-120b",
    "anthropic.claude-3-5:0",
    "org/model-v2.1",
    "gemini-2.5-flash",
  ]) {
    assert.doesNotThrow(() => validateCatalog(withCloudModel({ id })));
  }
  assert.doesNotThrow(() => validateCatalog(seed));
});

function newLocal() {
  const data = structuredClone(seed);
  const model = structuredClone(data.localProviders[0].models[0]);
  for (const field of ["draftHfRepo", "draftFileName", "draftSizeBytes", "draftSha256"])
    delete model[field];
  data.localProviders[0].models.push({
    ...model,
    id: "new-local",
    fileName: "new-local.gguf",
    sha256: "a".repeat(64),
  });
  return data;
}

test("new GGUF artifacts require immutable revisions and retain native identity locks", () => {
  const data = newLocal();
  const model = data.localProviders[0].models.at(-1);
  assert.throws(() => assertCompatibleCatalog(data, seed), /revision/i);
  model.revision = "b".repeat(40);
  assert.doesNotThrow(() => assertCompatibleCatalog(data, seed));
  model.draftHfRepo = model.hfRepo;
  model.draftFileName = "new-local-draft.gguf";
  model.draftSizeBytes = 100;
  model.draftSha256 = "c".repeat(64);
  assert.throws(() => assertCompatibleCatalog(data, seed), /revision/i);
  model.draftRevision = "d".repeat(40);
  assert.doesNotThrow(() => assertCompatibleCatalog(data, seed));
  const changed = structuredClone(data);
  changed.localProviders[0].models.at(-1).revision = "e".repeat(40);
  assert.throws(() => assertCompatibleCatalog(changed, data), /identity/);
  for (const revision of ["main", "v1.0", "a".repeat(39), "A".repeat(40)]) {
    model.revision = revision;
    assert.throws(() => validateCatalog(data), undefined, revision);
  }
  assert.doesNotThrow(() => assertCompatibleCatalog(seed, seed));
});

test("new direct Hugging Face downloads require a commit URL", () => {
  const data = structuredClone(seed);
  data.whisperModels["new-whisper"] = {
    ...data.whisperModels.base,
    fileName: "new-whisper.bin",
    downloadUrl: "https://huggingface.co/org/repo/resolve/main/model.bin",
    sha256: "a".repeat(64),
  };
  assert.throws(() => assertCompatibleCatalog(data, seed), /revision/i);
  data.whisperModels["new-whisper"].downloadUrl =
    `https://huggingface.co/org/repo/resolve/${"b".repeat(40)}/model.bin`;
  assert.doesNotThrow(() => assertCompatibleCatalog(data, seed));
});

test("published native revisions cannot be added, removed, or changed in place", () => {
  const legacyChange = structuredClone(seed);
  legacyChange.localProviders[0].models[0].revision = "a".repeat(40);
  assert.throws(() => assertCompatibleCatalog(legacyChange, seed), /identity/);
  const published = newLocal();
  published.localProviders[0].models.at(-1).revision = "a".repeat(40);
  const removed = structuredClone(published);
  delete removed.localProviders[0].models.at(-1).revision;
  assert.throws(() => assertCompatibleCatalog(removed, published), /identity/);
  const incomplete = structuredClone(seed);
  incomplete.localProviders[0].models.push({
    ...published.localProviders[0].models.at(-1),
    draftRevision: "b".repeat(40),
  });
  assert.throws(() => validateCatalog(incomplete), /Incomplete draft artifact/);
});
