const test = require("node:test");
const assert = require("node:assert/strict");
const {
  initializeOrukeetDefaults,
  DEFAULT_ORUKEET_MODEL,
} = require("../../src/helpers/orukeetDefaults.ts");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("fresh renderer selects Orukeet across dictation, meetings and uploads after migrations", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-orukeet-default-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  for (const prefix of ["", "meeting", "upload"]) {
    const key = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    assert.equal(state[key("transcriptionMode")], "local");
    assert.equal(state[key("useLocalWhisper")], true);
    assert.equal(state[key("localTranscriptionProvider")], "nvidia");
    assert.equal(state[key("parakeetModel")], DEFAULT_ORUKEET_MODEL);
  }
});
for (const saved of [
  { useLocalWhisper: "false", cloudTranscriptionProvider: "groq" },
  { localTranscriptionProvider: "whisper", whisperModel: "small" },
  { localTranscriptionProvider: "nvidia", parakeetModel: "parakeet-tdt-0.6b-v3" },
]) {
  test(`preserves saved choice ${JSON.stringify(saved)}`, () => {
    const values = new Map(Object.entries(saved));
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    assert.equal(initializeOrukeetDefaults(storage), false);
    assert.deepEqual(Object.fromEntries(values), saved);
  });
}

test("partial legacy cloud preferences stay cloud after full renderer hydration", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", transcriptionMode: "openwhispr" },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-orukeet-legacy-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  assert.equal(state.transcriptionMode, "openwhispr");
  assert.equal(state.useLocalWhisper, false);
  assert.equal(state.localTranscriptionProvider, "whisper");
  assert.equal(state.parakeetModel, "");
});
