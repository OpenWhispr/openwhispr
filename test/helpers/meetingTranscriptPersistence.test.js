const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });
const serialize = (segments) => segments.map((s) => s.text).join("|");

// The note editor swaps from live segments to the stored transcript the moment
// isRecording flips, while the main-side stop can take seconds — so the
// captured segments must be written before that stop is awaited, or the tail
// since the last periodic save visibly disappears until the stop returns.
test("captured segments are written before the stop is awaited", async () => {
  const { persistFinalTranscriptAroundStop } = await load();
  const events = [];

  const result = await persistFinalTranscriptAroundStop({
    segments: [segment("a", "hello"), segment("b", "world")],
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
