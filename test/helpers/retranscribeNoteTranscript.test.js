const test = require("node:test");
const assert = require("node:assert/strict");

const {
  retranscribeNoteTranscript,
} = require("../../src/helpers/retranscribeNoteTranscript");

// Re-transcription used to overwrite the structured, speaker-labelled transcript with
// a plain-text blob every single time. These tests pin the contract that replaced it:
// produce structured segments and keep the speaker identities, or refuse to write.

const MODEL_PATH = "/models/large.bin";

function segment(overrides) {
  return { text: "hello", source: "system", timestamp: 0, ...overrides };
}

function createDeps({
  note = {},
  whisperResult,
  diarizeResult = null,
  diarizationAvailable = false,
  storedEmbeddings = [],
  missingFiles = [],
} = {}) {
  const updates = [];
  const savedEmbeddings = [];
  const prunedEmbeddings = [];
  const removedMappings = [];

  const deps = {
    note: {
      id: 1,
      transcript: null,
      mic_audio_path: null,
      system_audio_path: null,
      ...note,
    },
    whisperManager: {
      getModelPath: () => MODEL_PATH,
      transcribeLocalWhisper: async () =>
        whisperResult ?? {
          success: true,
          text: "brand new words",
          segments: [{ start: 0, end: 2, text: "brand new words" }],
        },
    },
    diarizationManager: {
      isAvailable: () => diarizationAvailable,
      diarize: async () => diarizeResult,
      mergeWithTranscript: (transcriptSegments, diarizationSegments) => {
        // Mirrors the real renumbering: clusters become speaker_0..n, mic becomes "you".
        const ids = [...new Set(diarizationSegments.map((d) => d.speaker))];
        return transcriptSegments.map((seg) => {
          if (seg.source === "mic") return { ...seg, speaker: "you" };
          const hit = diarizationSegments.find(
            (d) => seg.timestamp >= d.start && seg.timestamp < d.end
          );
          return { ...seg, speaker: hit ? `speaker_${ids.indexOf(hit.speaker)}` : undefined };
        });
      },
    },
    databaseManager: {
      updateNote: (id, patch) => updates.push({ id, patch }),
      getNoteSpeakerEmbeddings: () => storedEmbeddings,
      saveNoteSpeakerEmbeddings: (id, map) => savedEmbeddings.push({ id, map }),
      pruneNoteSpeakerEmbeddings: (id, keep) => prunedEmbeddings.push({ id, keep }),
      getSpeakerMappings: () => [],
      removeSpeakerMapping: (id, speakerId) => removedMappings.push({ id, speakerId }),
    },
    convertToWav: async () => {},
    fileExists: (p) => !missingFiles.includes(p),
    readFile: () => Buffer.from("fake wav"),
    speakerEmbeddings: { isAvailable: () => false },
  };

  return { deps, updates, savedEmbeddings, prunedEmbeddings, removedMappings };
}

async function run(overrides) {
  const ctx = createDeps(overrides);
  const result = await retranscribeNoteTranscript(ctx.deps);
  return { ...ctx, result };
}

test("model missing is reported distinctly, not as a failure or a preserve", async () => {
  const { result } = await run({ missingFiles: [MODEL_PATH] });

  assert.equal(result.outcome, "model-missing");
  assert.equal(result.transcript, null);
});

test("mic-only note is rewritten as structured segments, tagged mic", async () => {
  const { result } = await run({
    note: {
      mic_audio_path: "/audio/mic.opus",
      transcript: JSON.stringify([segment({ source: "mic", speaker: "you" })]),
    },
  });

  assert.equal(result.outcome, "written");
  const written = JSON.parse(result.transcript);
  assert.equal(written.length, 1);
  assert.equal(written[0].source, "mic");
  assert.equal(written[0].speaker, "you");
  assert.equal(written[0].text, "brand new words");
});

