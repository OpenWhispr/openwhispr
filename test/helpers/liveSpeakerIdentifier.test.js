const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { downsample24kTo16k, pcm16ToFloat32 } = require("../../src/utils/audioUtils");

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
// ~0.706 similar to both A and B (0.707 is the most a vector can be to two
// orthogonal ones): fails the match margin, so it mints a cluster that the next
// recluster pass (threshold 0.70) merges back into A.
const ambiguousVoice = unit([1, 1, 0.05]);
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

// Plants exactly two clusters ~0.706 similar (above the 0.70 recluster
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

// A resumed note already holds earlier sessions' speaker ids, so a session
// started with a base mints past them; the next plain start begins at 0 again.
test("start() mints cluster ids from the session's speaker index base", async (t) => {
  const { LiveSpeakerIdentifier, restore } = loadIdentifier({
    ort: () => ({
      InferenceSession: { create: async () => ({ inputNames: [], outputNames: [] }) },
    }),
  });
  t.after(restore);
  const identifier = new LiveSpeakerIdentifier();
  stubDownloadedModels(identifier);

  assert.equal(await identifier.start({ speakerIndexBase: 3 }), true);
  assert.equal(identifier._assignSpeakerId(voiceA), "speaker_3");
  assert.equal(identifier._assignSpeakerId(ambiguousVoice), "speaker_4");
  await identifier.stop();

  assert.equal(await identifier.start(() => {}, {}), true);
  assert.equal(identifier._assignSpeakerId(voiceA), "speaker_0");
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

// Runs utterances through the real VAD loop: speech windows identify the voice
// while it speaks (interimVoice), then silence finalizes the segment
// (finalVoice), the only pass that may update a centroid.
function loadIdentifierHearingVoices() {
  let voice = null;
  let probability = 0;
  let cursor = 0;
  const { LiveSpeakerIdentifier } = loadIdentifier({
    extractEmbeddingFromSamples: async () => voice,
  });
  const identifier = new LiveSpeakerIdentifier();
  identifier._getVadProbability = async () => probability;

  const feed = async (windows, vadProbability) => {
    probability = vadProbability;
    for (let i = 0; i < windows; i++) {
      await identifier._processWindow(new Float32Array(512), cursor, cursor + 512);
      cursor += 512;
    }
  };
  const speak = async (interimVoice, finalVoice = interimVoice) => {
    voice = interimVoice;
    await feed(Math.ceil((16000 * 3) / 512), 1);
    voice = finalVoice;
    await feed(24, 0);
  };
  return { identifier, speak };
}

test("a voice folded at the cap stays out of the cluster's centroid", async () => {
  const { identifier, speak } = loadIdentifierHearingVoices();
  identifier.setMaxSpeakers(1);

  await speak(voiceA);
  for (let i = 0; i < 4; i++) await speak(voiceB);

  assert.deepEqual([...identifier.transientEmbeddings.keys()], ["speaker_0"]);
  assert.equal(
    cosineSimilarity(identifier.getSpeakerEmbedding("speaker_0"), voiceA),
    1,
    "the folded voice must not be averaged into the first speaker's voice"
  );

  identifier.setMaxSpeakers(3);
  await speak(voiceB);
  assert.equal(
    identifier.transientEmbeddings.size,
    2,
    "once the cap rises the folded voice gets its own cluster"
  );
});

test("a folded segment whose whole audio matches the cluster still updates it", async () => {
  const { identifier, speak } = loadIdentifierHearingVoices();
  identifier.setMaxSpeakers(1);
  const sameVoiceLater = unit([1, 0.4, 0]);

  await speak(voiceA);
  // The first seconds sound like nobody known, so the segment is folded; the
  // whole segment is the first speaker after all.
  await speak(voiceB, sameVoiceLater);

  assert.ok(
    cosineSimilarity(identifier.getSpeakerEmbedding("speaker_0"), sameVoiceLater) >
      cosineSimilarity(voiceA, sameVoiceLater)
  );
});

// Pins the calibrated values: a segment joins a voice from 0.60, two voices
// merge only from 0.70.
const similarToVoiceA = (similarity) =>
  unit([similarity, Math.sqrt(1 - similarity * similarity), 0]);

test("a segment joins an existing voice at 0.65 and starts a new one at 0.55", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const identifier = new LiveSpeakerIdentifier();
  identifier.setMaxSpeakers(3);

  const first = identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: false });
  const close = identifier._resolveSpeakerForEmbedding(similarToVoiceA(0.65), {
    updateCentroid: false,
  });
  const far = identifier._resolveSpeakerForEmbedding(similarToVoiceA(0.55), {
    updateCentroid: false,
  });

  assert.equal(close.speakerId, first.speakerId);
  assert.notEqual(far.speakerId, first.speakerId);
});

