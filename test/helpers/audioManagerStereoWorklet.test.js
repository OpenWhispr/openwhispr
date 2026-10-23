const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { resolveObjectURL } = require("node:buffer");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadProcessor(t) {
  installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "stereo-worklet-",
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const manager = Object.create(AudioManager.prototype);
  const code = await resolveObjectURL(manager.getWorkletBlobUrl()).text();
  let Processor = null;
  class AudioWorkletProcessor {
    constructor() {
      this.port = { posted: [], postMessage: (data) => this.port.posted.push(data) };
    }
  }
  vm.runInNewContext(code, {
    AudioWorkletProcessor,
    registerProcessor: (_name, cls) => (Processor = cls),
  });
  return Processor;
}

test("the streaming worklet keeps speech that a stereo mic carries on its right channel", async (t) => {
  const Processor = await loadProcessor(t);
  const processor = new Processor();
  const silent = new Float32Array(128);
  const speech = new Float32Array(128).fill(0.5);
  processor.process([[silent, speech]]);
  processor.port.onmessage({ data: "stop" });

  const samples = processor.port.posted
    .filter((data) => data !== "flushed")
    .flatMap((buffer) => Array.from(new Int16Array(buffer)));
  assert.equal(samples.length, 128);
  assert.ok(
    samples.every((sample) => sample !== 0),
    "the right channel's speech must reach the stream"
  );
});
