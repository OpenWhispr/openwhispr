const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/systemAudioAccess.ts");

const output = (deviceId, label) => ({ kind: "audiooutput", deviceId, label });

// Chromium lists the Windows default output as deviceId "default", labelled
// "Default - <name>" (Electron hard-codes the English prefix). That entry and
// Chromium's loopback both resolve to the console default device, so its name
// is the device "Default Playback Device Only" records.
test("names the Windows default output without Chromium's prefix", async () => {
  const { getDefaultPlaybackDeviceName } = await load();

  const devices = [
    output("communications", "Communications - Headset Earphone (Arctis 7)"),
    output("default", "Default - Speakers (Sound Blaster Z)"),
    output("0f3c9a", "Speakers (Sound Blaster Z)"),
  ];
  assert.equal(getDefaultPlaybackDeviceName(devices), "Speakers (Sound Blaster Z)");
});

test("never names the default microphone or the communications output", async () => {
  const { getDefaultPlaybackDeviceName } = await load();

  const devices = [
    { kind: "audioinput", deviceId: "default", label: "Default - Microphone (QuadCast S)" },
    output("communications", "Communications - Headset Earphone (Arctis 7)"),
  ];
  assert.equal(getDefaultPlaybackDeviceName(devices), "");
});

test("shows no name while Chromium withholds device labels", async () => {
  const { getDefaultPlaybackDeviceName } = await load();

  assert.equal(getDefaultPlaybackDeviceName([output("default", "")]), "");
  assert.equal(getDefaultPlaybackDeviceName([]), "");
});

test("keeps a label that carries no prefix", async () => {
  const { getDefaultPlaybackDeviceName } = await load();

  const devices = [output("default", "Speakers (Realtek(R) Audio)")];
  assert.equal(getDefaultPlaybackDeviceName(devices), "Speakers (Realtek(R) Audio)");
});
