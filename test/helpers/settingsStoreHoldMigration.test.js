const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The migration runs at module scope, so every case imports the store fresh
// (its own cachePrefix) and reads the storage the import left behind.
async function importStore(t, { initialStorage, cachePrefix }) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: { electronAPI: {} },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  return { storage, state: useSettingsStore.getState(), useSettingsStore };
}

test("an existing install with untouched modes moves every slot to Hold and arms the card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-existing-",
    initialStorage: { onboardingCompleted: "true" },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
  assert.equal(storage.getItem("activationMode"), "push");
  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "true");
  assert.equal(state.holdMigrationCardPending, true);
  assert.equal(state.holdMigrationCardShown, false);
});

test("a stored Tap becomes Hold and a stored Hold stays untouched", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-stored-tap-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "tap",
      voiceAgentActivationMode: "push",
    },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(storage.getItem("holdMigrationCardPending"), "true");
});

test("an install already on Hold everywhere arms no card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-already-hold-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "push",
      voiceAgentActivationMode: "push",
      translationActivationMode: "push",
    },
  });

  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
  assert.equal(state.holdMigrationCardPending, false);
});

// The case above seeds all three keys explicitly as "push", which is not
// the shape a real upgrade takes — a user already on Hold typically only
// ever had the dictation slot (activationMode) stored, and the voice-agent
// and translation slots are absent or still "tap". The card's copy only
// ever talks about the dictation hotkey, so those siblings moving to Hold
// must migrate them like any other slot, but must NOT arm a card that
// would announce a dictation change that never happened.
test("dictation already on Hold with absent siblings migrates them but arms no card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-dictation-hold-siblings-absent-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "push",
    },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
  assert.equal(storage.getItem("voiceAgentActivationMode"), "push");
  assert.equal(storage.getItem("translationActivationMode"), "push");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
  assert.equal(state.holdMigrationCardPending, false);
});

test("dictation already on Hold with siblings stored Tap migrates them but arms no card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-dictation-hold-siblings-tap-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "push",
      voiceAgentActivationMode: "tap",
      translationActivationMode: "tap",
    },
  });

  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
  assert.equal(state.holdMigrationCardPending, false);
});

test("dictation moving from Tap to Hold arms the card even when both siblings are already Hold", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-dictation-only-change-",
    initialStorage: {
      onboardingCompleted: "true",
      activationMode: "tap",
      voiceAgentActivationMode: "push",
      translationActivationMode: "push",
    },
  });

  assert.equal(state.activationMode, "push");
  assert.equal(state.voiceAgentActivationMode, "push");
  assert.equal(state.translationActivationMode, "push");
  assert.equal(storage.getItem("holdMigrationCardPending"), "true");
  assert.equal(state.holdMigrationCardPending, true);
});

test("a fresh install defaults to Hold without a migration and never arms the card", async (t) => {
  const { storage, state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-fresh-",
    initialStorage: {},
  });

  assert.equal(state.activationMode, "push");
  assert.equal(storage.getItem("activationMode"), null);
  assert.equal(storage.getItem("activationModeHoldMigration"), "done");
  assert.equal(storage.getItem("holdMigrationCardPending"), "false");
});

test("after the marker a stored Tap is a capability verdict and stays Tap", async (t) => {
  const { state } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-marker-",
    initialStorage: {
      onboardingCompleted: "true",
      activationModeHoldMigration: "done",
      activationMode: "tap",
    },
  });

  assert.equal(state.activationMode, "tap");
});

test("the card-shown flag persists through its setter", async (t) => {
  const { storage, state, useSettingsStore } = await importStore(t, {
    cachePrefix: "openwhispr-hold-migration-shown-",
    initialStorage: { onboardingCompleted: "true" },
  });

  state.setHoldMigrationCardShown(true);

  assert.equal(useSettingsStore.getState().holdMigrationCardShown, true);
  assert.equal(storage.getItem("holdMigrationCardShown"), "true");
});
