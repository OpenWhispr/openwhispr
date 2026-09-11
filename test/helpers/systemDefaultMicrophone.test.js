const test = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../../src/helpers/systemDefaultMicrophone");
const { deferred } = require("./harness/deferred");

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

// Each lookup answers with the next name and stays pending until settle(index),
// so a test can choose which of two concurrent lookups finishes first.
function gatedResolver(names) {
  const gates = names.map(() => deferred());
  let calls = 0;
  const resolve = helper.createSystemDefaultMicrophoneResolver({
    platform: "linux",
    now: () => 100,
    run: async () => {
      const index = calls;
      calls += 1;
      await gates[index].promise;
      return `node.description = "${names[index]}"`;
    },
  });
  return { resolve, settle: (index) => gates[index].resolve(), calls: () => calls };
}

test("resolver shares one in-flight lookup between concurrent callers", async () => {
  const { resolve, settle, calls } = gatedResolver(["Desk Microphone", "Desk Microphone"]);

  const first = resolve();
  const second = resolve();

  assert.equal(calls(), 1);
  settle(0);
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.name),
    ["Desk Microphone", "Desk Microphone"]
  );
});

test("a refresh never joins a lookup that started before it", async () => {
  const { resolve, settle, calls } = gatedResolver(["Old Microphone", "New Microphone"]);

  const stale = resolve();
  const fresh = resolve({ refresh: true });

  assert.equal(calls(), 2);
  settle(1);
  assert.equal((await fresh).name, "New Microphone");
  settle(0);
  await stale;
});

test("a lookup overtaken by a fresher one does not write its result to the cache", async () => {
  const { resolve, settle, calls } = gatedResolver(["Old Microphone", "New Microphone"]);

  const stale = resolve();
  const fresh = resolve({ refresh: true });
  assert.equal(calls(), 2);

  settle(1);
  await fresh;
  settle(0);
  await stale;

  assert.equal((await resolve()).name, "New Microphone");
});