test("two voices merge at 0.75 and stay apart at 0.65", () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const apart = new LiveSpeakerIdentifier();
  apart.setMaxSpeakers(3);
  apart._assignSpeakerId(voiceA);
  apart._assignSpeakerId(similarToVoiceA(0.65));
  assert.deepEqual(apart._performRecluster(), []);

  const merged = new LiveSpeakerIdentifier();
  merged.setMaxSpeakers(3);
  merged._assignSpeakerId(voiceA);
  merged._assignSpeakerId(similarToVoiceA(0.75));
  assert.equal(merged._performRecluster().length, 1);
});

// Every 16 kHz sample the identifier produced, in order: the VAD windows it
// processed plus what is still buffered.
async function collect16kStream(identifier, chunks) {
  const windows = [];
  identifier.session = {}; // loaded: skip _ensureLoaded
  identifier._processWindow = async (window) => windows.push(Float32Array.from(window));
  for (const chunk of chunks) await identifier._processAudio(chunk);

  const stream = new Float32Array(identifier.sampleCursor + identifier.audioRemainder.length);
  windows.forEach((window, index) => stream.set(window, index * window.length));
  stream.set(identifier.audioRemainder, identifier.sampleCursor);
  return stream;
}

// Capture buffers come in arbitrary sizes: the Linux helper's 485 then 512
// samples, coalesced pipe reads, samples split across reads, and one buffer at
// an odd byteOffset.
function irregularChunks(source) {
  const sizes = [970, 1024, 1023, 1025, 1, 5, 4800, 1024];
  const chunks = [];
  for (let offset = 0, i = 0; offset < source.length; i++) {
    const size = sizes[i % sizes.length];
    chunks.push(source.subarray(offset, offset + size));
    offset += size;
  }
  const odd = Buffer.alloc(chunks[1].length + 1).subarray(1);
  chunks[1].copy(odd);
  chunks[1] = odd;
  return chunks;
}

// assert.deepEqual on 70k-sample arrays builds an enormous diff on failure.
function firstMismatch(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function makePcm(samples) {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(((i * 7919) % 60000) - 30000, i * 2);
  return pcm;
}

test("audio in irregular buffers resamples to the same 16 kHz stream as one buffer", async () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  // A whole number of resample groups, so nothing is left carried at the end.
  const source = makePcm(485 + 512 * 200);
  const expected = pcm16ToFloat32(downsample24kTo16k(source));

  const stream = await collect16kStream(new LiveSpeakerIdentifier(), irregularChunks(source));

  assert.equal(stream.length, expected.length, "no 16 kHz sample is lost or gained");
  assert.equal(firstMismatch(stream, expected), -1, "same samples, in order");
});

test("a new meeting never inherits the previous meeting's partial resample group", async () => {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const reused = new LiveSpeakerIdentifier();
  reused.session = {};
  await reused._processAudio(Buffer.alloc(4, 0x7f));
  reused._resetMeetingState();

  const chunks = irregularChunks(makePcm(512 * 30));
  const afterReset = await collect16kStream(reused, chunks);
  const fresh = await collect16kStream(new LiveSpeakerIdentifier(), chunks);

  assert.equal(firstMismatch(afterReset, fresh), -1);
});

