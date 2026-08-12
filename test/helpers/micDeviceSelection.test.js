const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/micDeviceSelection.js");

const mic = (deviceId, label) => ({ kind: "audioinput", deviceId, label });

test("uses the saved device ID while it is still available", async () => {
  const { resolveMicDeviceSelection } = await load();
  const device = mic("saved-id", "Studio Mic");

  assert.deepEqual(resolveMicDeviceSelection([device], "saved-id", "Studio Mic"), {
    device,
    status: "exact",
  });
});

test("remaps a stale ID when exactly one microphone has the saved label", async () => {
  const { resolveMicDeviceSelection } = await load();
  const device = mic("new-id", "Studio Mic");

  assert.deepEqual(resolveMicDeviceSelection([device], "old-id", "Studio Mic"), {
    device,
    status: "remapped",
  });
});

test("does not guess when multiple microphones have the saved label", async () => {
  const { resolveMicDeviceSelection } = await load();

  assert.deepEqual(
    resolveMicDeviceSelection(
      [mic("first", "USB Audio"), mic("second", "USB Audio")],
      "old-id",
      "USB Audio"
    ),
    { device: null, status: "ambiguous" }
  );
});

test("keeps an unplugged microphone preference unresolved", async () => {
  const { resolveMicDeviceSelection } = await load();

  assert.deepEqual(resolveMicDeviceSelection([], "old-id", "Studio Mic"), {
    device: null,
    status: "missing",
  });
});

test("does not remap a stale ID without a saved label", async () => {
  const { resolveMicDeviceSelection } = await load();

  assert.deepEqual(resolveMicDeviceSelection([mic("new-id", "Studio Mic")], "old-id", ""), {
    device: null,
    status: "missing",
  });
});

test("ignores non-input devices when remapping", async () => {
  const { resolveMicDeviceSelection } = await load();
  const output = { kind: "audiooutput", deviceId: "speaker", label: "Studio Mic" };

  assert.deepEqual(resolveMicDeviceSelection([output], "old-id", "Studio Mic"), {
    device: null,
    status: "missing",
  });
});

test("treats an empty saved ID as the system default", async () => {
  const { resolveMicDeviceSelection } = await load();

  assert.deepEqual(resolveMicDeviceSelection([mic("mic", "Studio Mic")], "", ""), {
    device: null,
    status: "default",
  });
});
