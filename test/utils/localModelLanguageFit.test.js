const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");
const languageRegistry = require("../../src/config/languageRegistry.json");
const { resolveModelLanguage } = require("../../src/helpers/parakeetModelInfo");

const load = () => import("../../src/utils/localModelLanguageFit.ts");

// A fake t that renders "key|json(params)" so the test sees exactly what was asked.
const t = (key, params) => (params ? `${key}|${JSON.stringify(params)}` : key);

const COHERE = "cohere-transcribe-03-2026";
const PARAKEET_V3 = "parakeet-tdt-0.6b-v3";
const englishOnlyModels = Object.entries(modelData.parakeetModels)
  .filter(([, model]) => JSON.stringify(model.supportedLanguages) === JSON.stringify(["en"]))
  .map(([id]) => id);

test("the registry's English-only models are the ones this covers", () => {
  assert.ok(englishOnlyModels.includes("parakeet-unified-en-0.6b"));
  assert.ok(englishOnlyModels.includes("nemotron-speech-streaming-en-0.6b"));
});

test("every English-only model reports French dictation as unsupported", async () => {
  const { getLocalModelLanguageFit, getModelOnlyLanguage } = await load();
  for (const modelId of englishOnlyModels) {
    assert.deepEqual(
      getLocalModelLanguageFit({ modelId, preferredLanguage: "fr" }),
      { unsupported: ["fr"], needsExplicitLanguage: [] },
      modelId
    );
    assert.equal(getModelOnlyLanguage(modelId), "en", modelId);
  }
});

test("English dictation in any regional variant fits an English-only model", async () => {
  const { getLocalModelLanguageFit } = await load();
  for (const modelId of englishOnlyModels) {
    for (const preferredLanguage of ["en-US", "en-GB", "en"]) {
      assert.equal(getLocalModelLanguageFit({ modelId, preferredLanguage }), null);
    }
  }
});

test("auto checks the spoken languages from onboarding, and nothing without them", async () => {
  const { getLocalModelLanguageFit } = await load();
  const modelId = "parakeet-unified-en-0.6b";
  assert.equal(getLocalModelLanguageFit({ modelId, preferredLanguage: "auto" }), null);
  assert.equal(
    getLocalModelLanguageFit({ modelId, preferredLanguage: "auto", spokenLanguages: [] }),
    null
  );
  assert.deepEqual(
    getLocalModelLanguageFit({
      modelId,
      preferredLanguage: "auto",
      spokenLanguages: ["en-US", "fr", "de"],
    }),
    { unsupported: ["fr", "de"], needsExplicitLanguage: [] }
  );
});

test("an explicit language is the only one checked, whatever was spoken", async () => {
  const { getLocalModelLanguageFit } = await load();
  assert.equal(
    getLocalModelLanguageFit({
      modelId: "parakeet-unified-en-0.6b",
      preferredLanguage: "en-US",
      spokenLanguages: ["fr"],
    }),
    null
  );
});

test("multilingual models report only the languages they lack", async () => {
  const { getLocalModelLanguageFit } = await load();
  assert.equal(getLocalModelLanguageFit({ modelId: PARAKEET_V3, preferredLanguage: "fr" }), null);
  assert.deepEqual(getLocalModelLanguageFit({ modelId: PARAKEET_V3, preferredLanguage: "ja" }), {
    unsupported: ["ja"],
    needsExplicitLanguage: [],
  });
  assert.deepEqual(
    getLocalModelLanguageFit({
      modelId: "nemotron-3.5-asr-streaming-0.6b",
      preferredLanguage: "auto",
      spokenLanguages: ["zh-CN", "zh-TW", "ja"],
    }),
    { unsupported: ["zh"], needsExplicitLanguage: [] }
  );
});

