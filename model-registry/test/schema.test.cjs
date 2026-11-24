const test = require("node:test");
const assert = require("node:assert/strict");
const { validateCatalog, acceptCatalog } = require("../lib/schema.cjs");
const { isModelSupported } = require("../lib/registrySelection.js");
const { readCatalog } = require("../lib/catalog.cjs");
const seed = require("./seed.json");

const base = readCatalog();
const openai = (data) => data.cloudProviders.find((p) => p.id === "openai");
const withCloudModel = (model) => {
  const data = structuredClone(base);
  openai(data).models.push({ id: "new-model", name: "New", description: "Fixture", ...model });
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
    const selected = acceptCatalog(data, seed, running);
    assert.equal(openai(selected).models.some((m) => m.id === "new-model"), supported, running);
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
  ])
    assert.equal(isModelSupported({ minAppVersion: minimum }, running), expected);
});

test("a malformed app version hides version-gated models instead of failing", () => {
  const data = withCloudModel({ minAppVersion: "1.0.0" });
  for (const version of ["1.11", "01.2.3", "1.2.3-01", "1.2.3+", "9007199254740992.0.0", undefined]) {
    const selected = acceptCatalog(data, seed, version);
    assert.equal(openai(selected).models.some((m) => m.id === "new-model"), false, version);
    assert.ok(openai(selected).models.length > 0, version);
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
  ])
    assert.throws(() => validateCatalog(withCloudModel({ id })), undefined, id);
  for (const id of ["vendor/model-120b", "anthropic.claude-3-5:0", "org/model-v2.1"])
    assert.doesNotThrow(() => validateCatalog(withCloudModel({ id })), id);
});

test("authoring rejects unknown fields so typos fail review", () => {
  assert.throws(() => validateCatalog(withCloudModel({ supportTemperature: false })), /Unrecognized/);
  const data = structuredClone(base);
  data.whisperModels.base.recomended = true;
  assert.throws(() => validateCatalog(data), /Unrecognized/);
});

test("lifecycle: retired models name an active replacement in the same provider", () => {
  const retire = (fields) => {
    const data = structuredClone(base);
    Object.assign(openai(data).models.find((m) => m.id === "gpt-5.5"), fields);
    return data;
  };
  assert.doesNotThrow(() => validateCatalog(retire({ retired: true })));
  assert.doesNotThrow(() => validateCatalog(retire({ retired: true, replacement: "gpt-6-luna" })));
  for (const [fields, message] of [
    [{ replacement: "gpt-6-luna" }, /not retired/],
    [{ retired: true, legacy: true }, /both legacy and retired/],
    [{ retired: true, replacement: "gpt-5.5" }, /replacement must be an active/],
    [{ retired: true, replacement: "gpt-5-mini" }, /replacement must be an active/],
    [{ retired: true, replacement: "claude-fable-5-1" }, /replacement must be an active/],
  ])
    assert.throws(() => validateCatalog(retire(fields)), message);
});

test("every provider with an active model names an active default", () => {
  const data = structuredClone(base);
  delete openai(data).defaultModel;
  assert.throws(() => validateCatalog(data), /must name its defaultModel/);
  openai(data).defaultModel = "gpt-5-mini";
  assert.throws(() => validateCatalog(data), /default must be an active model/);
  openai(data).defaultModel = "claude-fable-5-1";
  assert.throws(() => validateCatalog(data), /default must be an active model/);
  const azure = data.enterpriseProviders.find((p) => p.id === "azure");
  assert.equal(azure.models.length, 0);
  assert.equal(azure.defaultModel, undefined);
});

test("tokenParam needs an explicit temperature setting", () => {
  assert.throws(
    () => validateCatalog(withCloudModel({ tokenParam: "max_completion_tokens" })),
    /without supportsTemperature/
  );
  assert.doesNotThrow(() =>
    validateCatalog(withCloudModel({ tokenParam: "max_completion_tokens", supportsTemperature: false }))
  );
});

test("a repeated cloud ID inherits or matches the first entry's request settings", () => {
  const data = structuredClone(base);
  const vertex = data.enterpriseProviders.find((p) => p.id === "vertex");
  const flash = vertex.models.find((m) => m.id === "gemini-3.8-flash");
  assert.doesNotThrow(() => validateCatalog(data));
  flash.supportsThinking = false;
  assert.throws(() => validateCatalog(data), /share an ID but not request settings/);
  const gemini = data.cloudProviders.find((p) => p.id === "gemini");
  Object.assign(flash, structuredClone(gemini.models.find((m) => m.id === "gemini-3.8-flash")));
  assert.doesNotThrow(() => validateCatalog(data));
});

