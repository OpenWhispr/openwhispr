const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadStore(t, initialStorage, cachePrefix) {
  installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, {
    cachePrefix,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  return vite.ssrLoadModule("/stores/settingsStore.ts");
}

test("voice conversation is off until the user turns it on, and the choice persists", async (t) => {
  const s = await loadStore(t, {}, "openwhispr-voice-conversation-setting-test-");
  assert.equal(s.useSettingsStore.getState().voiceConversationEnabled, false);

  s.useSettingsStore.getState().setVoiceConversationEnabled(true);

  assert.equal(s.useSettingsStore.getState().voiceConversationEnabled, true);
  assert.equal(localStorage.getItem("voiceConversationEnabled"), "true");
});
