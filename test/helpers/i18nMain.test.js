const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUiLanguage } = require("../../src/helpers/i18nMain");

describe("normalizeUiLanguage", () => {
  it("keeps exact supported tags, including underscore zh_CN / zh_TW", () => {
    assert.equal(normalizeUiLanguage("zh-CN"), "zh-CN");
    assert.equal(normalizeUiLanguage("zh_TW"), "zh-TW");
    assert.equal(normalizeUiLanguage("en-US"), "en");
    assert.equal(normalizeUiLanguage("pt-BR"), "pt");
  });

  it("maps Chinese script and region tags onto zh-CN / zh-TW", () => {
    assert.equal(normalizeUiLanguage("zh-Hans"), "zh-CN");
    assert.equal(normalizeUiLanguage("zh-Hans-CN"), "zh-CN");
    assert.equal(normalizeUiLanguage("zh"), "zh-CN");
    assert.equal(normalizeUiLanguage("zh-Hant"), "zh-TW");
    assert.equal(normalizeUiLanguage("zh-Hant-TW"), "zh-TW");
    assert.equal(normalizeUiLanguage("zh_Hant_TW"), "zh-TW");
    assert.equal(normalizeUiLanguage("zh-HK"), "zh-TW");
  });

  it("falls back to English for unknown languages", () => {
    assert.equal(normalizeUiLanguage("ko-KR"), "en");
    assert.equal(normalizeUiLanguage(""), "en");
  });
});
