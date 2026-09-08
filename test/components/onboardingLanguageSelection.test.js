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
