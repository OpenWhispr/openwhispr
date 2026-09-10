const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const mod = await import("../../src/utils/languageSupport.ts");
  return mod.getBaseLanguageCode ? mod : mod.default;
};

test("getBaseLanguageCode extracts primary subtag from simple codes", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("en"), "en");
  assert.equal(getBaseLanguageCode("es"), "es");
  assert.equal(getBaseLanguageCode("zh"), "zh");
  assert.equal(getBaseLanguageCode("pt"), "pt");
});

test("getBaseLanguageCode normalizes hyphen-separated language tags", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("en-US"), "en");
  assert.equal(getBaseLanguageCode("zh-CN"), "zh");
  assert.equal(getBaseLanguageCode("pt-BR"), "pt");
  assert.equal(getBaseLanguageCode("es-419"), "es");
});

test("getBaseLanguageCode normalizes underscore-separated locales", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("zh_CN"), "zh");
  assert.equal(getBaseLanguageCode("pt_BR"), "pt");
  assert.equal(getBaseLanguageCode("de_DE"), "de");
  assert.equal(getBaseLanguageCode("es_ES"), "es");
  assert.equal(getBaseLanguageCode("fr_FR"), "fr");
  assert.equal(getBaseLanguageCode("en_GB"), "en");
});

test("getBaseLanguageCode lowercases uppercase and mixed-case inputs", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("EN"), "en");
  assert.equal(getBaseLanguageCode("EN-US"), "en");
  assert.equal(getBaseLanguageCode("ZH_CN"), "zh");
  assert.equal(getBaseLanguageCode("Pt-Br"), "pt");
});

test("getBaseLanguageCode trims leading and trailing whitespace", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("  en  "), "en");
  assert.equal(getBaseLanguageCode("  zh_CN  "), "zh");
  assert.equal(getBaseLanguageCode("\tes-ES\n"), "es");
  assert.equal(getBaseLanguageCode("  pt-BR  "), "pt");
});

test("getBaseLanguageCode returns undefined for auto, empty, or non-string inputs", async () => {
  const { getBaseLanguageCode } = await load();

  assert.equal(getBaseLanguageCode("auto"), undefined);
  assert.equal(getBaseLanguageCode("AUTO"), undefined);
  assert.equal(getBaseLanguageCode("  auto  "), undefined);
  assert.equal(getBaseLanguageCode(""), undefined);
  assert.equal(getBaseLanguageCode("   "), undefined);
  assert.equal(getBaseLanguageCode(null), undefined);
  assert.equal(getBaseLanguageCode(undefined), undefined);
  assert.equal(getBaseLanguageCode(123), undefined);
});
