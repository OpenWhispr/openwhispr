const test = require("node:test");
const assert = require("node:assert/strict");

const WhisperServerManager = require("../../src/helpers/whisperServer");
const { getStartupCrashHint } = WhisperServerManager;

test("getStartupCrashHint flags Windows STATUS_ILLEGAL_INSTRUCTION exit code", () => {
  const hint = getStartupCrashHint({ exitCode: 3221225501 });
  assert.match(hint, /AVX/);
  assert.match(hint, /NVIDIA/);
});

test("getStartupCrashHint flags SIGILL crashes on macOS/Linux", () => {
  const hint = getStartupCrashHint({ exitCode: null, exitSignal: "SIGILL" });
  assert.match(hint, /AVX/);
});

test("getStartupCrashHint returns empty string for ordinary failures", () => {
  assert.equal(getStartupCrashHint({ exitCode: 1 }), "");
  assert.equal(getStartupCrashHint({ exitCode: null, exitSignal: "SIGTERM" }), "");
  assert.equal(getStartupCrashHint({}), "");
  assert.equal(getStartupCrashHint(), "");
});
