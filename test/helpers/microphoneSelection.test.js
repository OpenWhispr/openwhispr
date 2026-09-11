const test = require("node:test");
const assert = require("node:assert/strict");

const mic = (deviceId, label) => ({ kind: "audioinput", deviceId, label });

const load = async () => {
  const mod = await import("../../src/helpers/microphoneSelection.js");
  return mod.resolveMicrophoneSelection ? mod : mod.default;
};

test("system mode maps the native default name to an exact Chromium input", async () => {
  const { resolveMicrophoneSelection } = await load();
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
  const { isCacheableMicrophoneResolution, resolveMicrophoneSelection } = await load();
  const expected = mic("default", "Default - Microphone Array");
  const result = resolveMicrophoneSelection([expected, mic("continuity", "Joshua P Microphone")], {
    microphoneSelectionMode: "system",
  });

  assert.equal(result.device, expected);
  assert.equal(result.status, "chromium-default");
  assert.equal(isCacheableMicrophoneResolution(result), false);
});

test("a resolved physical microphone can be cached", async () => {
  const { isCacheableMicrophoneResolution, resolveMicrophoneSelection } = await load();
  const result = resolveMicrophoneSelection(
    [mic("default", "Default - USB Microphone"), mic("usb", "USB Microphone")],
    { microphoneSelectionMode: "system" },
    { name: "USB Microphone" }
  );

  assert.equal(isCacheableMicrophoneResolution(result), true);
});

test("system mode never guesses the first physical microphone", async () => {
  const { resolveMicrophoneSelection } = await load();
  const result = resolveMicrophoneSelection(
    [mic("continuity", "Joshua P Microphone"), mic("usb", "USB Microphone")],
    { microphoneSelectionMode: "system" },
    { name: "Missing System Microphone" }
  );

  assert.equal(result.device, null);
  assert.equal(result.status, "native-unmatched");
});

test("legacy microphone preferences retain their behavior", async () => {
  const { getMicrophoneSelectionMode } = await load();

  assert.equal(getMicrophoneSelectionMode({ preferBuiltInMic: true }), "built-in");
  assert.equal(
    getMicrophoneSelectionMode({ preferBuiltInMic: false, selectedMicDeviceId: "usb" }),
    "specific"
  );
  assert.equal(getMicrophoneSelectionMode({ preferBuiltInMic: false }), "system");
});

test("built-in mode safely skips devices with null, undefined, or empty labels without throwing", async () => {
  const { resolveMicrophoneSelection } = await load();
  const unlabeled = { kind: "audioinput", deviceId: "raw-mic-1" };
  const nullLabel = { kind: "audioinput", deviceId: "raw-mic-2", label: null };
  const emptyLabel = { kind: "audioinput", deviceId: "raw-mic-3", label: "" };

  const result = resolveMicrophoneSelection([unlabeled, nullLabel, emptyLabel], {
    microphoneSelectionMode: "built-in",
  });

  assert.equal(result.device, null);
  assert.equal(result.status, "unavailable");
});

test("built-in mode finds real built-in mic even among unlabeled devices", async () => {
  const { resolveMicrophoneSelection } = await load();
  const unlabeled = { kind: "audioinput", deviceId: "raw-mic-1" };
  const nullLabel = { kind: "audioinput", deviceId: "raw-mic-2", label: null };
  const builtIn = mic("macbook", "MacBook Pro Microphone");

  const result = resolveMicrophoneSelection([unlabeled, nullLabel, builtIn], {
    microphoneSelectionMode: "built-in",
  });

  assert.equal(result.device, builtIn);
  assert.equal(result.status, "built-in");
});

test("normalizeMicrophoneLabel handles null, undefined, and non-string inputs safely", async () => {
  const { normalizeMicrophoneLabel } = await load();

  assert.equal(normalizeMicrophoneLabel(null), "");
  assert.equal(normalizeMicrophoneLabel(undefined), "");
  assert.equal(normalizeMicrophoneLabel(""), "");
  assert.equal(normalizeMicrophoneLabel(123), "");
  assert.equal(
    normalizeMicrophoneLabel("  Default - Built-in Microphone (Built-in)  "),
    "built-in microphone"
  );
});
