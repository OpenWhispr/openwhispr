const test = require("node:test");
const assert = require("node:assert/strict");

const { registryData: registry } = require("../../src/models/registryData.js");
const {
  isNoteRecordingOnlyTranscriptionModel,
} = require("../../src/models/appTranscriptionProviders.js");
const load = () => import("../../src/helpers/transcriptionRoute.ts");

// Every model the picker can write must resolve to itself, or a streaming one to its provider's
// batch model; otherwise a user who picks it has their choice reset at request time.
//
// Tinfoil is excluded: its batch model comes from the registry directly
// (getBatchTranscriptionModel) and the route sends none.
const PREFIX_VALIDATED_PROVIDERS = [
  "openai",
  "groq",
  "xai",
  "mistral",
  "sarvam",
  "corti",
  "gemini",
  "deepgram",
  "assemblyai",
  "elevenlabs",
  "openrouter",
];

test("every shipping registry model resolves to itself or its provider's batch model", async () => {
  const { resolveByokModel } = await load();

  for (const providerId of PREFIX_VALIDATED_PROVIDERS) {
    const provider = registry.transcriptionProviders.find((p) => p.id === providerId);
    assert.ok(provider, `registry is missing provider ${providerId}`);

    // A Note Recording-only model never reaches a batch request. Gemini answers 400 for
    // gemini-3.5-transcribe-live in a batch request (#3369).
    for (const model of provider.models.filter(
      (m) => !isNoteRecordingOnlyTranscriptionModel(providerId, m.id)
    )) {
      assert.equal(
        resolveByokModel(providerId, model.id),
        model.streaming && provider.batchModel ? provider.batchModel : model.id,
        `${providerId}/${model.id} is offered by the picker but resolved to another model`
      );
    }
  }
});

test("each provider's fallback default is a model that provider actually offers", async () => {
  const { resolveByokModel } = await load();

  for (const providerId of PREFIX_VALIDATED_PROVIDERS) {
    const provider = registry.transcriptionProviders.find((p) => p.id === providerId);
    const fallback = resolveByokModel(providerId, "a-model-from-another-provider");
    assert.ok(
      provider.models.some((m) => m.id === fallback),
      `${providerId} falls back to ${fallback}, which it does not offer`
    );
  }
});

test("custom keeps any non-empty model and defaults to whisper-1", async () => {
  const { resolveByokModel } = await load();

  assert.equal(resolveByokModel("custom", "parasail-whisper-v3"), "parasail-whisper-v3");
  assert.equal(resolveByokModel("custom", "  spaced-model  "), "spaced-model");
  assert.equal(resolveByokModel("custom", ""), "whisper-1");
  assert.equal(resolveByokModel("custom", undefined), "whisper-1");
});

// The leniency is deliberate: a retired id (e.g. the voxtral-small entry that
// shipped in #1120) must keep working rather than be reset out from under a user.
test("a retired provider-shaped model id is preserved, not reset", async () => {
  const { resolveByokModel } = await load();

  assert.equal(resolveByokModel("mistral", "voxtral-small-latest"), "voxtral-small-latest");
  assert.equal(resolveByokModel("groq", "whisper-large-v3-en"), "whisper-large-v3-en");
  assert.equal(
    resolveByokModel("openai", "gpt-4o-transcribe-diarize"),
    "gpt-4o-transcribe-diarize"
  );
});

test("a model belonging to another provider degrades to the provider default", async () => {
  const { resolveByokModel } = await load();

  assert.equal(resolveByokModel("groq", "gpt-4o-mini-transcribe"), "whisper-large-v3-turbo");
  assert.equal(resolveByokModel("openai", "voxtral-mini-latest"), "gpt-transcribe");
  assert.equal(resolveByokModel("mistral", "whisper-1"), "voxtral-mini-latest");
  assert.equal(resolveByokModel("corti", "whisper-1"), "corti-transcribe");
  assert.equal(resolveByokModel("gemini", "whisper-1"), "gemini-3.5-transcribe");
  assert.equal(resolveByokModel("deepgram", "whisper-1"), "nova-3");
  assert.equal(resolveByokModel("assemblyai", "nova-3"), "universal-3-6-pro");
  assert.equal(resolveByokModel("elevenlabs", "whisper-1"), "scribe_v3");
  assert.equal(
    resolveByokModel("elevenlabs", "scribe_v2"),
    "scribe_v2",
    "a saved v2 selection keeps working"
  );
  for (const realtime of ["scribe_v3_live", "scribe_v2_realtime"]) {
    assert.equal(
      resolveByokModel("elevenlabs", realtime),
      "scribe_v3",
      "a realtime model has no batch endpoint"
    );
  }
});

// The catalog sends an offered model as is and moves a retired one to its replacement,
// and a publication can do both with a realtime model this build has never named.
test("a realtime model a publication lists degrades to the provider default", async (t) => {
  const store = require("../../src/models/registryData.js");
  const { resolveByokModel } = await load();
  const old = store.getRegistrySnapshot();
  t.after(() =>
    store.replaceRegistryData({ data: old.data, manifestVersion: old.manifestVersion + 2 })
  );
  const published = structuredClone(old.data);
  const { models } = published.transcriptionProviders.find((p) => p.id === "elevenlabs");
  const live = models.find((m) => m.id === "scribe_v3_live");
  models.push({ ...live, id: "scribe_v4_live" });
  Object.assign(live, { retired: true, replacement: "scribe_v4_live" });
  assert.ok(
    store.replaceRegistryData({ data: published, manifestVersion: old.manifestVersion + 1 })
  );

  for (const realtime of ["scribe_v4_live", "scribe_v3_live"]) {
    assert.equal(resolveByokModel("elevenlabs", realtime), "scribe_v3", realtime);
  }
});

// OpenRouter brokers batch HTTP transcription only — it has no realtime socket.
// A `streaming: true` slipped onto one of its models would put the meeting and
// Note Recording scopes on a WebSocket that does not exist.
test("no OpenRouter model advertises streaming", () => {
  const provider = registry.transcriptionProviders.find((p) => p.id === "openrouter");
  assert.ok(provider, "registry is missing the openrouter provider");
  for (const model of provider.models) {
    assert.equal(model.streaming, undefined, `${model.id} must stay batch-only`);
  }
});
