const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The Windows "System Audio Source" choice (#1546) lives in renderer
// localStorage like the microphone choice. Every value except the exact opt-in
// must keep today's capture of every playback device.
test("the system audio source setting", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-system-audio-source-setting-test-",
  });
  // The store reads localStorage once at module evaluation, so each case
  // re-evaluates it against freshly seeded storage.
  const load = async (seed = {}) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return mod.useSettingsStore;
  };

  await t.test("a fresh profile records every playback device", async () => {
    const store = await load();
    assert.equal(store.getState().systemAudioSource, "all-devices");
  });

  await t.test("a saved opt-in survives a restart", async () => {
    const store = await load({ systemAudioSource: "default-device" });
    assert.equal(store.getState().systemAudioSource, "default-device");
  });

  await t.test("an unknown saved value falls back to every playback device", async () => {
    const store = await load({ systemAudioSource: "virtual-cable" });
    assert.equal(store.getState().systemAudioSource, "all-devices");
  });

  await t.test("the setter persists the choice for the next launch", async () => {
    const store = await load();
    store.getState().setSystemAudioSource("default-device");
    assert.equal(store.getState().systemAudioSource, "default-device");
    assert.equal(storage.getItem("systemAudioSource"), "default-device");

    store.getState().setSystemAudioSource("all-devices");
    assert.equal(store.getState().systemAudioSource, "all-devices");
    assert.equal(storage.getItem("systemAudioSource"), "all-devices");
  });

  await t.test("the setter never stores an unknown value", async () => {
    const store = await load();
    store.getState().setSystemAudioSource("specific-device");
    assert.equal(store.getState().systemAudioSource, "all-devices");
    assert.equal(storage.getItem("systemAudioSource"), "all-devices");
  });
});
