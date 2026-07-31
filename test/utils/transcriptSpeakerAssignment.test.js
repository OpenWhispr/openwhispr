const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/speakerNameResolution.ts");

const segment = (id, speaker, text) => ({ id, speaker, text, source: "system", timestamp: 0 });

// Two lines from Lena mixed into a cluster the diarizer called speaker_1.
const baseSegments = () => [
  segment("s1", "speaker_1", "one"),
  segment("s2", "speaker_1", "two"),
  segment("s3", "speaker_1", "three"),
  segment("s4", "speaker_2", "four"),
];

test("assigning a subset of a cluster splits it into its own speaker", async () => {
  const { assignSegmentsToSpeaker } = await load();

  const { segments, speakerId, didSplit } = assignSegmentsToSpeaker(
    baseSegments(),
    ["s1", "s2"],
    "Lena"
  );

  assert.equal(didSplit, true);
  assert.equal(speakerId, "speaker_3");
  assert.deepEqual(
    segments.map((s) => s.speaker),
    ["speaker_3", "speaker_3", "speaker_1", "speaker_2"]
  );
  assert.equal(segments[0].speakerName, "Lena");
  assert.equal(segments[0].speakerLocked, true);
});

test("assigning a whole cluster renames it in place", async () => {
  const { assignSegmentsToSpeaker } = await load();

  const { speakerId, didSplit } = assignSegmentsToSpeaker(
    baseSegments(),
    ["s1", "s2", "s3"],
    "Lena"
  );

  assert.equal(didSplit, false);
  assert.equal(speakerId, "speaker_1");
});

test("relabelling the rest of the cluster leaves the split-off speaker alone", async () => {
  const { assignSegmentsToSpeaker, resolveSegmentSpeakerName } = await load();

  const lena = assignSegmentsToSpeaker(baseSegments(), ["s1", "s2"], "Lena");
  const mappings = { [lena.speakerId]: "Lena" };

  // The user now clicks the "Speaker 1" label, which relabels that cluster.
  const relabelled = lena.segments.map((s) =>
    s.speaker === "speaker_1" && !(s.speakerLocked && s.speakerName && s.speakerName !== "Christophe")
      ? { ...s, speakerName: "Christophe", speakerLocked: true, speakerStatus: "locked" }
      : s
  );
  mappings.speaker_1 = "Christophe";

  assert.deepEqual(
    relabelled.map((s) => resolveSegmentSpeakerName(s, mappings).name),
    ["Lena", "Lena", "Christophe", null]
  );
});

test("reassigning segments to an existing name rejoins that speaker", async () => {
  const { assignSegmentsToSpeaker } = await load();

  const lena = assignSegmentsToSpeaker(baseSegments(), ["s1", "s2"], "Lena");
  const mappings = { [lena.speakerId]: "Lena" };

  const rejoined = assignSegmentsToSpeaker(lena.segments, ["s3"], "Lena", {
    speakerMappings: mappings,
  });

  assert.equal(rejoined.speakerId, lena.speakerId);
  assert.deepEqual(
    rejoined.segments.filter((s) => s.speaker === lena.speakerId).map((s) => s.id),
    ["s1", "s2", "s3"]
  );
});

test("a name the user pinned to a segment outranks the cluster mapping", async () => {
  const { resolveSegmentSpeakerName } = await load();

  const pinned = {
    ...segment("s1", "speaker_1", "one"),
    speakerName: "Lena",
    speakerLocked: true,
    speakerStatus: "locked",
  };

  assert.deepEqual(resolveSegmentSpeakerName(pinned, { speaker_1: "Christophe" }), {
    name: "Lena",
    source: "lock",
  });
});

test("the cluster mapping still wins over a name diarization guessed", async () => {
  const { resolveSegmentSpeakerName } = await load();

  const guessed = { ...segment("s1", "speaker_1", "one"), speakerName: "Christophe" };

  assert.deepEqual(resolveSegmentSpeakerName(guessed, { speaker_1: "Lena" }), {
    name: "Lena",
    source: "mapping",
  });
});

test("an empty selection changes nothing", async () => {
  const { assignSegmentsToSpeaker } = await load();
  const segments = baseSegments();

  const result = assignSegmentsToSpeaker(segments, [], "Lena");

  assert.equal(result.speakerId, "");
  assert.equal(result.segments, segments);
});

test("a cluster still showing Speaker N has no name, so naming it covers every line", async () => {
  const { resolveClusterName } = await load();

  assert.equal(resolveClusterName(baseSegments(), "speaker_1", {}), null);
});

test("a named cluster reports its name from either the mapping or a pinned line", async () => {
  const { resolveClusterName } = await load();

  assert.equal(resolveClusterName(baseSegments(), "speaker_1", { speaker_1: "Will" }), "Will");

  const pinned = baseSegments().map((s) =>
    s.id === "s2" ? { ...s, speakerName: "Will", speakerLocked: true, speakerStatus: "locked" } : s
  );
  assert.equal(resolveClusterName(pinned, "speaker_1", {}), "Will");
});

test("renaming one line of a named cluster leaves that cluster's other lines alone", async () => {
  const { assignSegmentsToSpeaker, resolveSegmentSpeakerName } = await load();

  // Speaker 1 was named Will across the board.
  const named = assignSegmentsToSpeaker(baseSegments(), ["s1", "s2", "s3"], "Will");
  const mappings = { [named.speakerId]: "Will" };

  // The user now corrects a single line to Lisa.
  const corrected = assignSegmentsToSpeaker(named.segments, ["s2"], "Lisa", {
    speakerMappings: mappings,
  });
  mappings[corrected.speakerId] = "Lisa";

  assert.notEqual(corrected.speakerId, named.speakerId);
  assert.deepEqual(
    corrected.segments.map((s) => resolveSegmentSpeakerName(s, mappings).name),
    ["Will", "Lisa", "Will", null]
  );
});

test("new cluster ids avoid ids that only exist in the mappings", async () => {
  const { assignSegmentsToSpeaker } = await load();

  const { speakerId } = assignSegmentsToSpeaker(baseSegments(), ["s1"], "Lena", {
    speakerMappings: { speaker_7: "Ruth" },
  });

  assert.equal(speakerId, "speaker_8");
});
