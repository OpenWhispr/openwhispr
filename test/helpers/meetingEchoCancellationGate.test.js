const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the real startMeetingAec closure with only the helper process replaced.
const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
const startMeetingAecSource = source.slice(
  source.indexOf("const startMeetingAec ="),
  source.indexOf("const flushPendingMeetingMicChunks =")
);

async function startMeetingAec(meetingConnectionOptions, exercise) {
  let helperStarts = 0;
  let onMicChunk;
  const context = {
    meetingAecEnabled: false,
    meetingConnectionOptions,
    meetingClockByPcm: new WeakMap(),
    ...require("../../src/helpers/meetingCaptureClock"),
    meetingPendingMicChunks: [],
    flushPendingMeetingMicChunks() {},
    meetingAecManager: {
      isAvailable: () => true,
      processMicBuffer: () => true,
      start: async (callbacks) => {
        onMicChunk = callbacks.onMicChunk;
        helperStarts += 1;
        return true;
      },
    },
    debugLogger: { info() {}, warn() {}, debug() {} },
  };
  vm.createContext(context);
  const mic = source.slice(
    source.indexOf("const processMeetingMicWithAec ="),
    source.indexOf("const stopLiveSpeakerIdentification =")
  );
  vm.runInContext(
    `${startMeetingAecSource}; ${mic}; globalThis.run = startMeetingAec; globalThis.mic = processMeetingMicWithAec;`,
    context
  );
  const started = await context.run("loopback");
  exercise?.(context, onMicChunk);
  return { started, helperStarts };
}

test("the AEC helper stays off unless the meeting asked for echo cancellation", async () => {
  for (const options of [{}, { aecEnabled: false }]) {
    assert.deepEqual(await startMeetingAec(options), { started: false, helperStarts: 0 });
  }
});

test("the AEC helper starts when the meeting asked for echo cancellation", async () => {
  assert.deepEqual(await startMeetingAec({ aecEnabled: true }), { started: true, helperStarts: 1 });
});

test("Sarvam dates AEC output from buffered mic input across a capture gap", async () => {
  await startMeetingAec({ aecEnabled: true, provider: "sarvam-realtime" }, (context, output) => {
    const times = [];
    context.dispatchMeetingAudioBuffer = (_chunk, _source, _synthetic, at) => times.push(at);
    context.mic(Buffer.alloc(4800), 1000);
    context.mic(Buffer.alloc(9600), 61000);
    // The helper reframes the original capture and drains its stdout later.
    output(Buffer.alloc(4800));
    output(Buffer.alloc(4800));
    output(Buffer.alloc(4800));
    assert.deepEqual(times, [1000, 61000, 61100]);
  });
});
