const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationRouting.js");

// The raw and cleaned dictation hotkeys replace the global cleanup preference
// for one recording and nothing else — they never make an unconfigured cleanup
// reachable, and they never write the preference.

test("no override follows the global cleanup preference", async () => {
  const { resolveCleanupSelection } = await load();

  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: null,
      useCleanupPreference: true,
      cleanupConfigured: true,
    }),
    { selected: true, reachable: true }
  );
  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: null,
      useCleanupPreference: false,
      cleanupConfigured: true,
    }),
    { selected: false, reachable: false }
  );
});

test("raw skips cleanup whether the preference is on or off", async () => {
  const { resolveCleanupSelection } = await load();

  for (const useCleanupPreference of [true, false]) {
    assert.deepEqual(
      resolveCleanupSelection({
        cleanupOverride: "raw",
        useCleanupPreference,
        cleanupConfigured: true,
      }),
      { selected: false, reachable: false },
      `preference ${useCleanupPreference}`
    );
  }
});

test("cleaned runs cleanup whether the preference is on or off", async () => {
  const { resolveCleanupSelection } = await load();

  for (const useCleanupPreference of [true, false]) {
    assert.deepEqual(
      resolveCleanupSelection({
        cleanupOverride: "cleaned",
        useCleanupPreference,
        cleanupConfigured: true,
      }),
      { selected: true, reachable: true },
      `preference ${useCleanupPreference}`
    );
  }
});

// The cleaned hotkey cannot manufacture missing configuration: it still asks
// for cleanup, so the recording is unreachable and the transcript pastes as
// spoken instead of passing as cleaned.
test("cleaned with no cleanup model configured is selected but unreachable", async () => {
  const { resolveCleanupSelection } = await load();

  assert.deepEqual(
    resolveCleanupSelection({
      cleanupOverride: "cleaned",
      useCleanupPreference: false,
      cleanupConfigured: false,
    }),
    { selected: true, reachable: false }
  );
});

// What the user is TOLD about that gap is upstream's unconfigured-cleanup
// notice, which reads the cleanup preference. A pinned row IS the preference
// for its own recording, so the notice follows the row: Always on warns about
// a setup it cannot run even while the global preference is off, and Always
// off stays silent even while the preference is on.
test("the unconfigured-cleanup notice follows the row's own choice", async () => {
  const { cleanupUnconfiguredNotice } = await load();
  const unreachable = { skipped: true, cleanupReachable: false };

  const pinnedOn = cleanupUnconfiguredNotice(null, {
    ...unreachable,
    settings: { useCleanupModel: true },
  });
  assert.equal(pinnedOn.notice?.messageKey, "hooks.audioRecording.cleanupUnconfigured");

  const pinnedOff = cleanupUnconfiguredNotice(null, {
    ...unreachable,
    settings: { useCleanupModel: false },
  });
  assert.equal(pinnedOff.notice, null);
  assert.equal(pinnedOff.forget, true, "nothing was asked for, so nothing is remembered");
});

test("an unknown override value falls back to the preference", async () => {
  const { resolveCleanupSelection, isExplicitCleanupMode } = await load();

  assert.equal(
    resolveCleanupSelection({
      cleanupOverride: "sparkling",
      useCleanupPreference: true,
      cleanupConfigured: true,
    }).selected,
    true
  );
  assert.equal(isExplicitCleanupMode("sparkling"), false);
  assert.equal(isExplicitCleanupMode(null), false);
  assert.equal(isExplicitCleanupMode("raw"), true);
  assert.equal(isExplicitCleanupMode("cleaned"), true);
});

test("raw routes to skip and cleaned to cleanup", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      cleanupOverride: "raw",
    }),
    "skip"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: false,
      agentInvoked: false,
      cleanupOverride: "cleaned",
    }),
    "cleanup"
  );
});

// Explicit raw/cleaned dictation stays dictation even when the transcript
// happens to contain the wake phrase.
test("an explicit mode never takes the wake-word agent route", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: true,
      cleanupOverride: "raw",
    }),
    "skip"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
      cleanupOverride: "cleaned",
    }),
    "cleanup"
  );
});

// A cleaned recording whose configured model is unreachable pastes the raw
// transcript rather than silently borrowing the dictation agent.
test("cleaned with an unreachable cleanup model skips rather than falling back", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: true,
      agentInvoked: false,
      cleanupOverride: "cleaned",
    }),
    "skip"
  );
});

// Neither hotkey can start an assistant or translation recording, but the
// precedence is pinned so a stale flag can never be resolved by the override.
test("the voice assistant and translation requests still outrank an override", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      voiceAgentRequested: true,
      cleanupOverride: "raw",
    }),
    "agent"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
      translationRequested: true,
      translationReachable: true,
      cleanupOverride: "raw",
    }),
    "translation"
  );
});

// Default dictation must behave exactly as it did before the overrides existed.
test("without an override the existing priority order is unchanged", async () => {
  const { resolveDictationRouteKind } = await load();

  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: true,
    }),
    "agent"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: true,
      agentReachable: true,
      agentInvoked: false,
    }),
    "cleanup"
  );
  assert.equal(
    resolveDictationRouteKind({
      cleanupReachable: false,
      agentReachable: false,
      agentInvoked: false,
    }),
    "skip"
  );
});
