const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Each scope's `*TranscriptionMode` is what its Settings picker renders and what
// the user last chose. Dictation and upload route on two *other* keys beside it:
// `*UseLocalWhisper` (audioManager's processAudio/shouldUseStreaming;
// fileTranscription) and `*CloudTranscriptionMode` (`isOpenWhisprCloud`). A
// since-removed post-sign-in effect wrote both of those and neither mode (#2086),
// so a profile could show "Local · Active" or "API Keys · Active" while audio
// went to OpenWhispr Cloud, and clicking the shown mode was a no-op because each
// picker skips the mode it already renders. The store repairs both on load.
//
// `_providerSettingsMigrated: "1"` must be seeded: migrateProviderSettings() runs
// first and would otherwise re-derive `transcriptionMode` from the very flag
// under test.
const MIGRATED = { _providerSettingsMigrated: "1" };
// The meeting and upload one-shot copies mirror the dictation keys once and then
// latch, so seed them done except where a case is about that copy.
const COPIES_DONE = { meetingFollowsTranscription: "false", uploadTranscriptionMigrated: "true" };

test("startup repairs transcription routing that disagrees with the selected mode", async (t) => {
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

  // The same effect also wrote cloudTranscriptionMode="openwhispr", which is what
  // `isOpenWhisprCloud` routes on. A user who picked their own API keys or their
  // own endpoint was billed against managed cloud while the picker said otherwise.
  for (const mode of ["providers", "self-hosted"]) {
    await t.test(`a stale "${mode}" mode over managed-cloud routing goes back to BYOK`, async () => {
      const state = await load({
        ...MIGRATED,
        ...COPIES_DONE,
        transcriptionMode: mode,
        useLocalWhisper: "false",
        cloudTranscriptionMode: "openwhispr",
      });
      assert.equal(state.cloudTranscriptionMode, "byok");
      assert.equal(storage.getItem("cloudTranscriptionMode"), "byok");
      assert.equal(state.transcriptionMode, mode);
      assert.equal(state.useLocalWhisper, false, "still cloud, just the user's own");
    });
  }

  await t.test("the upload scope's cloud mode is repaired too", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      uploadTranscriptionMode: "providers",
      uploadUseLocalWhisper: "false",
      uploadCloudTranscriptionMode: "openwhispr",
    });
    assert.equal(state.uploadCloudTranscriptionMode, "byok");
    assert.equal(storage.getItem("uploadCloudTranscriptionMode"), "byok");
  });

  // The repair only ever moves away from OpenWhispr Cloud. Completing it
  // symmetrically would take a profile whose picker reads "OpenWhispr Cloud" but
  // whose routing points at the user's own credential — written that way by the
  // onboarding provider step before its commit — and start uploading their audio.
  await t.test("an OpenWhispr Cloud mode never claims a BYOK credential", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "openwhispr",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
    });
    assert.equal(state.cloudTranscriptionMode, "byok");
    assert.equal(storage.getItem("cloudTranscriptionMode"), "byok");
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

  await t.test("the upload scope's local flag is repaired too", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "false",
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: "false",
    });
    assert.equal(state.uploadUseLocalWhisper, true);
    assert.equal(storage.getItem("uploadUseLocalWhisper"), "true");
  });

  // Note Recording is deliberately absent from the repair: resolveMeetingTranscription-
  // Options branches on meetingTranscriptionMode — the same key MeetingSettings
  // renders — so its picker and its router cannot disagree. meetingUseLocalWhisper
  // has no reader at all; repairing it would only write reassuring dead state.
  await t.test("the meeting scope is left alone, because it routes on its own mode", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      meetingTranscriptionMode: "local",
      meetingUseLocalWhisper: "false",
    });
    assert.equal(state.meetingTranscriptionMode, "local", "the mode its router reads");
    assert.equal(storage.getItem("meetingUseLocalWhisper"), "false", "left untouched");
    assert.equal(
      writes.includes("meetingUseLocalWhisper"),
      false,
      "no write to a key nothing reads"
    );
  });

  // The upload one-shot copy mirrors the dictation keys wholesale, desync
  // included, and then latches — so the repair has to run after it, not before.
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

  await t.test("an agreeing profile is not rewritten", async () => {
    const state = await load({
      ...MIGRATED,
      ...COPIES_DONE,
      transcriptionMode: "local",
      useLocalWhisper: "true",
      cloudTranscriptionMode: "byok",
    });
    assert.equal(state.useLocalWhisper, true);
    assert.deepEqual(
      writes.filter((key) => /UseLocalWhisper$|^useLocalWhisper$|CloudTranscriptionMode$/.test(key)),
      [],
      "no routing key should be written when the profile already agrees"
    );
  });

  await t.test("a profile with no stored mode is left untouched", async () => {
    const state = await load({ ...MIGRATED, ...COPIES_DONE, useLocalWhisper: "true" });
    assert.equal(state.useLocalWhisper, true);
    assert.equal(storage.getItem("useLocalWhisper"), "true");
    assert.equal(storage.getItem("uploadUseLocalWhisper"), null);
  });
});
