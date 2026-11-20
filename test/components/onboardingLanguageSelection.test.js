const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/languageOptions.ts");

test("onboarding languages use the reference priority without auto-detect", async () => {
  const { getOnboardingLanguageOptions } = await load();
  const options = getOnboardingLanguageOptions("", []);

  assert.deepEqual(
    options.slice(0, 5).map(({ code }) => code),
    ["en-US", "zh-CN", "es", "ar", "af"]
  );
  assert.equal(
    options.some(({ code }) => code === "auto"),
    false
  );
});

test("search keeps existing selections visible and recognizes Hindustani as Hindi", async () => {
  const { getOnboardingLanguageOptions } = await load();
  const options = getOnboardingLanguageOptions("Hind", ["en-US", "es"]);

  assert.deepEqual(
    options.slice(0, 3).map(({ code }) => code),
    ["en-US", "es", "hi"]
  );
});

test("Sarvam languages are selectable with their REST hint and local model support", async () => {
  const { getOnboardingLanguageOptions } = await load();
  const { sarvamLanguage } = require("../../src/utils/sarvam");
  for (const [name, code, whisper] of [
    ["Assamese", "as", true],
    ["Bengali", "bn", true],
    ["Bodo", "brx", false],
    ["Dogri", "doi", false],
    ["Gujarati", "gu", true],
    ["Kashmiri", "ks", false],
    ["Konkani", "kok", false],
    ["Maithili", "mai", false],
    ["Malayalam", "ml", true],
    ["Manipuri", "mni", false],
    ["Odia", "or", false],
    ["Punjabi", "pa", true],
    ["Sanskrit", "sa", true],
    ["Santali", "sat", false],
    ["Sindhi", "sd", true],
    ["Telugu", "te", true],
  ]) {
    const option = getOnboardingLanguageOptions(name, []).find(
      (language) => language.code === code
    );
    assert.ok(option, name);
    assert.equal(sarvamLanguage(option.code), code === "or" ? "od-IN" : code + "-IN");
    assert.equal(option.whisper, whisper, name);
    assert.equal(option.parakeet, false, name);
    assert.equal(option.assemblyai, false, name);
  }
});
