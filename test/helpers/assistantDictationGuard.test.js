const test = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldBlockNonAgentDictation,
} = require("../../src/helpers/assistantDictationGuard.js");

test("regular dictation is blocked while the assistant panel is open", () => {
  assert.equal(
    shouldBlockNonAgentDictation({ assistantPanelOpen: true, voiceAgentRequested: false }),
    true
  );
});

test("the assistant hotkey can still record an in-panel follow-up", () => {
  assert.equal(
    shouldBlockNonAgentDictation({ assistantPanelOpen: true, voiceAgentRequested: true }),
    false
  );
});

test("regular dictation resumes after the assistant panel closes", () => {
  assert.equal(
    shouldBlockNonAgentDictation({ assistantPanelOpen: false, voiceAgentRequested: false }),
    false
  );
});
