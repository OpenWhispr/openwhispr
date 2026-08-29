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

function loadIdentifier(options = {}) {
  delete require.cache[identifierModulePath];
  const warnings = [];
  const interceptsOrt = "ort" in options;

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
        extractEmbeddingFromSamples: options.extractEmbeddingFromSamples || (async () => null),
      };
    }
    if (interceptsOrt && request === "onnxruntime-node") {
      return options.ort();
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const restore = () => {
    Module._load = originalLoad;
  };

  try {
    const { LiveSpeakerIdentifier } = require(identifierModulePath);
    return { LiveSpeakerIdentifier, warnings, restore };
  } finally {
    // The ort hook must outlive module load: the identifier requires
    // onnxruntime-node lazily, from inside the test body.
    if (!interceptsOrt) restore();
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

test("mapSpeaker on an unknown id fails loudly during a live session", () => {
  const { LiveSpeakerIdentifier, warnings } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  identifier.setMaxSpeakers(3);
  identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  identifier.running = true;

  const mapped = identifier.mapSpeaker("speaker_9", 1, "Alice", null);
  assert.equal(mapped, false);
  const warning = warnings.find((w) => /speaker/i.test(w.message));
  assert.ok(warning, "a dropped manual identification must leave a trace in the logs");
  assert.ok(
    !JSON.stringify(warning.data ?? {}).includes("Alice"),
    "the participant's name must not be written to the logs"
  );
});

// Labeling a speaker in a past note, or editing that note's participants, routes
// through mapSpeaker with no live session and no transient clusters. Nothing was
// dropped, so warning there would put noise in every user's production log file.
test("mapSpeaker stays quiet when no session is running", () => {
  const { LiveSpeakerIdentifier, warnings } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();

  assert.equal(identifier.mapSpeaker("speaker_0", 1, "Alice", 42), false);
  assert.deepEqual(warnings, []);
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

// onnxruntime-node ships no darwin/x64 prebuilt binding since 1.24, so on Intel
// Macs the lazy require throws MODULE_NOT_FOUND (#1500). Speaker identification
// must degrade to "unavailable" — never take the whole meeting start down.
function missingBindingRequire() {
  const error = new Error(
    "Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'"
  );
  error.code = "MODULE_NOT_FOUND";
  throw error;
}

function stubDownloadedModels(identifier) {
  identifier.setDiarizationManager({
    isVadModelDownloaded: () => true,
    getVadModelPath: () => __filename,
  });
}

test("isAvailable() is false when the onnxruntime binding cannot load", (t) => {
  const { LiveSpeakerIdentifier, restore } = loadIdentifier({ ort: missingBindingRequire });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  assert.equal(identifier.isAvailable(), false);
});

test("start() resolves false instead of rejecting when the binding is missing", async (t) => {
  const { LiveSpeakerIdentifier, restore } = loadIdentifier({ ort: missingBindingRequire });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  const started = await identifier.start(() => {}, {});
  assert.equal(started, false, "a missing native binding must not fail meeting start");
});

test("the binding failure is logged once, not on every availability check", (t) => {
  const { LiveSpeakerIdentifier, warnings, restore } = loadIdentifier({
    ort: missingBindingRequire,
  });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  identifier.isAvailable();
  identifier.isAvailable();

  const bindingWarnings = warnings.filter((w) => /onnxruntime/i.test(w.message));
  assert.equal(bindingWarnings.length, 1, "repeated checks must not spam the logs");
});

test("isAvailable() stays true when the binding loads", (t) => {
  const { LiveSpeakerIdentifier, restore } = loadIdentifier({ ort: () => ({}) });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  assert.equal(Boolean(identifier.isAvailable()), true);
});

// onnxruntime-node defaults intra-op threads to every core with spinning
// workers — absurd for the tiny VAD graph running ~31x/sec, and a CPU
// regression during every meeting recording.
test("the VAD session caps ORT to a single sequential thread", async (t) => {
  let createArgs = null;
  const { LiveSpeakerIdentifier, restore } = loadIdentifier({
    ort: () => ({
      InferenceSession: {
        create: async (...args) => {
          createArgs = args;
          return { inputNames: [], outputNames: [] };
        },
      },
    }),
  });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  assert.equal(await identifier.start(() => {}, {}), true);
  assert.deepEqual(createArgs, [
    __filename,
    { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential" },
  ]);
});

// _identifyActiveSpeechSegment runs on every speech window (~31x/sec), so its
// gates must reject cheaply — before any chunk concat or embedding work — and
// force must bypass only the interval gate, never the minimum-samples check.
const LIVE_ID_MIN_SAMPLES = Math.round(16000 * 1.6);
const LIVE_ID_INTERVAL_SAMPLES = 16000;
const MAX_EMBEDDING_SAMPLES = 16000 * 8; // MAX_EMBEDDING_SECONDS stubbed to 8

function loadIdentifierCapturingEmbeddings() {
  const embeddingInputs = [];
  const { LiveSpeakerIdentifier } = loadIdentifier({
    extractEmbeddingFromSamples: async (samples) => {
      embeddingInputs.push(samples);
      return voiceA;
    },
  });
  return { identifier: new LiveSpeakerIdentifier(), embeddingInputs };
}

test("live identification below the minimum sample count never embeds, even forced", async () => {
  const { identifier, embeddingInputs } = loadIdentifierCapturingEmbeddings();
  identifier.speechChunks = [new Float32Array(LIVE_ID_MIN_SAMPLES - 1)];
  identifier.segmentEndSample = LIVE_ID_MIN_SAMPLES - 1;

  await identifier._identifyActiveSpeechSegment();
  await identifier._identifyActiveSpeechSegment(true);

  assert.equal(embeddingInputs.length, 0);
});

test("the interval gate throttles repeat identification; force bypasses it", async () => {
  const { identifier, embeddingInputs } = loadIdentifierCapturingEmbeddings();
  identifier.speechChunks = [new Float32Array(LIVE_ID_MIN_SAMPLES)];
  identifier.lastLiveIdentificationSample = 50000;
  identifier.segmentEndSample = 50000 + LIVE_ID_INTERVAL_SAMPLES - 1;

  await identifier._identifyActiveSpeechSegment();
  assert.equal(embeddingInputs.length, 0, "within the interval, identification is throttled");

  await identifier._identifyActiveSpeechSegment(true);
  assert.equal(embeddingInputs.length, 1, "force must bypass the interval gate");
  assert.equal(identifier.lastLiveIdentificationSample, identifier.segmentEndSample);

  identifier.segmentEndSample += LIVE_ID_INTERVAL_SAMPLES;
  await identifier._identifyActiveSpeechSegment();
  assert.equal(embeddingInputs.length, 2, "once the interval elapses, identification resumes");
});

test("identification embeds the exact tail of the concatenated speech chunks", async () => {
  const { identifier, embeddingInputs } = loadIdentifierCapturingEmbeddings();
  const chunks = [1, 2, 3, 4].map((value) => new Float32Array(40000).fill(value));
  identifier.speechChunks = chunks;
  identifier.segmentEndSample = 160000;

  await identifier._identifyActiveSpeechSegment();

  const flat = new Float32Array(160000);
  chunks.forEach((chunk, i) => flat.set(chunk, i * 40000));
  assert.deepEqual(
    embeddingInputs[0],
    flat.subarray(flat.length - MAX_EMBEDDING_SAMPLES),
    "the embedding window must stay byte-identical to the pre-fix concat + slice"
  );
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
