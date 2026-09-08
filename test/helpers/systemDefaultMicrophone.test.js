const test = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../../src/helpers/systemDefaultMicrophone");

test("parses a WirePlumber default source", () => {
  assert.deepEqual(
    helper.parseWpctlResult(`
      node.name = "alsa_input.pci-0000_00_1f.3.analog-stereo"
      node.description = "Built-in Audio Analog Stereo"
    `),
    {
      name: "Built-in Audio Analog Stereo",
      nativeId: "alsa_input.pci-0000_00_1f.3.analog-stereo",
    }
  );
});

test("parses a PulseAudio default source", () => {
  const sources = JSON.stringify([
    { name: "usb", description: "USB Microphone" },
    { name: "internal", description: "Internal Microphone" },
  ]);
  assert.deepEqual(helper.parsePactlSources(sources, "internal"), {
    name: "Internal Microphone",
    nativeId: "internal",
  });
});

test("resolver caches a successful platform result briefly", async () => {
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    platform: "linux",
    now: () => 100,
    run: async (command) => {
      calls += 1;
      if (command === "wpctl") return 'node.description = "Desk Microphone"';
      throw new Error("unexpected command");
    },
  });

  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal(calls, 1);
});