test("thinking floors and reasoning levels are data", () => {
  assert.doesNotThrow(() => validateCatalog(withCloudModel({ thinkingFloor: { level: "low" } })));
  assert.doesNotThrow(() => validateCatalog(withCloudModel({ thinkingFloor: { budget: 0 } })));
  assert.throws(() => validateCatalog(withCloudModel({ thinkingFloor: { level: "max" } })));
  assert.throws(() =>
    validateCatalog(withCloudModel({ reasoningEffort: { options: ["ultra"] } }))
  );
});

test("downloadable files must be the type their engine loads", () => {
  const whisper = structuredClone(base);
  whisper.whisperModels.base.fileName = "model.txt";
  assert.throws(() => validateCatalog(whisper), /ggml-\*\.bin/);
  const gguf = structuredClone(base);
  gguf.localProviders[0].models[0].fileName = "model.txt";
  assert.throws(() => validateCatalog(gguf), /\.gguf/);
  const archive = structuredClone(base);
  archive.parakeetModels["parakeet-tdt-0.6b-v3"].downloadUrl =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model.zip";
  assert.throws(() => validateCatalog(archive), /tar\.bz2/);
});

test("duplicate model IDs, colliding files and malformed metadata fail authoring", () => {
  const duplicate = structuredClone(base);
  openai(duplicate).models.push(structuredClone(openai(duplicate).models[0]));
  assert.throws(() => validateCatalog(duplicate), /Duplicate model/);
  const collision = structuredClone(base);
  collision.localProviders[1].models[0].fileName =
    collision.localProviders[0].models[0].fileName.toUpperCase().replace(".GGUF", ".gguf");
  assert.throws(() => validateCatalog(collision), /Colliding/);
  const alias = structuredClone(base);
  alias.parakeetModels["PARAKEET-TDT-0.6B-V3"] = structuredClone(
    alias.parakeetModels["parakeet-tdt-0.6b-v3"]
  );
  assert.throws(() => validateCatalog(alias), /Ambiguous local model ID/);
  const malformed = structuredClone(base);
  openai(malformed).models[0].supportsTemperature = "true";
  assert.throws(() => validateCatalog(malformed));
  for (const value of ["../evil.bin", "..\\evil.bin", "C:evil.bin", "CON", "bad.bin."]) {
    const data = structuredClone(base);
    data.whisperModels.base.fileName = value;
    assert.throws(() => validateCatalog(data), undefined, value);
  }
  for (const url of [
    "http://huggingface.co/example/model/resolve/main/ggml-new.bin",
    "https://attacker.example/ggml-new.bin",
    "https://huggingface.co@example.com/ggml-new.bin",
  ]) {
    const data = structuredClone(base);
    data.whisperModels.base.downloadUrl = url;
    assert.throws(() => validateCatalog(data), undefined, url);
  }
});

test("a local or transcription ID belongs to one provider; nested objects stay strict to write", () => {
  const local = structuredClone(base);
  local.localProviders[1].models.push({
    ...structuredClone(local.localProviders[0].models[0]),
    fileName: "elsewhere.gguf",
  });
  assert.throws(() => validateCatalog(local), /Ambiguous model ID/);
  const transcription = structuredClone(base);
  const groq = transcription.transcriptionProviders.find((p) => p.id === "groq");
  groq.models.push({ ...structuredClone(transcription.transcriptionProviders[0].models[0]) });
  assert.throws(() => validateCatalog(transcription), /Ambiguous model ID/);
  assert.throws(
    () => validateCatalog(withCloudModel({ reasoningEffort: { options: ["low"], defualtValue: "low" } })),
    /Unrecognized/
  );
  assert.throws(() => validateCatalog(withCloudModel({ thinkingFloor: { level: "low", budget: 0 } })));
});

test("the app reader drops unknown nested fields instead of the whole entry", () => {
  const data = structuredClone(base);
  const [id] = Object.keys(data.parakeetModels).filter((key) => data.parakeetModels[key].organization);
  data.parakeetModels[id].organization.website = "https://example.com";
  const accepted = acceptCatalog(data, seed, "1.12.0");
  assert.deepEqual(accepted.parakeetModels[id].organization, base.parakeetModels[id].organization);
});