// The gate (automatic mode): a voice that matches no confirmed speaker is held
// as a candidate until it has been heard enough, so one person drifting below
// the match threshold doesn't split into several speakers.
const bea = { id: 7, display_name: "Bea", embedding: voiceB };

function gatedIdentifier({ profiles = [] } = {}) {
  const { LiveSpeakerIdentifier } = loadIdentifier();
  const id = new LiveSpeakerIdentifier();
  id.setSpeakerLimit({ maxSpeakers: 7, gated: true });
  id.getSpeakerProfiles = () => profiles;
  return { id, LiveSpeakerIdentifier };
}

const hear = (identifier, voice, startTime, seconds) =>
  identifier._resolveSpeakerForEmbedding(voice, {
    updateCentroid: true,
    segment: { seconds, startTime, endTime: startTime + seconds },
  });

const pick = (result, ...keys) =>
  Object.fromEntries(
    (keys.length ? keys : ["speakerId", "backfill"]).map((key) => [key, result[key]])
  );

const oneHot = (axis) => {
  const values = new Array(12).fill(0);
  values[axis] = 1;
  return new Float32Array(values);
};

test("gated: the first voice is a speaker at once", () => {
  const { id } = gatedIdentifier();
  assert.equal(hear(id, voiceA, 0, 2).speakerId, "speaker_0");
});

test("gated: a voice heard once creates no speaker and uses no label number", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  assert.equal(hear(id, voiceB, 10, 2).speakerId, null);
  assert.equal(id._resolveSpeakerForEmbedding(voiceB, { updateCentroid: false }).speakerId, null);
  assert.equal(id.getConfirmedSpeakerCount(), 1);
  // One 12 s stretch is enough on its own; the next real speaker is Speaker 2.
  assert.equal(hear(id, voiceC, 20, 12).speakerId, "speaker_1");
});

test("gated: a third stretch totalling 8 s promotes the voice and hands back its earlier windows", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 3);
  hear(id, voiceB, 20, 3);
  const result = hear(id, voiceB, 30, 3);
  assert.equal(result.speakerId, "speaker_1");
  assert.deepEqual(result.backfill, [
    { startTime: 10, endTime: 13 },
    { startTime: 20, endTime: 23 },
  ]);
});

test("gated: three stretches under 8 s in total are not enough", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 2);
  hear(id, voiceB, 20, 2);
  assert.equal(hear(id, voiceB, 30, 2).speakerId, null);
});

test("gated: two long stretches are not enough short of 12 s each", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 5);
  assert.equal(hear(id, voiceB, 20, 5).speakerId, null);
});

test("gated: one stretch of 12 s is enough", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  assert.deepEqual(pick(hear(id, voiceB, 10, 12)), { speakerId: "speaker_1", backfill: [] });
});

test("gated: a voice 0.5 like a confirmed speaker joins it; ungated it does not", () => {
  const { id, LiveSpeakerIdentifier } = gatedIdentifier();
  const near = unit([0.5, 0.866, 0]); // 0.5 to A: above 0.45, below 0.6
  hear(id, voiceA, 0, 2);
  assert.equal(hear(id, near, 10, 3).speakerId, "speaker_0");

  const open = new LiveSpeakerIdentifier();
  open.setSpeakerLimit({ maxSpeakers: 3, gated: false });
  hear(open, voiceA, 0, 2);
  assert.equal(hear(open, near, 10, 3).speakerId, "speaker_1");
});

test("gated: a stored profile still needs 0.6", () => {
  const { id } = gatedIdentifier({ profiles: [bea] });
  hear(id, voiceA, 0, 2);
  const result = hear(id, unit([0, 0.5, 0.866]), 10, 3); // 0.5 to Bea's profile
  assert.equal(result.displayName ?? null, null);
  assert.equal(result.speakerId, null, "held as a candidate, not matched to Bea or to A");
});

