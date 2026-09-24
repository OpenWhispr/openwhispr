const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../../src/models/modelRegistryData.json");

// The managed Orukeet route has no language on the wire and the model covers
// a fixed list; every other language must stay on the batch path, which
// honors the user's language end to end.
const loadRouting = () => import("../../src/helpers/dictationStreamingRouting.js");

const managedSettings = {
  cloudTranscriptionMode: "openwhispr",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
};
const orukeetConfig = { dictation: { mode: "streaming" }, streamingProvider: "orukeet" };
const supportedLanguages = registry.parakeetModels["orukeet-v0.1.0"].supportedLanguages;

test("managed Orukeet streams every language in the model's registry list", async () => {
  const { resolveManagedOrukeetRoute, resolveStreamingProviderName } = await loadRouting();
  for (const language of supportedLanguages) {
    const input = { settings: managedSettings, sttConfig: orukeetConfig, language };
    assert.equal(resolveManagedOrukeetRoute(input), "orukeet", language);
    assert.equal(
      resolveStreamingProviderName({ ...input, context: "dictation" }),
      "orukeet",
      language
    );
  }
});

test("a regional tag routes on its base language", async () => {
  const { resolveManagedOrukeetRoute } = await loadRouting();
  assert.equal(
    resolveManagedOrukeetRoute({
      settings: managedSettings,
      sttConfig: orukeetConfig,
      language: "pt-BR",
    }),
    "orukeet"
  );
});

test("a language outside the model's list stays on the batch path", async () => {
  const { resolveManagedOrukeetRoute, resolveStreamingProviderName } = await loadRouting();
  for (const language of ["ja", "zh-CN", "ko", "ar", "hi", "tr"]) {
    const input = { settings: managedSettings, sttConfig: orukeetConfig, language };
    assert.equal(resolveManagedOrukeetRoute(input), "language_unsupported", language);
    assert.equal(
      resolveStreamingProviderName({ ...input, context: "dictation" }),
      "openai-realtime",
      language
    );
  }
});

test("automatic language detection is left to the model, like every other streaming provider", async () => {
  const { resolveManagedOrukeetRoute } = await loadRouting();
  for (const language of ["auto", undefined, ""]) {
    assert.equal(
      resolveManagedOrukeetRoute({ settings: managedSettings, sttConfig: orukeetConfig, language }),
      "orukeet",
      String(language)
    );
  }
});

test("the route is absent when the server has not enabled Orukeet", async () => {
  const { resolveManagedOrukeetRoute } = await loadRouting();
  const cases = [
    { sttConfig: { dictation: { mode: "batch" }, streamingProvider: "orukeet" } },
    { sttConfig: { dictation: { mode: "streaming" }, streamingProvider: "deepgram" } },
    { sttConfig: null },
    { settings: { ...managedSettings, cloudTranscriptionMode: "byok" }, sttConfig: orukeetConfig },
  ];
  for (const overrides of cases) {
    assert.equal(
      resolveManagedOrukeetRoute({
        settings: managedSettings,
        sttConfig: orukeetConfig,
        language: "fr",
        ...overrides,
      }),
      null
    );
  }
});

test("a BYOK custom Orukeet endpoint is not language gated", async () => {
  const { resolveStreamingProviderName } = await loadRouting();
  assert.equal(
    resolveStreamingProviderName({
      settings: {
        cloudTranscriptionMode: "byok",
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionModel: "orukeet-v0.1.0",
        cloudTranscriptionBaseUrl: "https://orukeet.example.test",
      },
      context: "dictation",
      sttConfig: null,
      language: "ja",
    }),
    "orukeet"
  );
});
