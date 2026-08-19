const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
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

test("regular dictation is blocked while the assistant panel is open", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: true, voiceAgentRequested: false }),
    true
  );
});

test("the assistant hotkey can still record an in-panel follow-up", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: true, voiceAgentRequested: true }),
    false
  );
});

test("the assistant hotkey is blocked while the open panel is busy", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: true,
      assistantPanelBusy: true,
      voiceAgentRequested: true,
    }),
    true
  );
});

test("the assistant hotkey is blocked while an initial response thinks before the panel opens", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({
      assistantPanelOpen: false,
      assistantPanelBusy: true,
      voiceAgentRequested: true,
    }),
    true
  );
});

test("regular dictation resumes after the assistant panel closes", () => {
  assert.equal(
    shouldBlockDictationWhilePanelOpen({ assistantPanelOpen: false, voiceAgentRequested: false }),
    false
  );
});