test("gated: a candidate that settles onto a confirmed speaker is absorbed", () => {
  const { id } = gatedIdentifier();
  const drift = unit([0.42, 0.907, 0]); // 0.42 to A: below 0.45
  const settle = unit([0.42, 0.45, 0.788]); // 0.42 to A, 0.58 to drift; the pair's mean is 0.47 to A
  hear(id, voiceA, 0, 2);
  assert.equal(hear(id, drift, 10, 2).speakerId, null);
  const result = hear(id, settle, 20, 2);
  assert.equal(result.speakerId, "speaker_0");
  assert.deepEqual(result.backfill, [{ startTime: 10, endTime: 12 }]);
  assert.equal(id.getConfirmedSpeakerCount(), 1);
});

test("gated: a voice matching a stored profile is a speaker at once, with its name", () => {
  const { id } = gatedIdentifier({ profiles: [bea] });
  hear(id, voiceA, 0, 2);
  assert.deepEqual(pick(hear(id, voiceB, 10, 2), "speakerId", "displayName"), {
    speakerId: "speaker_1",
    displayName: "Bea",
  });
});

test("gated: at the cap a new voice stays a candidate", () => {
  const { id } = gatedIdentifier();
  id.setSpeakerLimit({ maxSpeakers: 1, gated: true });
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 4);
  hear(id, voiceB, 20, 4);
  assert.equal(hear(id, voiceB, 30, 4).speakerId, null);
  assert.equal(id.getConfirmedSpeakerCount(), 1);
});

test("turning the gate off drops candidates and behaves as before", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 2);
  id.setSpeakerLimit({ maxSpeakers: 3, gated: false });
  assert.equal(id._candidates.length, 0);
  assert.deepEqual(pick(hear(id, voiceB, 20, 2)), { speakerId: "speaker_1", backfill: [] });
});

test("candidates are not in the stop state, recluster or mapSpeaker", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 2);
  assert.deepEqual(Object.keys(id.getTransientState()), ["speaker_0"]);
  assert.deepEqual(id._performRecluster(), []);
  assert.equal(id.getSpeakerEmbedding("speaker_1"), null, "no speaker exists for the candidate");
  assert.equal(id.mapSpeaker("speaker_1", 3, "Bea", 9), false);

  // speaker_1 is exactly the id a promotion gives this candidate.
  assert.equal(hear(id, voiceB, 20, 12).speakerId, "speaker_1");
  assert.equal(id.mapSpeaker("speaker_1", 3, "Bea", 9), true);
});

test("a ready candidate held at the cap is promoted with all its windows once the cap rises", () => {
  const { id } = gatedIdentifier();
  id.setSpeakerLimit({ maxSpeakers: 1, gated: true });
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 4);
  hear(id, voiceB, 20, 4);
  assert.equal(hear(id, voiceB, 30, 4).speakerId, null);

  id.setSpeakerLimit({ maxSpeakers: 7, gated: true });
  assert.deepEqual(pick(hear(id, voiceB, 40, 4)), {
    speakerId: "speaker_1",
    backfill: [
      { startTime: 10, endTime: 14 },
      { startTime: 20, endTime: 24 },
      { startTime: 30, endTime: 34 },
    ],
  });
});

// Feeds 5 s of a new voice's live windows beside one confirmed speaker and
// counts the embeddings extracted.
async function countLiveExtractions({ gated }) {
  let extractions = 0;
  const { LiveSpeakerIdentifier } = loadIdentifier({
    extractEmbeddingFromSamples: async () => {
      extractions += 1;
      return voiceB;
    },
  });
  const identifier = new LiveSpeakerIdentifier();
  identifier.setSpeakerLimit({ maxSpeakers: 7, gated });
  identifier._resolveSpeakerForEmbedding(voiceA, { updateCentroid: true });
  identifier._getVadProbability = async () => 1;
  const emitted = [];
  identifier.onSpeakerIdentified = (event) => emitted.push(event);

  for (let cursor = 0; cursor < 16000 * 5; cursor += 512) {
    await identifier._processWindow(new Float32Array(512), cursor, cursor + 512);
  }
  return { extractions, emitted, identifier };
}

