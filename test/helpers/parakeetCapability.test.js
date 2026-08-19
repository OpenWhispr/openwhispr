const test = require("node:test");
const assert = require("node:assert/strict");

const { getParakeetCapability } = require("../../src/helpers/parakeetCapability");

test("Parakeet supports macOS at and above the packaged ONNX Runtime floor", () => {
  assert.deepEqual(getParakeetCapability({ platform: "darwin", systemVersion: "15.5" }), {
    supported: true,
  });
  assert.deepEqual(getParakeetCapability({ platform: "darwin", systemVersion: "15.6.1" }), {
    supported: true,
  });
});

test("Parakeet rejects macOS below the packaged ONNX Runtime floor", () => {
  assert.deepEqual(getParakeetCapability({ platform: "darwin", systemVersion: "12.7.6" }), {
    supported: false,
    code: "PARAKEET_UNSUPPORTED_OS",
    message:
      "Parakeet requires macOS 15.5 or later. Use cloud transcription (or Whisper where supported) on this Mac.",
    minimumMacOSVersion: "15.5",
  });
});

test("Parakeet treats a missing system-version API as supported (plain Node)", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "getSystemVersion");
  delete process.getSystemVersion;
  t.after(() => {
    if (descriptor) Object.defineProperty(process, "getSystemVersion", descriptor);
  });

  assert.deepEqual(getParakeetCapability({ platform: "darwin" }), { supported: true });
});

test("Parakeet capability gating does not change Windows or Linux", () => {
  for (const platform of ["win32", "linux"]) {
    assert.deepEqual(getParakeetCapability({ platform, systemVersion: "1.0" }), {
      supported: true,
    });
  }
});
