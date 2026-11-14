const test = require("node:test");
const assert = require("node:assert/strict");

test("Mistral is offered for notes and resolves to its direct BYOK client", async () => {
  const {
    getMeetingStreamingTranscriptionProviders,
    getDictationTranscriptionProviders,
    getUploadTranscriptionProviders,
  } = await import("../../src/models/ModelRegistry.ts");
  const { resolveMeetingTranscriptionOptions } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");
  const { getMeetingStreamingClient } = require("../../src/helpers/meetingStreamingProviders");
  const providers = getMeetingStreamingTranscriptionProviders();
  const mistral = providers.find((p) => p.id === "mistral");
  const { i18nMain } = require("../../src/helpers/i18nMain");
  assert.equal(
    i18nMain.t(mistral.models[0].descriptionKey, { lng: "fr" }),
    "Transcription de réunions en direct avec Mistral"
  );
  assert.deepEqual(
    mistral.models.map((m) => m.id),
    ["voxtral-mini-transcribe-realtime-3"]
  );
  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      transcriptionMode: "providers",
      selectedProvider: "mistral",
      selectedModel: "voxtral-mini-latest",
      byokProviders: providers,
      language: "fr",
    }),
    {
      provider: "mistral-realtime",
      model: "voxtral-mini-transcribe-realtime-3",
      mode: "byok",
      language: "fr",
    }
  );
  assert.equal(
    getMeetingStreamingClient("mistral-realtime"),
    require("../../src/helpers/mistralRealtimeStreaming")
  );
  for (const list of [getDictationTranscriptionProviders(), getUploadTranscriptionProviders()]) {
    const provider = list.find((p) => p.id === "mistral");
    assert.ok(provider.models.some((m) => m.id === "voxtral-mini-latest"));
    assert.ok(!provider.models.some((m) => m.streaming));
  }
});

test("Mistral realtime survives a catalog refresh without changing batch defaults", () => {
  const { acceptCatalog } = require("../../src/models/registrySchema.cjs");
  const { bundledRegistryData } = require("../../src/models/registryData.js");
  const {
    withAppTranscriptionProviders,
  } = require("../../src/models/appTranscriptionProviders.js");
  const vendored = require("../../src/models/modelRegistryData.json");
  const model = "voxtral-mini-transcribe-realtime-3";
  for (const catalog of [
    acceptCatalog(vendored, bundledRegistryData, "1.11.1"),
    withAppTranscriptionProviders(withAppTranscriptionProviders(vendored)),
  ]) {
    const provider = catalog.transcriptionProviders.find((p) => p.id === "mistral");
    assert.equal(provider.models.filter((m) => m.id === model).length, 1);
    assert.equal(provider.defaultModel, "voxtral-mini-latest");
  }
});
