const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

// The renderer groups consecutive segments into one bubble and only labels the
// first of a run, so it must key on the resolved name — otherwise a stretch the
// user reassigned stays merged into its old cluster and its label never shows.
const groupKey = (segment, mappings, resolve) => {
  const name = resolve(segment, mappings);
  if (name) return `name:${name.toLowerCase()}`;
  if (segment.speaker) return `id:${segment.speaker}`;
  return `src:${segment.source}`;
};

const userAssigned = (speaker, speakerName) => ({
  source: "system",
  speaker,
  speakerName,
  speakerLocked: true,
  speakerLockSource: "user",
  speakerStatus: "locked",
});

const clusterOnly = (speaker) => ({ source: "system", speaker });

test("a user-assigned segment name outranks the cluster mapping", async () => {
  const { resolveSegmentSpeakerName } = await load();
  const segment = userAssigned("speaker_0", "Bob");

  assert.equal(resolveSegmentSpeakerName(segment, { speaker_0: "Alice" }), "Bob");
});

test("the cluster mapping still names segments the user has not touched", async () => {
  const { resolveSegmentSpeakerName } = await load();

  assert.equal(
    resolveSegmentSpeakerName(clusterOnly("speaker_0"), { speaker_0: "Alice" }),
    "Alice"
  );
});

test("an auto-assigned name does not outrank the mapping", async () => {
  const { resolveSegmentSpeakerName } = await load();
  // Diarization sets confirmed, not locked; only a user edit should win.
  const segment = {
    source: "system",
    speaker: "speaker_0",
    speakerName: "Speaker 1",
    speakerStatus: "confirmed",
  };

  assert.equal(resolveSegmentSpeakerName(segment, { speaker_0: "Alice" }), "Alice");
});

test("falls back to the segment name, then to nothing", async () => {
  const { resolveSegmentSpeakerName } = await load();

  assert.equal(resolveSegmentSpeakerName({ source: "system", speakerName: "Bob" }, {}), "Bob");
  assert.equal(resolveSegmentSpeakerName(clusterOnly("speaker_0"), {}), undefined);
  assert.equal(resolveSegmentSpeakerName({ source: "mic" }, undefined), undefined);
});

test("reassigning the middle of a mis-split block breaks it into three runs", async () => {
  const { resolveSegmentSpeakerName } = await load();
  // The reported case: diarization gave one cluster A,A,A,A,A,A; the user
  // reassigns the middle two to B. Before the fix every key was "id:speaker_0",
  // so all six stayed one run under one label and the edit looked like a no-op.
  const mappings = { speaker_0: "Alice" };
  const segments = [
    clusterOnly("speaker_0"),
    clusterOnly("speaker_0"),
    userAssigned("speaker_0", "Bob"),
    userAssigned("speaker_0", "Bob"),
    clusterOnly("speaker_0"),
    clusterOnly("speaker_0"),
  ];

  const keys = segments.map((s) => groupKey(s, mappings, resolveSegmentSpeakerName));
  const runs = keys.filter((key, i) => i === 0 || key !== keys[i - 1]);

  assert.deepEqual(runs, ["name:alice", "name:bob", "name:alice"]);
});

test("own-voice segments are unaffected by a mapping on another cluster", async () => {
  const { resolveSegmentSpeakerName } = await load();
  const you = { source: "mic", speaker: "you" };

  assert.equal(resolveSegmentSpeakerName(you, { speaker_0: "Alice" }), undefined);
  assert.equal(groupKey(you, { speaker_0: "Alice" }, resolveSegmentSpeakerName), "id:you");
});