test("a held voice's live windows are throttled like any other voice's", async () => {
  const ungated = await countLiveExtractions({ gated: false });
  const gated = await countLiveExtractions({ gated: true });

  assert.equal(ungated.extractions, 4, "about one extraction per second of speech");
  assert.equal(gated.extractions, ungated.extractions);
  assert.deepEqual(gated.emitted, [], "a held voice is never identified live");
  assert.equal(gated.identifier.currentSegmentSpeakerId, null);
  assert.equal(gated.identifier.currentSegmentSpeakerName, null);
});

test("at most 8 candidates are kept, the weakest dropped first", () => {
  const { id } = gatedIdentifier();
  hear(id, oneHot(0), 0, 2);
  for (let i = 1; i <= 9; i += 1) hear(id, oneHot(i), i * 10, i === 1 ? 1.6 : 3);
  assert.equal(id._candidates.length, 8);
  // The 1.6 s one was dropped, so this starts again.
  assert.equal(hear(id, oneHot(1), 200, 3).speakerId, null);
  const restarted = id._candidates.find((candidate) =>
    candidate.windows.some((window) => window.startTime === 200)
  );
  assert.equal(restarted.windows.length, 1);
});

test("start() resets candidates with the rest of the meeting state", () => {
  const { id } = gatedIdentifier();
  hear(id, voiceA, 0, 2);
  hear(id, voiceB, 10, 2);
  id._resetMeetingState();
  assert.equal(id._candidates.length, 0);
});

test("a promotion emits the earlier windows first, flagged retroactive", async () => {
  let voice = null;
  const { LiveSpeakerIdentifier } = loadIdentifier({
    extractEmbeddingFromSamples: async () => voice,
  });
  const identifier = new LiveSpeakerIdentifier();
  identifier.setSpeakerLimit({ maxSpeakers: 7, gated: true });
  const emitted = [];
  identifier.onSpeakerIdentified = (event) => emitted.push(event);

  const finishSegment = async (segmentVoice, startSeconds) => {
    voice = segmentVoice;
    identifier.speechActive = true;
    identifier.speechChunks = [new Float32Array(16000 * 3)];
    identifier.segmentStartSample = 16000 * startSeconds;
    identifier.segmentEndSample = 16000 * (startSeconds + 3);
    await identifier._finalizeSpeechSegment();
  };

  await finishSegment(voiceA, 0);
  for (const startSeconds of [10, 20, 30]) await finishSegment(voiceB, startSeconds);

  assert.deepEqual(
    emitted.map((e) => [e.speakerId, !!e.retroactive]),
    [
      ["speaker_0", false],
      ["speaker_1", true],
      ["speaker_1", true],
      ["speaker_1", false],
    ]
  );
  assert.deepEqual(
    emitted.map((e) => e.startTime),
    [0, 9.25, 19.25, 29.25],
    "the earlier windows go out oldest first, before the current one"
  );
});

test("the gate's evidence rule and thresholds are pinned", () => {
  loadIdentifier();
  assert.deepEqual(
    pick(
      require(identifierModulePath),
      "CANDIDATE_MIN_SEGMENTS",
      "CANDIDATE_MIN_SECONDS",
      "CANDIDATE_SOLO_SECONDS",
      "MAX_CANDIDATES",
      "AUTO_MATCH_THRESHOLD"
    ),
    {
      CANDIDATE_MIN_SEGMENTS: 3,
      CANDIDATE_MIN_SECONDS: 8,
      CANDIDATE_SOLO_SECONDS: 12,
      MAX_CANDIDATES: 8,
      AUTO_MATCH_THRESHOLD: 0.45,
    }
  );
});
