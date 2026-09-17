const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/pcmTap.js");

// Fakes for the WebAudio surface the tap touches. `onStop` decides what the
// worklet posts back when asked to flush; the real one posts its partial
// buffer, then "flushed".
function installFakes(
  t,
  { failModule = false, state = "running", onStop = (node) => node.reply("flushed") } = {}
) {
  const contexts = [];
  const nodes = [];
  class FakeAudioContext {
    constructor({ sampleRate }) {
      this.sampleRate = sampleRate;
      this.state = state;
      this.resumed = 0;
      this.sources = [];
      this.closed = 0;
      this.audioWorklet = {
        addModule: async () => {
          if (failModule) throw new Error("no worklet");
        },
      };
      contexts.push(this);
    }
    createMediaStreamSource(stream) {
      const source = {
        stream,
        connected: null,
        connect(node) {
          this.connected = node;
        },
        disconnect() {
          this.connected = null;
        },
      };
      this.sources.push(source);
      return source;
    }
    async resume() {
      this.resumed += 1;
    }
    async close() {
      this.closed += 1;
    }
  }
  class FakeAudioWorkletNode {
    constructor(context, name, options) {
      this.options = options;
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message === "stop") queueMicrotask(() => onStop(this));
        },
      };
      nodes.push(this);
    }
    reply(data) {
      this.port.onmessage?.({ data });
    }
    connect() {}
    disconnect() {}
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  });
  return { contexts, nodes };
}

const ready = () => new Promise((resolve) => setImmediate(resolve));
const chunk = (values) => Int16Array.from(values).buffer;
const mic = { id: "mic" };

// A tap attached at t=0 on an injected clock; `clock.now` is read at stop().
async function attachedTap(PcmTap, options = {}) {
  const clock = { now: 0 };
  const tap = new PcmTap("blob:worklet", { now: () => clock.now, ...options });
  tap.attach(mic);
  await ready();
  return { tap, clock };
}

async function decodeWav(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return {
    header: bytes.subarray(0, 44),
    samples: Array.from(
      new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2)
    ),
  };
}

test("stop returns a 16 kHz mono PCM16 WAV of every chunk in order", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap);

  nodes[0].reply(chunk([1, 2, 3]));
  nodes[0].reply(chunk([4, 5]));
  const { header, samples } = await decodeWav(await tap.stop());

  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt16LE(22), 1, "mono");
  assert.equal(header.readUInt32LE(24), 16000, "16 kHz");
  assert.equal(header.readUInt16LE(34), 16, "PCM16");
  assert.deepEqual(samples, [1, 2, 3, 4, 5]);
  assert.equal(contexts[0].sampleRate, 16000);
  assert.equal(contexts[0].closed, 1);
});

test("a stream attached before the worklet loads is connected once it does, downmixed to mono", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap);

  assert.equal(contexts[0].sources[0].connected, nodes[0]);
  assert.deepEqual(nodes[0].options, { channelCount: 1, channelCountMode: "explicit" });
  tap.close();
});

test("a recording past the cap yields no copy", async (t) => {
  const { nodes } = installFakes(t);
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap, { maxSamples: 4 });

  nodes[0].reply(chunk([1, 2, 3]));
  nodes[0].reply(chunk([4, 5]));

  assert.equal(await tap.stop(), null);
});

test("a chunk that crosses the cap while flushing drops the copy", async (t) => {
  const { nodes } = installFakes(t, {
    onStop: (node) => {
      node.reply(chunk([4, 5]));
      node.reply("flushed");
    },
  });
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap, { maxSamples: 4 });
  nodes[0].reply(chunk([1, 2, 3]));

  assert.equal(await tap.stop(), null);
});

test("a copy shorter than its recording is dropped, a complete one is kept", async (t) => {
  const { nodes } = installFakes(t);
  const { PcmTap } = await load();
  const second = () => Int16Array.from({ length: 16000 }, () => 1).buffer;

  const short = await attachedTap(PcmTap);
  nodes[0].reply(second());
  short.clock.now = 5000;
  assert.equal(await short.tap.stop(), null, "one second of audio for five seconds attached");

  const complete = await attachedTap(PcmTap);
  nodes[1].reply(second());
  complete.clock.now = 1000;
  assert.ok(await complete.tap.stop(), "one second of audio for one second attached");
});

test("a worklet that fails to load yields no copy and still releases the context", async (t) => {
  const { contexts } = installFakes(t, { failModule: true });
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap);

  assert.equal(await tap.stop(), null);
  assert.equal(contexts[0].closed, 1);
});

test("a worklet that never answers the flush yields no copy once the watchdog fires", async (t) => {
  const { contexts, nodes } = installFakes(t, { onStop: () => {} });
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap);
  nodes[0].reply(chunk([1, 2]));
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = tap.stop();
  t.mock.timers.tick(1000);

  assert.equal(await pending, null);
  assert.equal(contexts[0].closed, 1);
});

test("attach follows the recording onto a replacement microphone", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const replacement = { id: "headset" };
  const { tap } = await attachedTap(PcmTap);

  tap.attach(replacement);
  const [original, rebound] = contexts[0].sources;

  assert.equal(original.connected, null);
  assert.equal(rebound.stream, replacement);
  assert.equal(rebound.connected, nodes[0]);
  tap.close();
});

test("a suspended context is nudged awake", async (t) => {
  const { contexts } = installFakes(t, { state: "suspended" });
  const { PcmTap } = await load();
  const tap = new PcmTap("blob:worklet");

  assert.equal(contexts[0].resumed, 1);
  tap.close();
});

test("close discards the copy and releases the context", async (t) => {
  const { contexts, nodes } = installFakes(t);
  const { PcmTap } = await load();
  const { tap } = await attachedTap(PcmTap);
  nodes[0].reply(chunk([1, 2]));

  tap.close();

  assert.equal(contexts[0].closed, 1);
  assert.equal(await tap.stop(), null);
});
