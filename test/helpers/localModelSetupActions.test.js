const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveLocalModelSetupActions,
} = require("../../src/components/onboarding/localModelSetupActions.ts");

test("local dictation setup cannot skip its required model", () => {
  assert.deepEqual(
    resolveLocalModelSetupActions({
      assistant: false,
      selectedReady: false,
      anyDownloadActive: false,
      canProceed: false,
    }),
    { showSkip: false, skipDisabled: false, preservePending: false }
  );
});

test("local assistant setup can finish without selecting an assistant model", () => {
  assert.deepEqual(
    resolveLocalModelSetupActions({
      assistant: true,
      selectedReady: false,
      anyDownloadActive: false,
      canProceed: false,
    }),
    { showSkip: true, skipDisabled: false, preservePending: false }
  );
});

test("skipping a selected model download keeps it available in the background", () => {
  assert.deepEqual(
    resolveLocalModelSetupActions({
      assistant: true,
      selectedReady: false,
      anyDownloadActive: true,
      canProceed: true,
    }),
    { showSkip: true, skipDisabled: false, preservePending: true }
  );
});

test("a local assistant can still be skipped while no model is ready", () => {
  assert.deepEqual(
    resolveLocalModelSetupActions({
      assistant: true,
      selectedReady: false,
      anyDownloadActive: true,
      canProceed: false,
    }),
    { showSkip: true, skipDisabled: false, preservePending: false }
  );
});

test("an unusable dictation download keeps Skip disabled", () => {
  assert.deepEqual(
    resolveLocalModelSetupActions({
      assistant: false,
      selectedReady: false,
      anyDownloadActive: true,
      canProceed: false,
    }),
    { showSkip: true, skipDisabled: true, preservePending: false }
  );
});
