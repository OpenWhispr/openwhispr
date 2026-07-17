const test = require("node:test");
const assert = require("node:assert/strict");

async function load() {
  return import("../../src/utils/chineseScript.js");
}

test("normalizeChineseScriptPreference defaults unknown values", async () => {
  const { normalizeChineseScriptPreference } = await load();
  assert.equal(normalizeChineseScriptPreference("simplified"), "simplified");
  assert.equal(normalizeChineseScriptPreference("traditional"), "traditional");
  assert.equal(normalizeChineseScriptPreference("as-transcribed"), "as-transcribed");
  assert.equal(normalizeChineseScriptPreference("nope"), "as-transcribed");
  assert.equal(normalizeChineseScriptPreference(undefined), "as-transcribed");
});

test("resolveChineseScriptTarget: zh-CN / zh-TW override auto preference", async () => {
  const { resolveChineseScriptTarget } = await load();
  assert.equal(resolveChineseScriptTarget("zh-CN", "traditional"), "simplified");
  assert.equal(resolveChineseScriptTarget("zh-TW", "simplified"), "traditional");
  assert.equal(resolveChineseScriptTarget("en", "simplified"), null);
});

test("resolveChineseScriptTarget: auto uses chineseScriptPreference", async () => {
  const { resolveChineseScriptTarget } = await load();
  assert.equal(resolveChineseScriptTarget("auto", "simplified"), "simplified");
  assert.equal(resolveChineseScriptTarget("auto", "traditional"), "traditional");
  assert.equal(resolveChineseScriptTarget("auto", "as-transcribed"), null);
  assert.equal(resolveChineseScriptTarget(undefined, "simplified"), "simplified");
});

test("resolveCleanupLanguage maps auto preference to zh-CN / zh-TW", async () => {
  const { resolveCleanupLanguage } = await load();
  assert.equal(resolveCleanupLanguage("auto", "simplified"), "zh-CN");
  assert.equal(resolveCleanupLanguage("auto", "traditional"), "zh-TW");
  assert.equal(resolveCleanupLanguage("auto", "as-transcribed"), "auto");
  assert.equal(resolveCleanupLanguage("zh-CN", "traditional"), "zh-CN");
  assert.equal(resolveCleanupLanguage("ja", "simplified"), "ja");
});

test("applyChineseScript converts traditional to simplified", async () => {
  const { applyChineseScript } = await load();
  assert.equal(applyChineseScript("這是繁體中文軟體", "simplified"), "这是繁体中文软件");
});

test("applyChineseScript converts simplified to traditional Taiwan phrases", async () => {
  const { applyChineseScript } = await load();
  assert.equal(applyChineseScript("这是简体中文软件", "traditional"), "這是簡體中文軟體");
});

test("applyChineseScript leaves non-CJK and empty text alone", async () => {
  const { applyChineseScript } = await load();
  assert.equal(applyChineseScript("hello world", "simplified"), "hello world");
  assert.equal(applyChineseScript("", "simplified"), "");
  assert.equal(applyChineseScript("mixed 軟體 ok", null), "mixed 軟體 ok");
});

test("applyChineseScript is idempotent for the same target", async () => {
  const { applyChineseScript } = await load();
  const once = applyChineseScript("這是繁體中文軟體", "simplified");
  assert.equal(applyChineseScript(once, "simplified"), once);
});

test("Whisper prompt bias and merge", async () => {
  const { getChineseScriptPromptBias, mergeWhisperPrompt } = await load();
  assert.match(getChineseScriptPromptBias("simplified"), /简体/);
  assert.match(getChineseScriptPromptBias("traditional"), /繁體/);
  assert.equal(getChineseScriptPromptBias(null), null);
  assert.equal(mergeWhisperPrompt("foo, bar", "simplified").includes("foo, bar"), true);
  assert.match(mergeWhisperPrompt(null, "simplified"), /简体/);
  assert.equal(mergeWhisperPrompt("foo", null), "foo");
});
