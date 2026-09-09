const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// `transcriptionMode` is what the Settings picker renders and what the user last
// chose; `useLocalWhisper` is the flag routing obeys. A since-removed post-sign-in
// effect wrote only the flag (#2086), so a profile could show "Local · Active"
// while dictating to OpenWhispr Cloud. The store must repair that pair on load,
// from the mode, for the dictation scope only.
//
// `_providerSettingsMigrated: "1"` must be seeded: migrateProviderSettings() runs
// first and would otherwise re-derive `transcriptionMode` from the very flag under
// test. The meeting/upload one-shot copies are marked done so they stay out of the
// picture unless a case opts in (a `null` seed leaves that key absent).
const SETTLED = {
  _providerSettingsMigrated: "1",
  meetingFollowsTranscription: "false",
  uploadTranscriptionMigrated: "true",
};

test("startup reconciles useLocalWhisper with transcriptionMode for dictation", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-mode-reconcile-test-",
  });

  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries({ ...SETTLED, ...seed })) {
      if (value !== null) storage.setItem(key, value);
    }
    vite.moduleGraph.invalidateAll();
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return useSettingsStore.getState();
  };

  await t.test("local mode with a stale cloud flag routes locally again", async () => {
    const state = await load({ transcriptionMode: "local", useLocalWhisper: "false" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(state.transcriptionMode, "local");
    assert.equal(storage.getItem("useLocalWhisper"), "true");
  });

  await t.test("providers mode with a stale local flag routes to the cloud", async () => {
    const state = await load({ transcriptionMode: "providers", useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, false);
    assert.equal(storage.getItem("useLocalWhisper"), "false");
  });

  await t.test("self-hosted mode with a stale local flag routes to the cloud", async () => {
    const state = await load({ transcriptionMode: "self-hosted", useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, false);
    assert.equal(storage.getItem("useLocalWhisper"), "false");
  });

  await t.test("a missing transcriptionMode leaves the flag alone", async () => {
    const state = await load({ useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(storage.getItem("useLocalWhisper"), "true");
    assert.equal(storage.getItem("transcriptionMode"), null);
  });

  await t.test("an agreeing pair is untouched", async () => {
    const state = await load({ transcriptionMode: "local", useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(storage.getItem("useLocalWhisper"), "true");
    assert.equal(storage.getItem("transcriptionMode"), "local");
  });

  await t.test("the removed migration's hand-off keys are cleared", async () => {
    await load({ pendingCloudMigration: "true", cloudMigrationShown: "true" });
    assert.equal(storage.getItem("pendingCloudMigration"), null);
    assert.equal(storage.getItem("cloudMigrationShown"), null);
  });

  await t.test("the upload one-time copy sees the repaired flag", async () => {
    // Reconcile runs before migrateUploadTranscription(), so a first-time upload
    // seed inherits a consistent pair instead of copying the desync across.
    const state = await load({
      uploadTranscriptionMigrated: null,
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(storage.getItem("uploadUseLocalWhisper"), "true");
    assert.equal(storage.getItem("uploadTranscriptionMode"), "local");
    assert.equal(state.uploadUseLocalWhisper, true);
  });
});
