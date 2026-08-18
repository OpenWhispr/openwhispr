const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/meetingSegmentReducer.ts");

const seg = (overrides) => ({ id: "x", text: "t", source: "mic", ...overrides });
const state = (overrides) => ({ segments: [], micPartial: "", systemPartial: "", ...overrides });
const deps = (overrides) => ({
  mintSegmentId: () => "seg-1",
  decorateFinal: (s) => s,
  ...overrides,
});

test("retract removes only rows matching source+timestamp+text exactly, and reports them", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const keep = seg({ id: "a", text: "hello", source: "mic", timestamp: 100 });
  const gone = seg({ id: "b", text: "hello", source: "mic", timestamp: 200 });
  const other = seg({ id: "c", text: "hello", source: "system", timestamp: 200 });
  const r = reduceMeetingSegmentEvent(
    state({ segments: [keep, gone, other], micPartial: "live" }),
    { type: "retract", source: "mic", text: "hello", timestamp: 200 },
    deps()
  );
  assert.equal(r.kind, "retract");
  assert.deepEqual(
    r.state.segments.map((s) => s.id),
    ["a", "c"]
  );
  assert.deepEqual(
    r.removed.map((s) => s.id),
    ["b"]
  );
  assert.equal(r.state.micPartial, "live", "retract never touches partials");
});

test("retract with no match leaves segments intact and reports nothing", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const a = seg({ id: "a", text: "hello", timestamp: 100 });
  const r = reduceMeetingSegmentEvent(
    state({ segments: [a] }),
    { type: "retract", source: "mic", text: "nope", timestamp: 100 },
    deps()
  );
  assert.deepEqual(r.state.segments, [a]);
  assert.deepEqual(r.removed, []);
});

test("partial sets only its own source's slot", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const mic = reduceMeetingSegmentEvent(
    state({ systemPartial: "sys" }),
    { type: "partial", source: "mic", text: "um" },
    deps()
  );
  assert.deepEqual(mic, {
    kind: "partial",
    source: "mic",
    state: state({ micPartial: "um", systemPartial: "sys" }),
  });
  const sys = reduceMeetingSegmentEvent(
    state({ micPartial: "me" }),
    { type: "partial", source: "system", text: "they" },
    deps()
  );
  assert.deepEqual(sys, {
    kind: "partial",
    source: "system",
    state: state({ micPartial: "me", systemPartial: "they" }),
  });
});

test("final mints an id, normalizes, decorates, appends when newest, and clears only its own partial", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const decorated = [];
  const r = reduceMeetingSegmentEvent(
    state({
      segments: [seg({ id: "a", timestamp: 100 })],
      micPartial: "live",
      systemPartial: "sys",
    }),
    { type: "final", source: "mic", text: "done", timestamp: 200 },
    deps({
      mintSegmentId: () => "seg-42",
      decorateFinal: (s) => {
        decorated.push(s.id);
        return { ...s, speaker: "speaker_0" };
      },
    })
  );
  assert.equal(r.kind, "final");
  assert.equal(r.index, 1);
  assert.deepEqual(
    decorated,
    ["seg-42"],
    "decorateFinal sees the freshly minted, normalized segment"
  );
  assert.equal(r.inserted.speaker, "speaker_0");
  assert.equal(r.inserted.speakerLocked, false, "normalizeTranscriptSegment ran");
  assert.deepEqual(
    r.state.segments.map((s) => s.id),
    ["a", "seg-42"]
  );
  assert.equal(r.state.micPartial, "");
  assert.equal(r.state.systemPartial, "sys");
});

test("final for the system source clears systemPartial and leaves micPartial", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const r = reduceMeetingSegmentEvent(
    state({ micPartial: "me", systemPartial: "they" }),
    { type: "final", source: "system", text: "ok", timestamp: 1 },
    deps()
  );
  assert.equal(r.state.micPartial, "me");
  assert.equal(r.state.systemPartial, "");
});

test("insertSegmentByTimestamp: older timestamps insert before newer ones; equal timestamps go after existing (strict >)", async () => {
  const { insertSegmentByTimestamp } = await load();
  const base = [seg({ id: "a", timestamp: 100 }), seg({ id: "c", timestamp: 300 })];
  assert.deepEqual(
    insertSegmentByTimestamp(base, seg({ id: "b", timestamp: 200 })).segments.map((s) => s.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    insertSegmentByTimestamp(base, seg({ id: "a2", timestamp: 100 })).segments.map((s) => s.id),
    ["a", "a2", "c"]
  );
  assert.deepEqual(
    insertSegmentByTimestamp(base, seg({ id: "z", timestamp: 50 })).segments.map((s) => s.id),
    ["z", "a", "c"]
  );
  assert.equal(insertSegmentByTimestamp(base, seg({ id: "z", timestamp: 50 })).index, 0);
});

test("characterization: an incoming final without a timestamp appends at the END (`?? Infinity`), while an existing untimestamped row sorts as 0", async () => {
  const { insertSegmentByTimestamp } = await load();
  const base = [
    seg({ id: "a", timestamp: 100 }),
    seg({ id: "u" }),
    seg({ id: "c", timestamp: 300 }),
  ];
  assert.deepEqual(
    insertSegmentByTimestamp(base, seg({ id: "n" })).segments.map((s) => s.id),
    ["a", "u", "c", "n"]
  );
  // A timestamped 200 goes after "u" (treated as 0) and before "c".
  assert.deepEqual(
    insertSegmentByTimestamp(base, seg({ id: "m", timestamp: 200 })).segments.map((s) => s.id),
    ["a", "u", "m", "c"]
  );
});

test("reducer never mutates its inputs", async () => {
  const { reduceMeetingSegmentEvent } = await load();
  const original = state({ segments: [seg({ id: "a", timestamp: 100 })], micPartial: "x" });
  const snapshot = JSON.stringify(original);
  reduceMeetingSegmentEvent(
    original,
    { type: "final", source: "mic", text: "y", timestamp: 50 },
    deps()
  );
  reduceMeetingSegmentEvent(
    original,
    { type: "retract", source: "mic", text: "t", timestamp: 100 },
    deps()
  );
  reduceMeetingSegmentEvent(original, { type: "partial", source: "mic", text: "p" }, deps());
  assert.equal(JSON.stringify(original), snapshot);
});