test("mic-only note transcribes the mic track even when a system file exists", async () => {
  const transcribed = [];
  const ctx = createDeps({
    note: {
      mic_audio_path: "/audio/mic.opus",
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([segment({ source: "mic", speaker: "you" })]),
    },
  });
  ctx.deps.convertToWav = async (src) => transcribed.push(src);

  const result = await retranscribeNoteTranscript(ctx.deps);

  assert.equal(result.outcome, "written");
  assert.deepEqual(transcribed, ["/audio/mic.opus"]);
});

test("dual-source transcript is preserved rather than rewritten from one track", async () => {
  const { result, updates } = await run({
    note: {
      mic_audio_path: "/audio/mic.opus",
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([
        segment({ source: "system", speaker: "speaker_0" }),
        segment({ source: "mic", speaker: "you", timestamp: 5 }),
      ]),
    },
  });

  assert.equal(result.outcome, "preserved");
  assert.equal(result.transcript, null);
  assert.equal(result.reason, "incomplete-source-coverage");
  assert.deepEqual(updates, [], "must not touch the transcript it cannot fully replace");
});

test("a segment with no source is preserved — the gate fails safe", async () => {
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([{ text: "hi", timestamp: 0 }]),
    },
  });

  assert.equal(result.outcome, "preserved");
});

test("whisper returning no segments preserves the old transcript", async () => {
  const { result, updates } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([segment({ speaker: "speaker_0" })]),
    },
    whisperResult: { success: true, text: "flat text with no timings" },
  });

  assert.equal(result.outcome, "preserved");
  assert.equal(result.reason, "no-segments");
  assert.equal(result.text, "flat text with no timings", "text is still usable in memory");
  assert.deepEqual(updates, []);
});

test("an already flattened transcript is rewritten — nothing left to lose", async () => {
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: "just a flat blob of text",
    },
  });

  assert.equal(result.outcome, "written");
  assert.ok(result.transcript.startsWith("["));
});

test("timestamps are emitted in seconds and `end` is not persisted", async () => {
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([segment({ speaker: "speaker_0" })]),
    },
    whisperResult: {
      success: true,
      text: "one two",
      segments: [
        { start: 1.5, end: 3, text: "one" },
        { start: 4.25, end: 6, text: "two" },
      ],
    },
  });

  const written = JSON.parse(result.transcript);
  assert.deepEqual(
    written.map((s) => s.timestamp),
    [1.5, 4.25]
  );
  // SpeakerPanel divides (end - timestamp) by 1000, so a seconds-valued `end` would
  // render every speaker's talk time as ~0.
  assert.ok(written.every((s) => s.end === undefined));
});

test("named, locked speakers survive re-transcription", async () => {
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([
        segment({
          speaker: "speaker_0",
          speakerName: "Alice",
          speakerIsPlaceholder: false,
          speakerStatus: "locked",
          speakerLocked: true,
          speakerLockSource: "user",
          timestamp: 0,
        }),
        segment({ speaker: "speaker_1", speakerName: "Bob", timestamp: 10 }),
      ]),
    },
    whisperResult: {
      success: true,
      text: "alpha beta",
      segments: [
        { start: 0.5, end: 2, text: "alpha" },
        { start: 10.5, end: 12, text: "beta" },
      ],
    },
  });

  const written = JSON.parse(result.transcript);
  assert.equal(written[0].speaker, "speaker_0");
  assert.equal(written[0].speakerName, "Alice");
  assert.equal(written[0].speakerLocked, true);
  assert.equal(written[1].speaker, "speaker_1");
  assert.equal(written[1].speakerName, "Bob");
});

