const test = require("node:test");
const assert = require("node:assert/strict");

const liveSpeakerIdentifier = require("../../src/helpers/liveSpeakerIdentifier");

// Orthogonal unit vectors stand in for clearly different voices; the identifier's
// clustering decisions are pure cosine comparisons, so no model is needed.
const voice = (index) => {
  const v = new Float32Array(4);
  v[index] = 1;
  return v;
};

const blend = (a, b, weight) => {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] * (1 - weight) + b[i] * weight;
  return out;
};

function withClusters(clusters, maxSpeakers) {
  liveSpeakerIdentifier.transientEmbeddings = new Map(clusters);
  liveSpeakerIdentifier.transientCounts = new Map([...clusters].map(([id]) => [id, 2]));
  liveSpeakerIdentifier.transientDisplayNames = new Map();
  liveSpeakerIdentifier.transientProfileIds = new Map();
  liveSpeakerIdentifier.transientNoteIds = new Map();
  liveSpeakerIdentifier.getSpeakerProfiles = () => [];
  liveSpeakerIdentifier.currentSegmentSpeakerId = null;
  liveSpeakerIdentifier.currentSegmentSpeakerName = null;
  liveSpeakerIdentifier.currentSegmentHadSpeakerChange = false;
  liveSpeakerIdentifier.nextLiveIndex = clusters.length;
  liveSpeakerIdentifier.maxSpeakers = maxSpeakers;
}

test("a new voice is not filed under an existing speaker just to respect the cap", () => {
  withClusters(
    [
      ["speaker_0", voice(0)],
      ["speaker_1", voice(1)],
    ],
    2
  );

  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(voice(2));

  assert.equal(speakerId, "speaker_2");
});

test("a voice that matches an existing speaker joins it rather than opening a cluster", () => {
  withClusters(
    [
      ["speaker_0", voice(0)],
      ["speaker_1", voice(1)],
    ],
    2
  );

  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(
    blend(voice(1), voice(2), 0.2)
  );

  assert.equal(speakerId, "speaker_1");
});

test("the speaker changes mid-utterance when the voice clearly does", () => {
  withClusters(
    [
      ["speaker_0", voice(0)],
      ["speaker_1", voice(1)],
    ],
    4
  );
  liveSpeakerIdentifier.currentSegmentSpeakerId = "speaker_0";

  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(voice(1), {
    allowSpeakerChange: true,
  });

  assert.equal(speakerId, "speaker_1");
  assert.equal(liveSpeakerIdentifier.currentSegmentHadSpeakerChange, true);
});

test("without allowSpeakerChange an attributed segment keeps its speaker", () => {
  withClusters(
    [
      ["speaker_0", voice(0)],
      ["speaker_1", voice(1)],
    ],
    4
  );
  liveSpeakerIdentifier.currentSegmentSpeakerId = "speaker_0";

  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(voice(1));

  assert.equal(speakerId, "speaker_0");
  assert.equal(liveSpeakerIdentifier.currentSegmentHadSpeakerChange, false);
});

test("the same voice continuing does not trigger a speaker change", () => {
  withClusters([["speaker_0", voice(0)]], 4);
  liveSpeakerIdentifier.currentSegmentSpeakerId = "speaker_0";

  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(
    blend(voice(0), voice(3), 0.15),
    { allowSpeakerChange: true }
  );

  assert.equal(speakerId, "speaker_0");
  assert.equal(liveSpeakerIdentifier.currentSegmentHadSpeakerChange, false);
});

test("a mixed-voice embedding never teaches the centroid", () => {
  withClusters([["speaker_0", voice(0)]], 4);
  liveSpeakerIdentifier.currentSegmentSpeakerId = "speaker_0";
  // Similar enough to keep the speaker, too dissimilar to be trusted as training data.
  const mixed = blend(voice(0), voice(3), 0.57);

  liveSpeakerIdentifier._resolveSpeakerForEmbedding(mixed, { updateCentroid: true });

  assert.deepEqual([...liveSpeakerIdentifier.transientEmbeddings.get("speaker_0")], [
    ...voice(0),
  ]);
});

test("the hard ceiling still forces a merge once every slot is used", () => {
  const { MAX_SPEAKER_COUNT } = require("../../src/constants/speakerDetection.json");
  const clusters = [];
  for (let i = 0; i < MAX_SPEAKER_COUNT; i += 1) {
    const v = new Float32Array(MAX_SPEAKER_COUNT + 1);
    v[i] = 1;
    clusters.push([`speaker_${i}`, v]);
  }
  withClusters(clusters, MAX_SPEAKER_COUNT);

  const stranger = new Float32Array(MAX_SPEAKER_COUNT + 1);
  stranger[MAX_SPEAKER_COUNT] = 1;
  const { speakerId } = liveSpeakerIdentifier._resolveSpeakerForEmbedding(stranger);

  assert.ok(clusters.some(([id]) => id === speakerId));
});
