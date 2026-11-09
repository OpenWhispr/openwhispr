const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const registry = require("../../src/models/modelRegistryData.json");

// Upload, the batch queue and Chat's mic read keys through this switch, so a
// provider it doesn't know gets no key there even while Settings shows one.
test("every single-key transcription provider resolves its own key for uploads", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-transcription-keys-test-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  const { getTranscriptionApiKey } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  // Corti authenticates with a client id and secret rather than one key.
  const providers = registry.transcriptionProviders
    .map((provider) => provider.id)
    .filter((id) => id !== "corti");
  const keys = Object.fromEntries(providers.map((id) => [`${id}ApiKey`, `${id}-key`]));

  for (const id of providers) {
    assert.equal(getTranscriptionApiKey(id, keys), `${id}-key`, id);
  }
});
