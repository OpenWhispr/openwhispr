const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/config/uiLanguages.ts");

test("onboarding offers every supported interface language once", async () => {
  const { SUPPORTED_UI_LANGUAGES, UI_LANGUAGE_OPTIONS } = await load();
  const values = UI_LANGUAGE_OPTIONS.map(({ value }) => value);

  assert.deepEqual(values, [...SUPPORTED_UI_LANGUAGES]);
  assert.equal(new Set(values).size, values.length);
});

test("interface language labels are native and distinct from transcription choices", async () => {
  const { UI_LANGUAGE_OPTIONS } = await load();
  const options = new Map(UI_LANGUAGE_OPTIONS.map((option) => [option.value, option]));

  assert.equal(options.get("zh-CN").label, "简体中文");
  assert.equal(options.get("zh-TW").label, "繁體中文");
  assert.equal(options.has("auto"), false);
  assert.equal(options.has("en-US"), false);
});
