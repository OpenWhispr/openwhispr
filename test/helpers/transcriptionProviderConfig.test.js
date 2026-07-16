const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionProviderConfig.js");
const EMPTY = { base: {}, meeting: {}, upload: {} };

test("switching away and back preserves a custom provider's config (regression: Parasail wiped by Tinfoil)", async () => {
  const { swapTranscriptionProviderConfig } = await load();

  const toTinfoil = swapTranscriptionProviderConfig({
    configs: EMPTY,
    scope: "base",
    fromProvider: "custom",
    fromModel: "open64qlxjh2-whisper-large-v3",
    fromBaseUrl: "https://api.parasail.io/v1",
    toProvider: "tinfoil",
  });
  assert.equal(toTinfoil.model, "");
  assert.equal(toTinfoil.baseUrl, "");

  const backToCustom = swapTranscriptionProviderConfig({
    configs: toTinfoil.configs,
    scope: "base",
    fromProvider: "tinfoil",
    fromModel: "tinfoil-whisper",
    fromBaseUrl: "",
    toProvider: "custom",
  });
  assert.equal(backToCustom.model, "open64qlxjh2-whisper-large-v3");
  assert.equal(backToCustom.baseUrl, "https://api.parasail.io/v1");

  const backToTinfoil = swapTranscriptionProviderConfig({
    configs: backToCustom.configs,
    scope: "base",
    fromProvider: "custom",
    fromModel: backToCustom.model,
    fromBaseUrl: backToCustom.baseUrl,
    toProvider: "tinfoil",
  });
  assert.equal(backToTinfoil.model, "tinfoil-whisper");
});

test("first-time selection of a provider restores nothing", async () => {
  const { swapTranscriptionProviderConfig } = await load();
  const result = swapTranscriptionProviderConfig({
    configs: EMPTY,
    scope: "base",
    fromProvider: "openai",
    fromModel: "gpt-4o-mini-transcribe",
    fromBaseUrl: "",
    toProvider: "groq",
  });
  assert.equal(result.model, "");
  assert.equal(result.baseUrl, "");
  assert.deepEqual(result.configs.base.openai, { model: "gpt-4o-mini-transcribe" });
});

test("scopes are independent and empty values are not remembered", async () => {
  const { swapTranscriptionProviderConfig } = await load();
  const result = swapTranscriptionProviderConfig({
    configs: { ...EMPTY, base: { custom: { baseUrl: "http://localhost:1" } } },
    scope: "upload",
    fromProvider: "custom",
    fromModel: "  ",
    fromBaseUrl: "https://upload.example/v1",
    toProvider: "openai",
  });
  assert.deepEqual(result.configs.upload.custom, { baseUrl: "https://upload.example/v1" });
  assert.deepEqual(result.configs.base.custom, { baseUrl: "http://localhost:1" });
  assert.equal("model" in result.configs.upload.custom, false);
});
