const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const identifierModulePath = require.resolve("../../src/helpers/liveSpeakerIdentifier");
const originalLoad = Module._load;

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function loadIdentifier() {
  delete require.cache[identifierModulePath];
  const warnings = [];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return {
        info() {},
        warn(message, data) {
          warnings.push({ message, data });
        },
        debug() {},
        error() {},
      };
    }
    if (request === "./speakerEmbeddings") {
      return {
        MAX_EMBEDDING_SECONDS: 8,
        isAvailable: () => true,
        cosineSimilarity,
        extractEmbeddingFromSamples: async () => null,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { LiveSpeakerIdentifier } = require(identifierModulePath);
    return { LiveSpeakerIdentifier, warnings };
  } finally {
    Module._load = originalLoad;
  }
}

const unit = (values) => {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return new Float32Array(values.map((v) => v / norm));
};

const voiceA = unit([1, 0, 0]);
const voiceB = unit([0, 1, 0]);
// ~0.7 similar to both A and B: fails the match margin, so it mints a cluster
// that the next recluster pass merges back into A.
const ambiguousVoice = unit([0.7, 0.7, 0.14]);
const voiceC = unit([0.05, 0.05, 0.99]);

function seedMergedSession(identifier) {
  identifier.setMaxSpeakers(3);
  identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });
  identifier._resolveSpeakerForEmbedding(ambiguousVoice, { updateCentroid: true });
  const merges = identifier._performRecluster();
  assert.equal(merges.length, 1, "expected the ambiguous cluster to merge away");
  return merges[0];
}

test("new voice after a recluster merge gets a fresh id — freed ids are never reused", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  const merge = seedMergedSession(identifier);
  assert.equal(merge.remove, "speaker_2");

  // Durable state (note speaker mappings, NoteEditor's name map) may still
  // reference the retired id, so recycling it would let a new voice inherit
  // the previous person's identity.
  const resolved = identifier._resolveSpeakerForEmbedding(voiceC, { updateCentroid: true });
  assert.equal(resolved.speakerId, "speaker_3", "ids must stay monotonic within a meeting");
});

test("manual identification sticks for a voice that appeared after a merge", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  seedMergedSession(identifier);
  const resolved = identifier._resolveSpeakerForEmbedding(voiceC, { updateCentroid: true });

  // With no remapper layer, the id the transcript shows IS the cluster id, so
  // naming it must reach the right cluster.
  const mapped = identifier.mapSpeaker(resolved.speakerId, 42, "Carol", 7);
  assert.equal(mapped, true, "mapSpeaker must recognize the id shown in the transcript");

  const embedding = identifier.getSpeakerEmbedding(resolved.speakerId);
  assert.ok(embedding, "profile persistence needs the cluster embedding");

  const again = identifier._resolveSpeakerForEmbedding(voiceC, { updateCentroid: true });
  assert.equal(again.displayName, "Carol", "the manual name must carry to later speech");
});

test("stop() state keys match the resolved speaker ids", async () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  seedMergedSession(identifier);
  identifier._resolveSpeakerForEmbedding(voiceC, { updateCentroid: true });

  const state = identifier.getTransientState();
  assert.deepEqual(
    Object.keys(state).sort(),
    ["speaker_0", "speaker_1", "speaker_3"],
    "post-meeting reconciliation looks mappings up by these keys"
  );
});

test("mapSpeaker on an unknown id fails loudly", () => {
  const { LiveSpeakerIdentifier, warnings } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  identifier.setMaxSpeakers(3);
  identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });

  const mapped = identifier.mapSpeaker("speaker_9", 1, "Alice", null);
  assert.equal(mapped, false);
  const warning = warnings.find((w) => /speaker/i.test(w.message));
  assert.ok(warning, "a dropped manual identification must leave a trace in the logs");
  assert.ok(
    !JSON.stringify(warning.data ?? {}).includes("Alice"),
    "the participant's name must not be written to the logs"
  );
});

