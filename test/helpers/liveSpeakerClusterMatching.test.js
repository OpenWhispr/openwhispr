const test = require("node:test");
const assert = require("node:assert/strict");

const { LiveSpeakerIdentifier } = require("../../src/helpers/liveSpeakerIdentifier");
const { MATCH_THRESHOLD } = require("../../src/helpers/liveSpeakerMatching");

// These drive the REAL identifier, not the accept/reject predicate. Two previous attempts
// at this fix passed predicate-only tests and were still wrong: the first collapsed the
// policy to bare nearest-neighbour, the second reopened the runaway in [0.65, 0.72).
function createIdentifier() {
  const identifier = Object.create(LiveSpeakerIdentifier.prototype);
  identifier.transientEmbeddings = new Map();
  identifier.transientCounts = new Map();
  identifier.transientDisplayNames = new Map();
  identifier.transientProfileIds = new Map();
  identifier.transientNoteIds = new Map();
  identifier.pendingMerges = [];
  identifier.currentSegmentSpeakerId = null;
  identifier.currentSegmentSpeakerName = null;
  identifier.nextLiveIndex = 0;
  return identifier;
}

// Geometry, so the thresholds under test are hit exactly rather than approximately.
// Two clusters sit at a chosen angle in the x/y plane; a "tied" voice is placed on their
// bisector and tilted out of the plane until it is equally similar to BOTH. That is the
// near-tie the whole rule turns on — the pair alone cannot say whether it means two
// similar people or one person's duplicates.
function clusterPair(clusterSimilarity) {
  const theta = Math.acos(clusterSimilarity);
  return {
    theta,
    a: new Float32Array([1, 0, 0]),
    b: new Float32Array([Math.cos(theta), Math.sin(theta), 0]),
  };
}

function tiedVoice(similarity, { theta }) {
  const half = theta / 2;
  const inPlane = similarity / Math.cos(half);
  const out = Math.sqrt(Math.max(0, 1 - inPlane * inPlane));
  return new Float32Array([inPlane * Math.cos(half), inPlane * Math.sin(half), out]);
}

function distantVoice(similarity) {
  const angle = Math.acos(similarity);
  return new Float32Array([Math.cos(angle), Math.sin(angle), 0]);
}

function seedCluster(identifier, id, embedding, { count = 1, name, profileId } = {}) {
  identifier.transientEmbeddings.set(id, embedding);
  identifier.transientCounts.set(id, count);
  if (name) identifier.transientDisplayNames.set(id, name);
  if (profileId) identifier.transientProfileIds.set(id, profileId);
}

test("one voice with duplicate clusters plus a third speaker settles at three clusters", () => {
  const identifier = createIdentifier();
  const alice = clusterPair(0.9);

  // Alice already has two near-duplicate clusters — the state that started the runaway.
  seedCluster(identifier, "speaker_0", alice.a, { count: 3 });
  seedCluster(identifier, "speaker_1", alice.b, { count: 2 });
  identifier.nextLiveIndex = 2;
  // A third, genuinely distinct speaker.
  seedCluster(identifier, "speaker_2", new Float32Array([0, 0, 1]), { count: 4 });
  identifier.nextLiveIndex = 3;

  // Alice keeps talking. Every utterance is a near-tie between her two clusters, landing
  // in [0.65, 0.72) — exactly the band the second attempted fix reopened.
  for (let i = 0; i < 12; i += 1) {
    identifier._assignOrForceCluster(tiedVoice(0.66 + (i % 3) * 0.02, alice));
  }

  assert.ok(
    identifier.transientEmbeddings.size <= 3,
    `expected at most 3 clusters, got ${identifier.transientEmbeddings.size}: ${[
      ...identifier.transientEmbeddings.keys(),
    ]}`
  );
});

test("duplicate clusters are merged outright, so the near-tie cannot re-trigger", () => {
  const identifier = createIdentifier();
  const alice = clusterPair(0.9);
  seedCluster(identifier, "speaker_0", alice.a, { count: 3 });
  seedCluster(identifier, "speaker_1", alice.b, { count: 2 });

  const assigned = identifier._assignOrForceCluster(tiedVoice(0.68, alice));

  assert.equal(identifier.transientEmbeddings.size, 1, "the duplicate pair must collapse");
  assert.ok(identifier.transientEmbeddings.has(assigned));
  assert.equal(identifier.pendingMerges.length, 1, "the merge must be queued for the renderer");
});

test("two distinct speakers are not merged, and no new cluster is minted", () => {
  const identifier = createIdentifier();
  // Dissimilar clusters, so a near-tied voice is genuinely ambiguous rather than a duplicate.
  const strangers = clusterPair(0.2);
  seedCluster(identifier, "speaker_0", strangers.a, { count: 3 });
  seedCluster(identifier, "speaker_1", strangers.b, { count: 3 });
  identifier.nextLiveIndex = 2;

  const before = [...identifier.transientEmbeddings.get("speaker_0")];
  const assigned = identifier._assignOrForceCluster(tiedVoice(0.67, strangers));

  assert.equal(identifier.transientEmbeddings.size, 2, "distinct speakers must survive");
  assert.equal(identifier.pendingMerges.length, 0);
  assert.ok(["speaker_0", "speaker_1"].includes(assigned), "must not mint above the threshold");
  assert.deepEqual(
    [...identifier.transientEmbeddings.get("speaker_0")],
    before,
    "an ambiguous assignment must not drag the cluster toward the stranger"
  );
});

