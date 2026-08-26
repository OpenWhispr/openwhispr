const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
  resolveAgentDictationPillState,
  shouldBlockDictationWhilePanelOpen,
} = require("../../src/helpers/dictationLifecycle");

test("processing is the only lifecycle that suppresses a dictation hotkey", () => {
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.IDLE), false);
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.RECORDING), false);
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.PROCESSING), true);
});

test("main-process recording state follows confirmed renderer lifecycle", () => {
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.IDLE), false);
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.PROCESSING), false);
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.RECORDING), true);
});

test("unknown lifecycle input fails closed to idle", () => {
  assert.equal(normalizeDictationLifecycle("starting-a-new-recording"), DICTATION_LIFECYCLE.IDLE);
  assert.equal(shouldIgnoreDictationHotkey(undefined), false);
  assert.equal(isDictationRecording({}), false);
});

test("the Agent companion mirrors only ordinary dictation lifecycle", () => {
  assert.deepEqual(resolveAgentDictationPillState("recording", "dictation"), {
    lifecycle: "recording",
    interactive: true,
  });
  assert.deepEqual(resolveAgentDictationPillState("processing", "dictation"), {
    lifecycle: "processing",
    interactive: true,
  });
  assert.deepEqual(resolveAgentDictationPillState("recording", "assistant"), {
    lifecycle: "idle",
    interactive: false,
  });
  assert.deepEqual(resolveAgentDictationPillState("processing", "translation"), {
    lifecycle: "idle",
    interactive: false,
  });
});

test("regular dictation remains available while the assistant panel is open", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: true,
      assistantPanelBusy: true,
      inputKind: "dictation",
    }),
    false
  );
});

test("the assistant hotkey can still record an in-panel follow-up", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: true, inputKind: "assistant" }),
    false
  );
});

test("the assistant hotkey is blocked while the open panel is busy", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: true,
      assistantPanelBusy: true,
      inputKind: "assistant",
    }),
    true
  );
});

test("the assistant hotkey is blocked while an initial response thinks before the panel opens", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: false,
      assistantPanelBusy: true,
      inputKind: "assistant",
    }),
    true
  );
});

test("translation remains blocked while the assistant panel owns the shared surface", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: true, inputKind: "translation" }),
    true
  );
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: false, inputKind: "translation" }),
    false
  );
});