test("Cohere on auto needs the dictation language set for anything but English", async () => {
  const { getLocalModelLanguageFit } = await load();
  assert.deepEqual(
    getLocalModelLanguageFit({
      modelId: COHERE,
      preferredLanguage: "auto",
      spokenLanguages: ["en-US", "es", "hi"],
    }),
    { unsupported: ["hi"], needsExplicitLanguage: ["es"] }
  );
  assert.equal(getLocalModelLanguageFit({ modelId: COHERE, preferredLanguage: "es" }), null);
  assert.deepEqual(getLocalModelLanguageFit({ modelId: COHERE, preferredLanguage: "hi" }), {
    unsupported: ["hi"],
    needsExplicitLanguage: [],
  });
});

test("agrees with the language the sherpa server is actually started with", async () => {
  const { getLocalModelLanguageFit } = await load();
  const codes = languageRegistry.languages.map((l) => l.code).filter((c) => c !== "auto");
  for (const [modelId, model] of Object.entries(modelData.parakeetModels)) {
    if (!model.supportedLanguages) continue;
    for (const code of codes) {
      const base = code.split("-")[0].toLowerCase();
      // null means the model detects the language itself, from its own list.
      const startedFor = (language) => resolveModelLanguage(modelId, language);
      const transcribedExplicitly =
        startedFor(code) === null
          ? model.supportedLanguages.includes(base)
          : startedFor(code) === base;
      const transcribedOnAuto =
        startedFor("auto") === null
          ? model.supportedLanguages.includes(base)
          : startedFor("auto") === base;

      assert.equal(
        getLocalModelLanguageFit({ modelId, preferredLanguage: code }) === null,
        transcribedExplicitly,
        `${modelId} explicit ${code}`
      );
      assert.equal(
        getLocalModelLanguageFit({
          modelId,
          preferredLanguage: "auto",
          spokenLanguages: [code],
        }) === null,
        transcribedOnAuto,
        `${modelId} auto ${code}`
      );
    }
  }
});

test("Whisper and unknown models never report a gap", async () => {
  const { getLocalModelLanguageFit, getModelOnlyLanguage } = await load();
  for (const modelId of ["base", "large-v3-turbo", "not-a-model", "", null]) {
    assert.equal(getLocalModelLanguageFit({ modelId, preferredLanguage: "ja" }), null);
    assert.equal(getModelOnlyLanguage(modelId), null);
  }
});

test("the note names the languages in the interface language", async () => {
  const { describeLocalModelLanguageFit, formatLanguageNames } = await load();
  assert.equal(formatLanguageNames(["fr", "de"], "en"), "French or German");
  assert.equal(formatLanguageNames(["fr"], "fr"), "français");

  assert.equal(
    describeLocalModelLanguageFit(
      { unsupported: ["fr"], needsExplicitLanguage: [] },
      { surface: "card", t, locale: "en" }
    ),
    'transcription.languageFit.card.unsupported|{"languages":"French","model":""}'
  );
  assert.equal(
    describeLocalModelLanguageFit(
      { unsupported: [], needsExplicitLanguage: ["es"] },
      { surface: "settings", t, locale: "en", modelName: "Cohere Transcribe 2B" }
    ),
    'transcription.languageFit.settings.needsLanguage|{"languages":"Spanish","model":"Cohere Transcribe 2B"}'
  );
  // Unsupported wins: switching model is the fix, not setting a language.
  assert.match(
    describeLocalModelLanguageFit(
      { unsupported: ["hi"], needsExplicitLanguage: ["es"] },
      { surface: "card", t, locale: "en" }
    ),
    /^transcription\.languageFit\.card\.unsupported\|.*"Hindi"/
  );
  assert.equal(describeLocalModelLanguageFit(null, { surface: "card", t }), null);
});

test("single-language models get a language label", async () => {
  const { describeModelOnlyLanguage } = await load();
  assert.equal(
    describeModelOnlyLanguage("parakeet-unified-en-0.6b", { t, locale: "en" }),
    'transcription.languageFit.only|{"language":"English"}'
  );
  assert.equal(describeModelOnlyLanguage(PARAKEET_V3, { t, locale: "en" }), null);
});
