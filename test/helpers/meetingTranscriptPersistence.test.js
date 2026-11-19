const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });
const serialize = (segments) => segments.map((s) => s.text).join("|");

test("segments finalized during stop are saved after the early transcript write", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const original = [segment("a", "hello")];
  let current = original;
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments: original,
    getFinalSegments: () => current,
    seedLength: 0,
    serializeSegments: serialize,
    persist: async (text) => writes.push(text),
    stop: async () => {
      current = [...current, segment("b", "last words")];
    },
    fallbackTranscript: () => "",
  });
  assert.deepEqual(writes, ["hello", "hello|last words"]);
});

test("a final write waits for the early write so it cannot be overwritten", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let current = [segment("a", "hello")];
  let releaseWrite;
  const earlyWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const writes = [];
  const pending = persistFinalTranscriptAroundStop({
    segments: current,
    getFinalSegments: () => current,
    seedLength: 0,
    serializeSegments: serialize,
    persist: async (text) => {
      if (text === "hello") await earlyWrite;
      writes.push(text);
    },
    stop: async () => {
      current = [...current, segment("b", "last words")];
    },
    fallbackTranscript: () => "",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, []);
  releaseWrite();
  await pending;
  assert.deepEqual(writes, ["hello", "hello|last words"]);
});

test("stop-time retractions replace the early write, even when no segments remain", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let current = [segment("a", "duplicate mic text")];
  const writes = [];
  await persistFinalTranscriptAroundStop({
    segments: current,
    getFinalSegments: () => current,
    seedLength: 0,
    serializeSegments: JSON.stringify,
    persist: async (text) => writes.push(JSON.parse(text)),
    stop: async () => {
      current = [];
    },
    fallbackTranscript: () => {
      throw new Error("retracted text must stay removed");
    },
  });
  assert.deepEqual(writes, [[segment("a", "duplicate mic text")], []]);
});

// The note editor swaps from live segments to the stored transcript the moment
// isRecording flips, while the main-side stop can take seconds — so the
// captured segments must be written before that stop is awaited, or the tail
// since the last periodic save visibly disappears until the stop returns.
test("captured segments are written before the stop is awaited", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];

  const result = await persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello"), segment("b", "world")],
    seedLength: 0,
    serializeSegments: serialize,
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      events.push("stop");
      return { diarizationSessionId: "diar-1" };
    },
    fallbackTranscript: () => {
      throw new Error("main's transcript must not be consulted when segments exist");
    },
  });

  assert.deepEqual(events, ["persist:hello|world", "stop"]);
  assert.deepEqual(result, { diarizationSessionId: "diar-1" });
});

test("a segment-less recording writes main's final transcript after the stop", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];
  let stopped = false;

  await persistFinalTranscriptAroundStop({
    segments: [],
    seedLength: 0,
    serializeSegments: () => {
      throw new Error("must not serialize an empty segment list");
    },
    persist: async (transcript) => {
      events.push(`persist:${transcript}`);
    },
    stop: async () => {
      stopped = true;
      events.push("stop");
      return null;
    },
    // Only available once main has flushed its final text.
    fallbackTranscript: () => (stopped ? "main text" : ""),
  });

  assert.deepEqual(events, ["stop", "persist:main text"]);
});

test("nothing is written when there are neither segments nor a fallback transcript", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let persisted = 0;

  await persistFinalTranscriptAroundStop({
    segments: [],
    seedLength: 0,
    serializeSegments: serialize,
    persist: async () => {
      persisted += 1;
    },
    stop: async () => null,
    fallbackTranscript: () => "",
  });

  assert.equal(persisted, 0);
});

test("the stop result is only returned once the early write has settled", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  let releaseWrite;
  const write = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let settled = false;

  const pending = persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello")],
    seedLength: 0,
    serializeSegments: serialize,
    persist: () => write,
    stop: async () => "stopped",
    fallbackTranscript: () => "",
  }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    settled,
    false,
    "the caller must not proceed while the transcript write is in flight"
  );

  releaseWrite();
  assert.equal(await pending, "stopped");
});
