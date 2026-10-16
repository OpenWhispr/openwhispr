const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadStore(t, initialStorage = {}) {
  installBrowserGlobals(t, { initialStorage, window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-gemini-mode-" });
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

test("Gemini dictation defaults to verbatim and persists an explicit smart choice", async (t) => {
  const { useSettingsStore } = await loadStore(t);
  assert.equal(useSettingsStore.getState().geminiDictationMode, "verbatim");
  useSettingsStore.getState().setGeminiDictationMode("smart");
  assert.equal(useSettingsStore.getState().geminiDictationMode, "smart");
  assert.equal(localStorage.getItem("geminiDictationMode"), "smart");
  useSettingsStore.getState().updateTranscriptionSettings({ geminiDictationMode: "verbatim" });
  assert.equal(localStorage.getItem("geminiDictationMode"), "verbatim");
});

test("a fresh settings store hydrates the saved Gemini dictation mode", async (t) => {
  const { useSettingsStore } = await loadStore(t, { geminiDictationMode: "smart" });
  assert.equal(useSettingsStore.getState().geminiDictationMode, "smart");
});

test("an unknown saved Gemini mode falls back to verbatim", async (t) => {
  const { useSettingsStore } = await loadStore(t, { geminiDictationMode: "unexpected" });
  assert.equal(useSettingsStore.getState().geminiDictationMode, "verbatim");
});
