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

test("isChineseText distinguishes Chinese from Japanese and Korean", async () => {
  const { isChineseText } = await load();
  assert.equal(isChineseText("这是简体中文"), true);
  assert.equal(isChineseText("這是繁體中文"), true);
  assert.equal(isChineseText("这是 OpenAI 的 API"), true);
  assert.equal(isChineseText("今天天气很好"), true);
  assert.equal(isChineseText("今天天氣很好"), true);
  assert.equal(isChineseText("Hello 世界"), false);
  assert.equal(isChineseText("Meet at 東京駅"), false);
  assert.equal(isChineseText("東京駅"), false);
  assert.equal(isChineseText("会議資料"), false);
  assert.equal(isChineseText("開発資料"), false);
  assert.equal(isChineseText("設定変更"), false);
  assert.equal(isChineseText("電気"), false);
  assert.equal(isChineseText("資料確認"), false);
  assert.equal(isChineseText("導入試験"), false);
  assert.equal(isChineseText("会議の資料を確認してください"), false);
  assert.equal(isChineseText("今日は時間がありますか"), false);
  assert.equal(isChineseText("한국어 漢字 텍스트"), false);
  assert.equal(isChineseText("hello world"), false);
  assert.equal(isChineseText(""), false);
  assert.equal(isChineseText(undefined), false);
});

test("resolveChineseScriptTarget: auto applies preference only to Chinese text", async () => {
  const { resolveChineseScriptTarget } = await load();
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "這是中文"), "simplified");
  assert.equal(resolveChineseScriptTarget("auto", "traditional", "这是中文"), "traditional");
  assert.equal(resolveChineseScriptTarget("auto", "as-transcribed", "这是中文"), null);
  assert.equal(resolveChineseScriptTarget(undefined, "simplified", "这是中文"), "simplified");
  // Japanese, Korean and non-CJK must never be rewritten. See #975.
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "会議の資料"), null);
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "会議資料"), null);
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "Meet at 東京駅"), null);
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "한국어 漢字"), null);
  assert.equal(resolveChineseScriptTarget("auto", "simplified", "hello world"), null);
});

test("resolveChineseScriptTarget: without text only explicit zh-CN / zh-TW apply", async () => {
  const { resolveChineseScriptTarget } = await load();
  assert.equal(resolveChineseScriptTarget("zh-CN", "as-transcribed"), "simplified");
  assert.equal(resolveChineseScriptTarget("zh-TW", "as-transcribed"), "traditional");
  assert.equal(resolveChineseScriptTarget("auto", "simplified"), null);
  assert.equal(resolveChineseScriptTarget("auto", "traditional"), null);
});

test("resolveCleanupLanguage keeps auto until the transcription language is known", async () => {
  const { resolveCleanupLanguage } = await load();
  // Cleanup must never be told to answer in Chinese before the language is known,
  // so the script preference is deliberately not an input here.
  assert.equal(resolveCleanupLanguage("auto"), "auto");
  assert.equal(resolveCleanupLanguage(""), "auto");
  assert.equal(resolveCleanupLanguage(undefined), "auto");
  assert.equal(resolveCleanupLanguage("zh-CN"), "zh-CN");
  assert.equal(resolveCleanupLanguage("zh-TW"), "zh-TW");
  assert.equal(resolveCleanupLanguage("ja"), "ja");
});

test("applyChineseScript converts traditional to simplified", async () => {
  const { applyChineseScript } = await load();
  assert.equal(await applyChineseScript("這是繁體中文軟體", "simplified"), "这是繁体中文软件");
});

test("applyChineseScript converts simplified to traditional Taiwan phrases", async () => {
  const { applyChineseScript } = await load();
  assert.equal(await applyChineseScript("这是简体中文软件", "traditional"), "這是簡體中文軟體");
});

test("applyChineseScript leaves non-CJK and empty text alone", async () => {
  const { applyChineseScript } = await load();
  assert.equal(await applyChineseScript("hello world", "simplified"), "hello world");
  assert.equal(await applyChineseScript("", "simplified"), "");
  assert.equal(await applyChineseScript("mixed 軟體 ok", null), "mixed 軟體 ok");
});

test("applyChineseScript is idempotent for the same target", async () => {
  const { applyChineseScript } = await load();
  // Text that is already in the target script must survive untouched, so a
  // transcript never shifts characters just by passing through twice.
  const toSimplified = await applyChineseScript("這是繁體中文軟體", "simplified");
  assert.equal(await applyChineseScript(toSimplified, "simplified"), toSimplified);

  // Ambiguous simplified chars (干/后/面) pick one traditional form; re-running
  // must not pick a different one.
  for (const input of ["干净的头发", "他很干练", "面条和方便面", "皇后在后面"]) {
    const once = await applyChineseScript(input, "traditional");
    assert.equal(await applyChineseScript(once, "traditional"), once, `not idempotent: ${input}`);
  }
});

test("applyChineseScript is a no-op for Japanese and Korean when target is null", async () => {
  const { applyChineseScript, resolveChineseScriptTarget } = await load();
  for (const text of ["会議の資料を確認してください", "한국어 漢字 텍스트"]) {
    const target = resolveChineseScriptTarget("auto", "simplified", text);
    assert.equal(target, null);
    assert.equal(await applyChineseScript(text, target), text);
  }
});

test("Whisper prompt bias and merge", async () => {
  const { getChineseScriptPromptBias, mergeWhisperPrompt } = await load();
  assert.match(getChineseScriptPromptBias("simplified"), /简体/);
  assert.match(getChineseScriptPromptBias("traditional"), /繁體/);
  assert.equal(getChineseScriptPromptBias(null), null);
  assert.equal(mergeWhisperPrompt("foo, bar", "simplified").includes("foo, bar"), true);
  assert.match(mergeWhisperPrompt(null, "simplified"), /简体/);
  assert.equal(mergeWhisperPrompt("foo", null), "foo");
  assert.equal(mergeWhisperPrompt("  ", null), null);
});

test("mergeWhisperPrompt puts the bias first so prompt truncation keeps it", async () => {
  const { mergeWhisperPrompt, getChineseScriptPromptBias } = await load();
  const bias = getChineseScriptPromptBias("simplified");
  const dictionary = Array.from({ length: 400 }, (_, i) => `term${i}`).join(", ");
  const prompt = mergeWhisperPrompt(dictionary, "simplified");
  assert.equal(prompt.startsWith(bias), true);

  // audioManager truncates to MAX_PROMPT_CHARS then back to the last comma;
  // the bias sits ahead of every dictionary word, so it always survives.
  const MAX_PROMPT_CHARS = 890;
  assert.equal(prompt.length > MAX_PROMPT_CHARS, true);
  const truncated = prompt.slice(0, MAX_PROMPT_CHARS);
  assert.equal(truncated.slice(0, truncated.lastIndexOf(",")).startsWith(bias), true);
});
