const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationErrorDuration.js");

test("short dictation errors dismiss after three seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Paste Error", "Please try again."), 3000);
});

test("medium dictation errors dismiss after four seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Error", "a".repeat(100)), 4000);
});

test("long dictation errors dismiss after five seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Error", "a".repeat(200)), 5000);
});
