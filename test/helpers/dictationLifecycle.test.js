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
      companionAvailable: true,
    }),
    false
  );
});

test("regular dictation is blocked while the open panel lacks a live companion", () => {
  // The open panel hands plain dictation's visuals to the companion pill; if
  // that window is still loading or its load failed, the recording would be
  // invisible, so it must not start.
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: true,
      inputKind: "dictation",
      companionAvailable: false,
    }),
    true
  );
  // With the panel closed the main pill owns the visuals; companion
  // availability is irrelevant.
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: false,
      inputKind: "dictation",
      companionAvailable: false,
    }),
    false
  );
});

test("regular dictation is blocked while a busy assistant has not opened its panel", () => {
  // The companion pill only exists once the panel opens; before that, a busy
  // assistant suppresses the main pill too, so a recording would be invisible.
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: false,
      assistantPanelBusy: true,
      inputKind: "dictation",
    }),
    true
  );
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: false,
      assistantPanelBusy: false,
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

test("mic preparation is a first-class lifecycle mirrored only for ordinary dictation", () => {
  assert.equal(normalizeDictationLifecycle("preparing"), "preparing");
  assert.equal(shouldIgnoreDictationHotkey("preparing"), false);
  assert.equal(isDictationRecording("preparing"), false);
  assert.deepEqual(resolveAgentDictationPillState("preparing", "dictation"), {
    lifecycle: "preparing",
    interactive: true,
  });
  assert.deepEqual(resolveAgentDictationPillState("preparing", "assistant"), {
    lifecycle: "idle",
    interactive: false,
  });
  assert.deepEqual(resolveAgentDictationPillState("preparing", "translation"), {
    lifecycle: "idle",
    interactive: false,
  });
});
