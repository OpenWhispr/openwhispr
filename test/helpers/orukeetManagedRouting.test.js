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

test("a confident unsupported estimate on 3 s or more in auto mode re-transcribes", async () => {
  const { shouldRetranscribeOrukeetLanguage } = await loadRouting();
  for (const language of ["auto", "", undefined]) {
    assert.equal(
      shouldRetranscribeOrukeetLanguage({
        language,
        final: {
          success: true,
          text: "x",
          language: "ja",
          languageConfidence: 0.9,
          languageAudioSeconds: 3,
        },
      }),
      true,
      String(language)
    );
  }
});

test("everything else keeps the Orukeet transcript", async () => {
  const { shouldRetranscribeOrukeetLanguage } = await loadRouting();
  const final = {
    success: true,
    text: "x",
    language: "ja",
    languageConfidence: 0.97,
    languageAudioSeconds: 6,
  };
  const cases = [
    { language: "en", final }, // explicit setting
    { language: "ja", final }, // explicit (never reaches Orukeet anyway)
    { language: "auto", final: { ...final, language: "de" } }, // supported
    { language: "auto", final: { ...final, languageConfidence: 0.89 } },
    { language: "auto", final: { ...final, languageAudioSeconds: 2.9 } },
    { language: "auto", final: { ...final, languageAudioSeconds: undefined } },
    { language: "auto", final: { ...final, language: null, languageConfidence: null } }, // unknown
    { language: "auto", final: { success: true, text: "x" } }, // older gateway
    { language: "auto", final: null }, // finalize failed
  ];
  for (const input of cases) {
    assert.equal(shouldRetranscribeOrukeetLanguage(input), false, JSON.stringify(input));
  }
});

test("detected-language fields mirror the final estimate for the backend", async () => {
  const { orukeetDetectedLanguageFields } = await loadRouting();
  assert.deepEqual(
    orukeetDetectedLanguageFields({
      text: "x",
      language: "hi",
      languageConfidence: 0.93,
      languageAudioSeconds: 3,
    }),
    {
      sttDetectedLanguage: "hi",
      sttDetectedLanguageConfidence: 0.93,
      sttDetectedLanguageAudioSeconds: 3,
      sttDetectedLanguageStatus: "detected",
    }
  );
  assert.deepEqual(
    orukeetDetectedLanguageFields({ text: "x", language: "en", languageConfidence: 0.5 }),
    {
      sttDetectedLanguage: "en",
      sttDetectedLanguageConfidence: 0.5,
      sttDetectedLanguageStatus: "detected",
    }
  );
  assert.deepEqual(
    orukeetDetectedLanguageFields({ text: "x", language: null, languageConfidence: null }),
    { sttDetectedLanguageStatus: "unknown" }
  );
  // Older gateway (no key), failed finalize, and silence send nothing at all.
  assert.deepEqual(orukeetDetectedLanguageFields({ text: "x" }), {});
  assert.deepEqual(orukeetDetectedLanguageFields(null), {});
  assert.deepEqual(orukeetDetectedLanguageFields(undefined), {});
});

test("isOrukeetLanguage accepts the 25 base codes and regional variants only", async () => {
  const { isOrukeetLanguage } = await loadRouting();
  for (const code of ["en", "en-US", "PT-br", "uk", "mt"]) {
    assert.equal(isOrukeetLanguage(code), true, code);
  }
  for (const code of ["ja", "zh-CN", "auto", "", null, undefined, 5]) {
    assert.equal(isOrukeetLanguage(code), false, String(code));
  }
});
