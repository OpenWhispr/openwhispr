const fs = require("fs");
const path = require("path");
const os = require("os");
const debugLogger = require("./debugLogger");

// Whisper re-segments the audio, so a rewritten transcript can only keep its speaker
// identities by re-deriving them. Everything here exists to make that possible, or to
// refuse the rewrite when it is not.

const SEGMENT_TAIL_SECONDS = 2.5;
const EMBEDDING_MATCH_THRESHOLD = 0.6;
const EPOCH_MS_THRESHOLD = 1e9;
const UNKNOWN_SOURCE = " unknown";

const IDENTITY_FIELDS = [
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
];

function parseStoredSegments(transcript) {
  if (typeof transcript !== "string" || !transcript.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Stored timestamps are seconds-from-start when the note went through diarization, and
// epoch milliseconds when it did not. Mic segments can precede the system stream, so
// negative seconds are legitimate.
function normalizeTimestamps(segments) {
  const stamps = segments.map((s) => s.timestamp).filter((t) => Number.isFinite(t));
  if (!stamps.length) return segments;
  const origin = Math.min(...stamps);
  if (origin <= EPOCH_MS_THRESHOLD) return segments;
  return segments.map((s) => ({
    ...s,
    timestamp: Number.isFinite(s.timestamp) ? (s.timestamp - origin) / 1000 : s.timestamp,
  }));
}

function sourcesOf(segments) {
  return new Set(segments.map((s) => s.source || UNKNOWN_SOURCE));
}

// Mirrors mergeWithTranscript: a segment runs until the next segment from the same
// source, since interleaved segments from the other track say nothing about its end.
function withRanges(segments) {
  return segments.map((seg, index) => {
    const start = Number.isFinite(seg.timestamp) ? seg.timestamp : null;
    let end = null;
    if (start != null) {
      for (let i = index + 1; i < segments.length; i += 1) {
        const next = segments[i];
        if (next.source === seg.source && Number.isFinite(next.timestamp)) {
          end = next.timestamp;
          break;
        }
      }
      if (end == null || end <= start) end = start + SEGMENT_TAIL_SECONDS;
    }
    return { ...seg, rangeStart: start, rangeEnd: end };
  });
}

function overlap(a, b) {
  if (a.rangeStart == null || b.rangeStart == null) return 0;
  return Math.max(0, Math.min(a.rangeEnd, b.rangeEnd) - Math.max(a.rangeStart, b.rangeStart));
}

function collectIdentities(oldSegments) {
  const identities = new Map();
  for (const seg of oldSegments) {
    if (!seg.speaker) continue;
    const existing = identities.get(seg.speaker);
    // A named segment beats an unnamed one for the same speaker.
    if (existing && !(seg.speakerName && !existing.speakerName)) continue;
    const identity = {};
    for (const field of IDENTITY_FIELDS) {
      if (seg[field] !== undefined) identity[field] = seg[field];
    }
    identities.set(seg.speaker, identity);
  }
  return identities;
}

function freshSpeakerIdFactory(takenIds) {
  let next = 0;
  return () => {
    let candidate = `speaker_${next}`;
    while (takenIds.has(candidate)) {
      next += 1;
      candidate = `speaker_${next}`;
    }
    takenIds.add(candidate);
    return candidate;
  };
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toFloat32(embedding) {
  if (embedding instanceof Float32Array) return embedding;
  if (Array.isArray(embedding)) return new Float32Array(embedding);
  if (embedding?.buffer) {
    return new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
  }
  return null;
}

// Greedy one-to-one: a cluster is one person, so two clusters must not claim the same
// prior identity.
function matchClustersByEmbedding(clusterEmbeddings, storedEmbeddings) {
  const pairs = [];
  for (const [clusterId, embedding] of Object.entries(clusterEmbeddings || {})) {
    const clusterVec = toFloat32(embedding);
    if (!clusterVec) continue;
    for (const stored of storedEmbeddings || []) {
      const storedVec = toFloat32(stored.embedding);
      if (!storedVec) continue;
      const similarity = cosineSimilarity(clusterVec, storedVec);
      if (similarity > EMBEDDING_MATCH_THRESHOLD) {
        pairs.push({ clusterId, oldId: stored.speaker_id, similarity });
      }
    }
  }

  pairs.sort((a, b) => b.similarity - a.similarity);
  const resolved = new Map();
  const usedOld = new Set();
  for (const pair of pairs) {
    if (resolved.has(pair.clusterId) || usedOld.has(pair.oldId)) continue;
    resolved.set(pair.clusterId, pair.oldId);
    usedOld.add(pair.oldId);
  }
  return resolved;
}

function matchClustersByOverlap(newSegments, oldSegments, alreadyResolved) {
  const totals = new Map();
  for (const seg of newSegments) {
    if (!seg.speaker || alreadyResolved.has(seg.speaker)) continue;
    for (const old of oldSegments) {
      if (!old.speaker || old.source !== seg.source) continue;
      const amount = overlap(seg, old);
      if (amount <= 0) continue;
      const key = `${seg.speaker} ${old.speaker}`;
      totals.set(key, (totals.get(key) || 0) + amount);
    }
  }

  const pairs = [...totals.entries()].map(([key, amount]) => {
    const [clusterId, oldId] = key.split(" ");
    return { clusterId, oldId, amount };
  });
  pairs.sort((a, b) => b.amount - a.amount);

  const resolved = new Map(alreadyResolved);
  const usedOld = new Set(alreadyResolved.values());
  for (const pair of pairs) {
    if (resolved.has(pair.clusterId) || usedOld.has(pair.oldId)) continue;
    resolved.set(pair.clusterId, pair.oldId);
    usedOld.add(pair.oldId);
  }
  return resolved;
}

// Without clusters there is nothing to hold one-to-one: many segments can legitimately
// belong to the same person, so each takes whichever old speaker it overlaps most.
function assignSpeakersByOverlap(newSegments, oldSegments) {
  return newSegments.map((seg) => {
    if (seg.speaker) return seg;
    let best = null;
    let bestAmount = 0;
    for (const old of oldSegments) {
      if (!old.speaker || old.source !== seg.source) continue;
      const amount = overlap(seg, old);
      if (amount > bestAmount) {
        bestAmount = amount;
        best = old.speaker;
      }
    }
    return best ? { ...seg, speaker: best } : seg;
  });
}

// P0-1a transcribes a single track, so it may only rewrite a transcript whose sources
// that track fully covers. Dual-source notes wait for P0-1b rather than losing a side.
function isCoveredBy(sources, trackSource) {
  for (const source of sources) {
    if (source !== trackSource) return false;
  }
  return true;
}

function chooseTrack(note, oldSources, fileExists) {
  const mic = note.mic_audio_path && fileExists(note.mic_audio_path) ? note.mic_audio_path : null;
  const system =
    note.system_audio_path && fileExists(note.system_audio_path) ? note.system_audio_path : null;

  if (oldSources.has(UNKNOWN_SOURCE)) return null;

  const wantsMic = oldSources.has("mic");
  const wantsSystem = oldSources.has("system");
  if (wantsMic && wantsSystem) return null;
  if (wantsMic) return mic ? { audioPath: mic, source: "mic" } : null;
  if (wantsSystem) return system ? { audioPath: system, source: "system" } : null;

  if (system) return { audioPath: system, source: "system" };
  if (mic) return { audioPath: mic, source: "mic" };
  return null;
}

async function extractClusterEmbeddings({
  speakerEmbeddings,
  wavPath,
  diarizationSegments,
  clusterIdFor,
}) {
  if (!speakerEmbeddings?.isAvailable?.() || !wavPath) return null;
  const map = {};
  const rawIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
  for (const rawId of rawIds) {
    const longest = diarizationSegments
      .filter((s) => s.speaker === rawId)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, 3);
    const embeddings = [];
    for (const seg of longest) {
      if (seg.end - seg.start < 1.5) continue;
      const embedding = await speakerEmbeddings.extractEmbedding(wavPath, seg.start, seg.end);
      if (embedding) embeddings.push(embedding);
    }
    if (embeddings.length) {
      map[clusterIdFor(rawId)] = Array.from(speakerEmbeddings.computeCentroid(embeddings));
    }
  }
  return Object.keys(map).length ? map : null;
}

function buildDiarizedSegments({ newSegments, diarizationManager, diarizationSegments }) {
  const merged = diarizationManager.mergeWithTranscript(newSegments, diarizationSegments);
  if (!merged?.length) return null;
  // mergeWithTranscript renumbers to speaker_0..n. Namespace those ids so they cannot be
  // confused with the old transcript's speaker_0..n before they are deliberately mapped.
  // Match on id, not index: mergeWithTranscript can drop segments (echo dedupe), and a
  // positional join would then attach every speaker to the wrong words.
  const byId = new Map(newSegments.map((seg) => [seg.id, seg]));
  return merged.map((seg, index) => {
    const base = byId.get(seg.id) || newSegments[index] || {};
    const speaker =
      !seg.speaker || seg.speaker === "you"
        ? seg.speaker
        : `cluster_${seg.speaker.replace(/^speaker_/, "")}`;
    return { ...base, ...seg, speaker, originCluster: speaker };
  });
}

function resolveClusterIds({ newSegments, oldSegments, identities, clusterEmbeddings, stored }) {
  const byEmbedding = matchClustersByEmbedding(clusterEmbeddings, stored);
  const resolved = matchClustersByOverlap(newSegments, oldSegments, byEmbedding);
  const taken = new Set([...identities.keys(), ...resolved.values()]);
  const nextFreshId = freshSpeakerIdFactory(taken);
  const freshByCluster = new Map();

  return newSegments.map((seg) => {
    if (!seg.speaker || seg.speaker === "you") return seg;
    let id = resolved.get(seg.speaker);
    if (!id) {
      if (!freshByCluster.has(seg.speaker)) freshByCluster.set(seg.speaker, nextFreshId());
      id = freshByCluster.get(seg.speaker);
    }
    return { ...seg, speaker: id };
  });
}

function persistSpeakerState({
  databaseManager,
  noteId,
  finalSegments,
  segmentsWithClusters,
  clusterEmbeddings,
  hadOldSegments,
}) {
  if (!databaseManager) return;

  const usedSpeakerIds = new Set(finalSegments.map((s) => s.speaker).filter(Boolean));

  // Rows for speakers that no longer exist keep the note looking unmapped forever and
  // let retroactive mapping mint mappings for ids that are not in the transcript.
  databaseManager.pruneNoteSpeakerEmbeddings?.(noteId, usedSpeakerIds);

  if (clusterEmbeddings) {
    const resolvedEmbeddings = {};
    for (const seg of segmentsWithClusters) {
      if (!seg.speaker || !seg.originCluster) continue;
      const embedding = clusterEmbeddings[seg.originCluster];
      if (embedding) resolvedEmbeddings[seg.speaker] = embedding;
    }
    if (Object.keys(resolvedEmbeddings).length) {
      databaseManager.saveNoteSpeakerEmbeddings?.(noteId, resolvedEmbeddings);
    }
  }

  // Without prior segments there is nothing to reconcile against, so mappings held over
  // from before a flattening would attach old names to arbitrary new clusters.
  if (!hadOldSegments) {
    for (const mapping of databaseManager.getSpeakerMappings?.(noteId) || []) {
      if (usedSpeakerIds.has(mapping.speaker_id)) {
        databaseManager.removeSpeakerMapping?.(noteId, mapping.speaker_id);
      }
    }
  }
}

async function retranscribeNoteTranscript({
  note,
  whisperManager,
  diarizationManager,
  databaseManager,
  convertToWav,
  model = "large",
  language = null,
  onSubStage = () => {},
  fileExists = fs.existsSync,
  readFile = fs.readFileSync,
  reloadNote = null,
  speakerEmbeddings = null,
}) {
  const modelPath = whisperManager.getModelPath(model);
  if (!fileExists(modelPath)) {
    debugLogger.warn(
      "Re-transcription skipped: whisper model not downloaded",
      { model, modelPath },
      "meeting"
    );
    return { outcome: "model-missing", transcript: null, text: null, reason: "model-missing" };
  }

  const oldSegments = withRanges(normalizeTimestamps(parseStoredSegments(note.transcript)));
  const oldSources = sourcesOf(oldSegments);

  const track = chooseTrack(note, oldSources, fileExists);
  if (!track) {
    // Refusing before transcription also saves a large-model pass over the whole meeting.
    debugLogger.info(
      "Re-transcription preserved: available audio cannot cover the transcript's sources",
      { noteId: note.id, sources: [...oldSources] },
      "meeting"
    );
    return {
      outcome: "preserved",
      transcript: null,
      text: null,
      reason: "incomplete-source-coverage",
    };
  }

  onSubStage("converting");
  const tmpWav = path.join(os.tmpdir(), `ow-retranscribe-${note.id}-${Date.now()}.wav`);
  await convertToWav(track.audioPath, tmpWav, { sampleRate: 16000, channels: 1 });

  try {
    onSubStage("transcribing");
    const result = await whisperManager.transcribeLocalWhisper(readFile(tmpWav), {
      model,
      language,
      includeSegments: true,
    });

    const text = result?.text || "";
    if (!text.trim()) throw new Error("Re-transcription produced empty output");

    if (!result?.segments?.length) {
      debugLogger.warn(
        "Re-transcription preserved: whisper returned no segment timestamps",
        { noteId: note.id },
        "meeting"
      );
      return { outcome: "preserved", transcript: null, text, reason: "no-segments" };
    }

    let newSegments = result.segments.map((seg, index) => ({
      id: `retranscribe-${index}`,
      text: seg.text,
      source: track.source,
      timestamp: seg.start,
      rangeStart: seg.start,
      rangeEnd:
        Number.isFinite(seg.end) && seg.end > seg.start ? seg.end : seg.start + SEGMENT_TAIL_SECONDS,
    }));

    let clusterEmbeddings = null;
    let diarized = false;

    if (track.source === "system" && diarizationManager?.isAvailable?.()) {
      onSubStage("diarizing");
      try {
        const diarizeResult = await diarizationManager.diarize(tmpWav, {});
        const diarizationSegments = diarizeResult?.segments || diarizeResult;
        if (diarizationSegments?.length) {
          const built = buildDiarizedSegments({
            newSegments,
            diarizationManager,
            diarizationSegments,
          });
          if (built) {
            newSegments = built;
            diarized = true;
            const rawIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
            clusterEmbeddings = await extractClusterEmbeddings({
              // Required here rather than at module load: it pulls in the ONNX worker,
              // and only the diarized path ever needs it.
              speakerEmbeddings: speakerEmbeddings || require("./speakerEmbeddings"),
              wavPath: tmpWav,
              diarizationSegments,
              clusterIdFor: (rawId) => `cluster_${rawIds.indexOf(rawId)}`,
            });
          }
        }
      } catch (err) {
        debugLogger.warn(
          "Re-transcription diarization failed, falling back to timestamp overlap",
          { noteId: note.id, error: err.message },
          "meeting"
        );
      }
    }

    // The renderer persists the live transcript asynchronously, so it can land while
    // this transcription is running. Match identities against what is on disk NOW.
    const freshNote = (reloadNote && reloadNote()) || note;
    const freshSegments = withRanges(normalizeTimestamps(parseStoredSegments(freshNote.transcript)));
    const freshSources = sourcesOf(freshSegments);
    if (freshSegments.length && !isCoveredBy(freshSources, track.source)) {
      debugLogger.info(
        "Re-transcription preserved: transcript changed under us and now spans more sources",
        { noteId: note.id, sources: [...freshSources] },
        "meeting"
      );
      return {
        outcome: "preserved",
        transcript: null,
        text,
        reason: "incomplete-source-coverage",
      };
    }
    const effectiveOldSegments = freshSegments.length ? freshSegments : oldSegments;

    const identities = collectIdentities(effectiveOldSegments);
    const stored = databaseManager?.getNoteSpeakerEmbeddings?.(note.id) || [];

    if (diarized) {
      newSegments = resolveClusterIds({
        newSegments,
        oldSegments: effectiveOldSegments,
        identities,
        clusterEmbeddings,
        stored,
      });
    } else if (track.source === "mic") {
      newSegments = newSegments.map((seg) => ({ ...seg, speaker: seg.speaker || "you" }));
    } else {
      newSegments = assignSpeakersByOverlap(newSegments, effectiveOldSegments);
    }

    // `end` is deliberately not persisted: the renderer's serializer drops it, and
    // SpeakerPanel divides (end - timestamp) by 1000, so a seconds-valued end would
    // render every speaker's talk time as near zero.
    const finalSegments = newSegments.map((seg) => {
      const { rangeStart, rangeEnd, end, originCluster, ...rest } = seg;
      const identity = seg.speaker ? identities.get(seg.speaker) : null;
      return identity ? { ...rest, ...identity } : rest;
    });

    persistSpeakerState({
      databaseManager,
      noteId: note.id,
      finalSegments,
      segmentsWithClusters: newSegments,
      clusterEmbeddings,
      hadOldSegments: effectiveOldSegments.length > 0,
    });

    return {
      outcome: "written",
      transcript: JSON.stringify(finalSegments),
      text,
      segments: finalSegments,
    };
  } finally {
    try {
      fs.unlinkSync(tmpWav);
    } catch (_) {}
  }
}

module.exports = { retranscribeNoteTranscript };
