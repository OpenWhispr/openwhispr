const test = require("node:test");
const assert = require("node:assert/strict");

const mic = (deviceId, label) => ({ kind: "audioinput", deviceId, label });

test("system mode maps the native default name to an exact Chromium input", async () => {
  const { resolveMicrophoneSelection } = await import("../../src/helpers/microphoneSelection.js");
  const expected = mic("macbook", "MacBook Pro Microphone (Built-in)");
  const result = resolveMicrophoneSelection(
    [mic("default", "Default - MacBook Pro Microphone (Built-in)"), expected],
    { microphoneSelectionMode: "system" },
    { name: "MacBook Pro Microphone" }
  );

  assert.equal(result.device, expected);
  assert.equal(result.status, "native-exact");
});

test("system mode uses Chromium's explicit default device when native mapping is unavailable", async () => {
  const { isCacheableMicrophoneResolution, resolveMicrophoneSelection } =
    await import("../../src/helpers/microphoneSelection.js");
  const expected = mic("default", "Default - Microphone Array");
  const result = resolveMicrophoneSelection([expected, mic("continuity", "Joshua P Microphone")], {
    microphoneSelectionMode: "system",
  });

  assert.equal(result.device, expected);
  assert.equal(result.status, "chromium-default");
  assert.equal(isCacheableMicrophoneResolution(result), false);
});

test("a resolved physical microphone can be cached", async () => {
  const { isCacheableMicrophoneResolution, resolveMicrophoneSelection } =
    await import("../../src/helpers/microphoneSelection.js");
  const result = resolveMicrophoneSelection(
    [mic("default", "Default - USB Microphone"), mic("usb", "USB Microphone")],
    { microphoneSelectionMode: "system" },
    { name: "USB Microphone" }
  );

  assert.equal(isCacheableMicrophoneResolution(result), true);
});

test("system mode never guesses the first physical microphone", async () => {
  const { resolveMicrophoneSelection } = await import("../../src/helpers/microphoneSelection.js");
  const result = resolveMicrophoneSelection(
    [mic("continuity", "Joshua P Microphone"), mic("usb", "USB Microphone")],
    { microphoneSelectionMode: "system" },
    { name: "Missing System Microphone" }
  );

  assert.equal(result.device, null);
  assert.equal(result.status, "native-unmatched");
});

test("legacy microphone preferences retain their behavior", async () => {
  const { getMicrophoneSelectionMode } = await import("../../src/helpers/microphoneSelection.js");

  assert.equal(getMicrophoneSelectionMode({ preferBuiltInMic: true }), "built-in");
  assert.equal(
    getMicrophoneSelectionMode({ preferBuiltInMic: false, selectedMicDeviceId: "usb" }),
    "specific"
  );
  assert.equal(getMicrophoneSelectionMode({ preferBuiltInMic: false }), "system");
});