test("old epoch-millisecond timestamps are normalized before matching", async () => {
  const base = 1_800_000_000_000;
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([
        segment({ speaker: "speaker_0", speakerName: "Alice", timestamp: base }),
        segment({ speaker: "speaker_1", speakerName: "Bob", timestamp: base + 10_000 }),
      ]),
    },
    whisperResult: {
      success: true,
      text: "alpha beta",
      segments: [
        { start: 0.5, end: 2, text: "alpha" },
        { start: 10.5, end: 12, text: "beta" },
      ],
    },
  });

  const written = JSON.parse(result.transcript);
  assert.equal(written[0].speakerName, "Alice");
  assert.equal(written[1].speakerName, "Bob");
});

test("re-clustered speakers are relabelled by overlap, not by cluster index", async () => {
  // Diarization emits its clusters in the opposite order this time: the person who was
  // speaker_0 is now cluster 1. Matching by index would swap Alice and Bob.
  const { result } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([
        segment({ speaker: "speaker_0", speakerName: "Alice", timestamp: 0 }),
        segment({ speaker: "speaker_1", speakerName: "Bob", timestamp: 10 }),
      ]),
    },
    diarizationAvailable: true,
    diarizeResult: [
      { speaker: "cluster_b", start: 10, end: 13 },
      { speaker: "cluster_a", start: 0, end: 3 },
    ],
    whisperResult: {
      success: true,
      text: "alpha beta",
      segments: [
        { start: 0.5, end: 2, text: "alpha" },
        { start: 10.5, end: 12, text: "beta" },
      ],
    },
  });

  const written = JSON.parse(result.transcript);
  assert.equal(written[0].speakerName, "Alice", "0.5s belongs to whoever spoke at 0s");
  assert.equal(written[1].speakerName, "Bob");
});

test("diarization failure still yields structured segments", async () => {
  const ctx = createDeps({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([segment({ speaker: "speaker_0", speakerName: "Alice" })]),
    },
    diarizationAvailable: true,
  });
  ctx.deps.diarizationManager.diarize = async () => {
    throw new Error("diarization exploded");
  };

  const result = await retranscribeNoteTranscript(ctx.deps);

  assert.equal(result.outcome, "written");
  const written = JSON.parse(result.transcript);
  assert.equal(written[0].speakerName, "Alice", "falls back to timestamp overlap");
});

test("embedding rows for speakers that no longer exist are pruned", async () => {
  const { result, prunedEmbeddings } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([
        segment({ speaker: "speaker_0", speakerName: "Alice", timestamp: 0 }),
        segment({ speaker: "speaker_2", speakerName: "Carol", timestamp: 60 }),
      ]),
    },
    whisperResult: {
      success: true,
      text: "alpha",
      segments: [{ start: 0.5, end: 2, text: "alpha" }],
    },
  });

  assert.equal(result.outcome, "written");
  assert.equal(prunedEmbeddings.length, 1);
  // Carol is gone from the new transcript; her stale embedding row must not survive to
  // poison retroactive mapping.
  assert.deepEqual([...prunedEmbeddings[0].keep], ["speaker_0"]);
});

test("stale speaker mappings are removed when the old transcript is unreadable", async () => {
  const ctx = createDeps({
    note: { system_audio_path: "/audio/system.opus", transcript: "flat blob" },
    diarizationAvailable: true,
    diarizeResult: [{ speaker: "cluster_a", start: 0, end: 3 }],
  });
  ctx.deps.databaseManager.getSpeakerMappings = () => [
    { note_id: 1, speaker_id: "speaker_0", display_name: "Alice" },
  ];

  const result = await retranscribeNoteTranscript(ctx.deps);

  assert.equal(result.outcome, "written");
  assert.deepEqual(ctx.removedMappings, [{ id: 1, speakerId: "speaker_0" }]);
});

test("preserved outcomes never write and never lose the old transcript", async () => {
  const { updates } = await run({
    note: {
      system_audio_path: "/audio/system.opus",
      transcript: JSON.stringify([segment({ speaker: "speaker_0" })]),
    },
    whisperResult: { success: true, text: "no timings here" },
  });

  assert.deepEqual(updates, []);
});
