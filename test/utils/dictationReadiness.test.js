const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/dictationReadiness.ts");

test("an idle state may start a dictation", async () => {
  const { canStartDictation } = await load();

  assert.equal(canStartDictation({}), true);
  assert.equal(
    canStartDictation({
      isRecording: false,
      isProcessing: false,
      isStreaming: false,
      isStreamingStartInProgress: false,
      isFinalizingStreaming: false,
    }),
    true
  );
});

test("every busy flag independently blocks a new dictation start", async () => {
  const { canStartDictation } = await load();

  // The full five-flag set: three call sites used to carry drifting subsets
  // of this list, so each flag is pinned individually.
  for (const flag of [
    "isRecording",
    "isProcessing",
    "isStreaming",
    "isStreamingStartInProgress",
    "isFinalizingStreaming",
  ]) {
    assert.equal(canStartDictation({ [flag]: true }), false, `${flag} must block a start`);
  }
});

test("a missing state snapshot fails closed", async () => {
  const { canStartDictation } = await load();

  assert.equal(canStartDictation(null), false);
  assert.equal(canStartDictation(undefined), false);
});