// Plants exactly two clusters ~0.70 similar (above the 0.65 recluster
// threshold) — creating them via resolution would just match them together.
function seedSimilarIdentifiedPair(identifier) {
  identifier.setMaxSpeakers(3);
  identifier._assignSpeakerId(voiceA);
  identifier._assignSpeakerId(ambiguousVoice);
}

test("clusters mapped to different profiles never merge on similarity alone", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  seedSimilarIdentifiedPair(identifier);
  assert.equal(identifier.mapSpeaker("speaker_0", 1, "Alice", null), true);
  assert.equal(identifier.mapSpeaker("speaker_1", 2, "Bob", null), true);

  const merges = identifier._performRecluster();
  assert.deepEqual(merges, [], "two confirmed-distinct people must not be merged");
  assert.ok(identifier.getSpeakerEmbedding("speaker_1"), "Bob's cluster must survive");
});

test("clusters with different manual names never merge on similarity alone", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  seedSimilarIdentifiedPair(identifier);
  assert.equal(identifier.mapSpeaker("speaker_0", null, "Alice", null), true);
  assert.equal(identifier.mapSpeaker("speaker_1", null, "Bob", null), true);

  const merges = identifier._performRecluster();
  assert.deepEqual(merges, [], "differing user-set names assert distinct identities");
});

test("an unidentified cluster still merges into an identified one", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  seedSimilarIdentifiedPair(identifier);
  assert.equal(identifier.mapSpeaker("speaker_0", 1, "Alice", null), true);

  const merges = identifier._performRecluster();
  assert.equal(merges.length, 1, "the guard must not block ordinary convergence");
  assert.equal(merges[0].displayName, "Alice");
});

test("a voice force-merged at the cap becomes its own speaker once the cap rises", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();
  identifier.setMaxSpeakers(1);

  const first = identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  const folded = identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });
  assert.equal(folded.speakerId, first.speakerId, "at the cap the voice is folded");

  // Participants added mid-meeting raise the cap; the folded voice must not
  // stay captured by a centroid polluted during the at-cap period.
  identifier.setMaxSpeakers(3);
  const recovered = identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });
  assert.notEqual(
    recovered.speakerId,
    first.speakerId,
    "after the cap rises the folded voice must get its own cluster"
  );
});

test("an at-cap fold never steals the cluster's identity for a profile-matched voice", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();
  identifier.setMaxSpeakers(1);
  identifier.getSpeakerProfiles = () => [
    { id: 1, display_name: "Alice", embedding: voiceA },
    { id: 2, display_name: "Bob", embedding: voiceB },
  ];

  const alice = identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  assert.equal(alice.displayName, "Alice");

  // Bob overflows the cap: his utterance is folded into Alice's cluster, but
  // the cluster must keep Alice's identity — retagging it as Bob would both
  // mislabel Alice and re-capture Bob through the profile lookup later.
  const bobAtCap = identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });
  assert.equal(bobAtCap.speakerId, alice.speakerId);
  assert.equal(bobAtCap.displayName, "Alice");

  identifier.setMaxSpeakers(3);
  const bobAfter = identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });
  assert.notEqual(bobAfter.speakerId, alice.speakerId, "Bob must get his own cluster");
  assert.equal(bobAfter.displayName, "Bob");

  const aliceAgain = identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  assert.equal(aliceAgain.speakerId, alice.speakerId);
  assert.equal(aliceAgain.displayName, "Alice", "Alice's cluster must still be hers");
});

test("distinct voices are folded into one cluster when the session cap is 1", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();
  identifier.setMaxSpeakers(1);

  const first = identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  const second = identifier._resolveSpeakerForEmbedding(voiceB, { updateCentroid: true });

  assert.equal(cosineSimilarity(voiceA, voiceB), 0);
  assert.equal(
    second.speakerId,
    first.speakerId,
    "at the cap, new voices are force-merged into the nearest cluster by design"
  );
});
