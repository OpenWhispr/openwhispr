const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../../src/models/modelRegistryData.json");
const load = () => import("../../src/helpers/transcriptionRoute.ts");

// resolveByokModel validates by prefix so it can run in the packaged main process
// without the registry, which means the two can silently drift apart. Every model
// the picker can write must survive a round trip through the resolver, or a user
// who picks it has their choice replaced by the provider default at request time.
//
// Tinfoil is excluded: its batch model comes from the registry directly
// (getBatchTranscriptionModel) and the route sends none.
const PREFIX_VALIDATED_PROVIDERS = ["openai", "groq", "xai", "mistral", "corti", "gemini"];

test("every shipping registry model survives resolveByokModel", async () => {
  const { resolveByokModel } = await load();

  for (const providerId of PREFIX_VALIDATED_PROVIDERS) {
    const provider = registry.transcriptionProviders.find((p) => p.id === providerId);
    assert.ok(provider, `registry is missing provider ${providerId}`);

    for (const model of provider.models) {
      assert.equal(
        resolveByokModel(providerId, model.id),
        model.id,
        `${providerId}/${model.id} is offered by the picker but rewritten by the resolver`
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
  assert.equal(resolveByokModel("openai", "voxtral-mini-latest"), "gpt-4o-mini-transcribe");
  assert.equal(resolveByokModel("mistral", "whisper-1"), "voxtral-mini-latest");
  assert.equal(resolveByokModel("corti", "whisper-1"), "corti-transcribe");
  assert.equal(resolveByokModel("gemini", "whisper-1"), "gemini-3.5-transcribe");
});
