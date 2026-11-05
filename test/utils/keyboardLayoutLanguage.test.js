const test = require("node:test");
const assert = require("node:assert/strict");

const loadLayout = () => import("../../src/utils/keyboardLayoutLanguage.ts");
const loadSupport = () => import("../../src/utils/languageSupport.ts");
const loadChinese = () => import("../../src/utils/chineseScript.js");
const loadRouting = () => import("../../src/helpers/dictationRouting.js");
const loadRoute = () => import("../../src/helpers/transcriptionRoute.ts");

test("KEYBOARD_LAYOUT_LANGUAGE is the stored setting value", async () => {
  const { KEYBOARD_LAYOUT_LANGUAGE, isKeyboardLayoutLanguage } = await loadLayout();
  assert.equal(KEYBOARD_LAYOUT_LANGUAGE, "keyboard");
  assert.equal(isKeyboardLayoutLanguage("keyboard"), true);
  for (const other of ["auto", "ru", "", null, undefined]) {
    assert.equal(isKeyboardLayoutLanguage(other), false);
  }
});

test("resolveLayoutLanguage maps supported iso to base code", async () => {
  const { resolveLayoutLanguage } = await loadSupport();
  assert.deepEqual(
    resolveLayoutLanguage({
      ok: true,
      klid: "00020422",
      iso: "uk",
      layoutName: "Ukrainian (Enhanced)",
    }),
    { language: "uk", notice: null }
  );
  assert.equal(
    resolveLayoutLanguage({ ok: true, klid: "00000409", iso: "en", layoutName: "US" }).language,
    "en"
  );
});

test("failed probe → auto + undetected", async () => {
  const { resolveLayoutLanguage } = await loadSupport();
  assert.deepEqual(resolveLayoutLanguage({ ok: false, reason: "timeout" }), {
    language: "auto",
    notice: { kind: "undetected" },
  });
});

test("iso not supported by whisper → auto + unsupported with layout name", async () => {
  const { resolveLayoutLanguage } = await loadSupport();
  // "dv" (Divehi) is not in languageRegistry.json at all.
  assert.deepEqual(
    resolveLayoutLanguage({ ok: true, klid: "00000465", iso: "dv", layoutName: "Divehi Phonetic" }),
    { language: "auto", notice: { kind: "unsupported", layoutName: "Divehi Phonetic" } }
  );
});

test("a registry entry without whisper support is unsupported, and 'auto' is not an iso code", async () => {
  const { resolveLayoutLanguage } = await loadSupport();
  const maltese = resolveLayoutLanguage({
    ok: true,
    klid: "0000043A",
    iso: "mt",
    layoutName: "Maltese",
  });
  assert.equal(maltese.language, "auto");
  assert.equal(maltese.notice.kind, "unsupported");
  const auto = resolveLayoutLanguage({ ok: true, klid: "00000409", iso: "auto", layoutName: "X" });
  assert.equal(auto.notice.kind, "unsupported");
});

test("'keyboard' behaves like auto outside dictation", async () => {
  const { getBaseLanguageCode, getLanguageInstruction } = await loadSupport();
  const { resolveCleanupLanguage, resolveChineseScriptTarget } = await loadChinese();
  const { resolveWakeWordLanguage } = await loadRouting();
  const { resolveTranscriptionRoute } = await loadRoute();

  assert.equal(getBaseLanguageCode("keyboard"), undefined);
  assert.equal(getLanguageInstruction("keyboard"), getLanguageInstruction("auto"));
  assert.equal(resolveCleanupLanguage("keyboard"), resolveCleanupLanguage("auto"));
  assert.equal(
    resolveChineseScriptTarget("keyboard", "simplified", "这是中文文本"),
    resolveChineseScriptTarget("auto", "simplified", "这是中文文本")
  );
  assert.equal(
    resolveWakeWordLanguage(
      { preferredLanguage: "keyboard", uiLanguage: "ru" },
      undefined,
      "привет"
    ),
    "ru"
  );
  const route = resolveTranscriptionRoute({
    settings: {
      preferredLanguage: "keyboard",
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://192.168.1.5:11434/v1",
      remoteTranscriptionModel: "whisper-1",
    },
  });
  assert.equal(route.language, undefined);
});
