const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Each scope's `*TranscriptionMode` is what its Settings picker renders and what
// the user last chose; `*UseLocalWhisper` is the flag routing obeys (dictation:
// audioManager's processAudio/shouldUseStreaming; upload: fileTranscription).
// A since-removed post-sign-in effect wrote only the dictation flag (#2086), so
// a profile could show "Local · Active" while audio went to OpenWhispr Cloud,
// and clicking Local was a no-op because each picker skips the mode it already
// renders. The store repairs that pair on load.
//
// `_providerSettingsMigrated: "1"` must be seeded: migrateProviderSettings() runs
// first and would otherwise re-derive `transcriptionMode` from the very flag
// under test.
const MIGRATED = { _providerSettingsMigrated: "1" };
// The meeting and upload one-shot copies mirror the dictation pair once and then
// latch, so seed them done except where a case is about that copy.
const COPIES_DONE = { meetingFollowsTranscription: "false", uploadTranscriptionMigrated: "true" };

test("startup repairs a transcription mode/flag desync toward local", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-transcription-mode-reconcile-test-",
  });

  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const writes = [];
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    writes.length = 0;
    vite.moduleGraph.invalidateAll();
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return useSettingsStore.getState();
  };

  await t.test("a Local selection whose flag says cloud routes locally again", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(state.transcriptionMode, "local");
    assert.equal(storage.getItem("useLocalWhisper"), "true");
  });

  // The repair only ever moves toward local. A stale cloud mode over a
  // deliberate local flag must never start uploading a local user's audio:
  // the mode-less Settings toggle wrote the flag alone until 6fb0c906, so
  // profiles with a stale non-local mode and local routing exist in the field.
  for (const mode of ["openwhispr", "providers", "self-hosted", "enterprise", "nonsense"]) {
    await t.test(`a stale "${mode}" mode never flips a local user to the cloud`, async () => {
      const state = await load({
        ...MIGRATED,
        ...COPIES_DONE,
        transcriptionMode: mode,
        useLocalWhisper: "true",
      });
      assert.equal(state.useLocalWhisper, true);
      assert.equal(storage.getItem("useLocalWhisper"), "true");
    });
  }

  await t.test("the meeting and upload scopes are repaired too", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "false",
      meetingTranscriptionMode: "local",
      meetingUseLocalWhisper: "false",
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: "false",
    });
    assert.equal(state.meetingUseLocalWhisper, true, "meeting");
    assert.equal(state.uploadUseLocalWhisper, true, "upload");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "true");
    assert.equal(storage.getItem("uploadUseLocalWhisper"), "true");
  });

  // Both one-shot copies mirror the dictation pair wholesale, desync included,
  // and then latch — so the repair has to run after them, not before.
  await t.test("a desync copied into the meeting scope by its one-shot is repaired", async () => {
    const state = await load({
      ...MIGRATED,
      uploadTranscriptionMigrated: "true",
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(storage.getItem("meetingTranscriptionMode"), "local", "the copy ran");
    assert.equal(state.meetingUseLocalWhisper, true);
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "true");
  });

  await t.test("a desync copied into the upload scope by its one-shot is repaired", async () => {
    const state = await load({
      ...MIGRATED,
      meetingFollowsTranscription: "false",
      transcriptionMode: "local",
      useLocalWhisper: "false",
    });
    assert.equal(storage.getItem("uploadTranscriptionMode"), "local", "the copy ran");
    assert.equal(state.uploadUseLocalWhisper, true);
    assert.equal(storage.getItem("uploadUseLocalWhisper"), "true");
  });

  await t.test("an agreeing pair is not rewritten", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "true",
    });
    assert.equal(state.useLocalWhisper, true);
    assert.deepEqual(
      writes.filter((key) => key.endsWith("UseLocalWhisper") || key === "useLocalWhisper"),
      [],
      "no flag should be written when the pair already agrees"
    );
  });

  await t.test("a profile with no stored mode is left untouched", async () => {
    const state = await load({ ...MIGRATED, ...COPIES_DONE, useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(storage.getItem("useLocalWhisper"), "true");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), null);
    assert.equal(storage.getItem("uploadUseLocalWhisper"), null);
  });
});
