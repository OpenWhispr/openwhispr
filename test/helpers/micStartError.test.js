const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/micStartError.js");
const named = (name) => Object.assign(new Error("boom"), { name });

test("a microphone another app holds is MIC_IN_USE, with the exclusive-mode advice only on Windows", async () => {
  const { describeMicStartError } = await load();
  for (const name of ["NotReadableError", "TrackStartError"]) {
    assert.deepEqual(describeMicStartError(named(name), "win32"), {
      code: "MIC_IN_USE",
      title: "Microphone In Use",
      messageKey: "hooks.audioRecording.errorDescriptions.micInUseWindows",
    });
    for (const platform of ["darwin", "linux"]) {
      assert.equal(
        describeMicStartError(named(name), platform).messageKey,
        "hooks.audioRecording.errorDescriptions.micInUse"
      );
    }
  }
});

test("denied, missing and muted microphones each get their own code", async () => {
  const { describeMicStartError } = await load();
  const cases = [
    ["NotAllowedError", "MIC_PERMISSION_DENIED", "micPermissionDenied"],
    ["PermissionDeniedError", "MIC_PERMISSION_DENIED", "micPermissionDenied"],
    ["NotFoundError", "MIC_NOT_FOUND", "micNotFound"],
    ["DevicesNotFoundError", "MIC_NOT_FOUND", "micNotFound"],
    ["MicUnusableError", "MIC_MUTED", "micMuted"],
  ];
  for (const [name, code, key] of cases) {
    const report = describeMicStartError(named(name), "win32");
    assert.equal(report.code, code, name);
    assert.equal(report.messageKey, `hooks.audioRecording.errorDescriptions.${key}`, name);
  }
});

test("a failure that isn't the microphone's is left to the caller", async () => {
  const { describeMicStartError } = await load();
  assert.equal(describeMicStartError(new Error("socket closed"), "win32"), null);
  assert.equal(describeMicStartError(named("OverconstrainedError"), "win32"), null);
  assert.equal(describeMicStartError(undefined, "win32"), null);
});
