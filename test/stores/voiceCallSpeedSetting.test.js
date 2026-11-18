const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("a fractional call speed reads back as it was saved", async (t) => {
  installBrowserGlobals(t, { initialStorage: { voiceCallSpeed: "0.75" } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-voice-call-speed-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  assert.equal(useSettingsStore.getState().voiceCallSpeed, 0.75);
});