test("a voice below the threshold still mints a new speaker", () => {
  const identifier = createIdentifier();
  seedCluster(identifier, "speaker_0", new Float32Array([1, 0, 0]), { count: 3 });
  identifier.nextLiveIndex = 1;

  const assigned = identifier._assignOrForceCluster(distantVoice(0.2));

  assert.notEqual(assigned, "speaker_0");
  assert.equal(identifier.transientEmbeddings.size, 2);
});

test("a stored profile never takes over a cluster that belongs to someone else", () => {
  const identifier = createIdentifier();
  seedCluster(identifier, "speaker_0", new Float32Array([1, 0, 0]), {
    count: 3,
    name: "Bob",
    profileId: 7,
  });
  identifier.nextLiveIndex = 1;

  // Alice's profile matches this voice, but the nearest cluster is Bob's.
  const assigned = identifier._assignOrForceCluster(distantVoice(0.7), { profileId: 9 });

  assert.notEqual(assigned, "speaker_0", "Bob's cluster must not be renamed to Alice");
  assert.equal(identifier.transientDisplayNames.get("speaker_0"), "Bob");
  assert.equal(identifier.transientProfileIds.get("speaker_0"), 7);
});

test("clusters with conflicting identities are never merged", () => {
  const identifier = createIdentifier();
  const pair = clusterPair(0.9);
  seedCluster(identifier, "speaker_0", pair.a, { count: 3, name: "Alice" });
  seedCluster(identifier, "speaker_1", pair.b, { count: 2, name: "Bob" });

  identifier._assignOrForceCluster(tiedVoice(0.68, pair));

  assert.equal(identifier.transientEmbeddings.size, 2, "named people must not be merged away");
  assert.equal(identifier.transientDisplayNames.get("speaker_0"), "Alice");
  assert.equal(identifier.transientDisplayNames.get("speaker_1"), "Bob");
});

test("a merge made while assigning is reported through recluster", () => {
  const identifier = createIdentifier();
  const pair = clusterPair(0.9);
  seedCluster(identifier, "speaker_0", pair.a, { count: 3 });
  seedCluster(identifier, "speaker_1", pair.b, { count: 2 });

  identifier._assignOrForceCluster(tiedVoice(0.68, pair));
  const reported = identifier._performRecluster();

  assert.equal(reported.length, 1, "an unreported merge orphans every earlier segment");
  assert.equal(reported[0].remove, "speaker_1");
  assert.equal(reported[0].keep, "speaker_0");
  assert.equal(identifier.pendingMerges.length, 0, "draining must not report it twice");
});

test("merging keeps the in-flight segment pointing at a live speaker", () => {
  const identifier = createIdentifier();
  const pair = clusterPair(0.9);
  seedCluster(identifier, "speaker_0", pair.a, { count: 3, name: "Alice" });
  seedCluster(identifier, "speaker_1", pair.b, { count: 2 });
  identifier.currentSegmentSpeakerId = "speaker_1";
  identifier.currentSegmentSpeakerName = null;

  identifier._assignOrForceCluster(tiedVoice(0.68, pair));

  assert.equal(identifier.currentSegmentSpeakerId, "speaker_0");
  assert.equal(identifier.currentSegmentSpeakerName, "Alice");
  assert.ok(identifier.transientEmbeddings.has(identifier.currentSegmentSpeakerId));
});

test("a merge carries the removed cluster's note and profile ids across", () => {
  const identifier = createIdentifier();
  const pair = clusterPair(0.9);
  seedCluster(identifier, "speaker_0", pair.a, { count: 3 });
  seedCluster(identifier, "speaker_1", pair.b, { count: 2, profileId: 4 });
  identifier.transientNoteIds.set("speaker_1", 11);

  const keep = identifier._assignOrForceCluster(tiedVoice(0.68, pair));

  assert.equal(identifier.transientProfileIds.get(keep), 4);
  assert.equal(identifier.transientNoteIds.get(keep), 11);
  assert.equal(identifier.transientNoteIds.has("speaker_1"), false);
});

test("the accept threshold itself is unchanged", () => {
  const identifier = createIdentifier();
  seedCluster(identifier, "speaker_0", new Float32Array([1, 0, 0]), { count: 1 });
  identifier.nextLiveIndex = 1;

  const justBelow = identifier._assignOrForceCluster(distantVoice(MATCH_THRESHOLD - 0.01));
  assert.notEqual(justBelow, "speaker_0");
});
