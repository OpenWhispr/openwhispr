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

function wpctlResolver({ now = () => 100, respond } = {}) {
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    platform: "linux",
    now,
    run: (command) => {
      calls += 1;
      if (command !== "wpctl") throw new Error("unexpected command");
      return respond ? respond() : 'node.description = "Desk Microphone"';
    },
  });
  return { resolve, calls: () => calls };
}

test("resolver keeps a successful lookup until asked to refresh", async () => {
  const { resolve, calls } = wpctlResolver();

  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal((await resolve()).name, "Desk Microphone");
  assert.equal(calls(), 1);

  await resolve({ refresh: true });
  assert.equal(calls(), 2);
});

test("resolver retries a failed lookup only after the back-off", async () => {
  let clock = 0;
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    platform: "linux",
    now: () => clock,
    run: async () => {
      calls += 1;
      throw new Error("no audio server");
    },
  });

  assert.equal((await resolve()).source, "unavailable");
  clock = 1000;
  await resolve();
  assert.equal(calls, 2, "wpctl then pactl, no retry inside the back-off");
  clock = 31000;
  await resolve();
  assert.equal(calls, 4);
});

test("concurrent lookups share one process", async () => {
  let release;
  const { resolve, calls } = wpctlResolver({
    respond: () =>
      new Promise((done) => {
        release = () => done('node.description = "Desk Microphone"');
      }),
  });

  const first = resolve();
  const second = resolve({ refresh: true });
  release();

  assert.equal((await first).name, "Desk Microphone");
  assert.equal((await second).name, "Desk Microphone");
  assert.equal(calls(), 1);
});
