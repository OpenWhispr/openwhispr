// Assigns each transcript line its own speaker from its voice, after diarization.
//
// The diarization turns (pyannote segmentation + clustering) decide the speakers
// and seed one voice per speaker from the lines that are long enough to be sure
// of. Every line is then compared with those voices: a short reply gets its own
// voice instead of inheriting its neighbour's turn. A line whose voice is no clear
// match keeps the best guess but stays provisional (speakerIsPlaceholder), so the
// user can reassign it; it is never pooled into a shared "unknown" speaker, which
// would blend several voices into one profile once named.
//
// Measured on four German recordings (an interview and three phone calls, 154
// lines) with the CAM++ zh-en advanced embeddings (EMBEDDING_VERSION 3): 79–100%
// of lines right versus 55–100% from the diarization turns alone, 16% marked
// provisional and 2% wrong but not marked. The thresholds below belong to that
// model; a different embedding model needs them measured again.

const { applyConfirmedSpeaker, applyProvisionalSpeaker } = require("./speakerAssignmentPolicy");

// A line with at least this much speech seeds its speaker's voice.
const SAFE_LINE_SECONDS = 2;
// Shorter lines are widened towards this length, into the pauses beside them only.
const SHORT_LINE_TARGET_SECONDS = 1.5;
const SHORT_LINE_MAX_EXTENSION_SECONDS = 0.6;
// Below this the voice says nothing; the line keeps its diarization speaker.
const MIN_EMBED_SECONDS = 0.5;
// A line without a known end runs to the next line, but never longer than this.
const OPEN_LINE_MAX_SECONDS = 10;
// Sure: the best voice leads the runner-up by MIN_LEAD and matches at least MIN_MATCH.
const MIN_LEAD = 0.15;
const MIN_MATCH = 0.45;
// A question answered within this gap hints that the answer is someone else's.
const QUESTION_ANSWER_GAP_SECONDS = 3;
const REFINE_ITERATIONS = 5;

const normalize = (vector) => {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm);
  if (!norm) return null;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
};

const dot = (a, b) => {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

const meanVoice = (vectors) => {
  const sum = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  return normalize(sum);
};

// The audio window each line's voice is read from.
function buildLineWindows(lines) {
  const ends = lines.map((line, i) => {
    const next = lines[i + 1]?.timestamp;
    const known = Number.isFinite(line.endTimestamp) && line.endTimestamp > line.timestamp;
    let end = known ? line.endTimestamp : line.timestamp + OPEN_LINE_MAX_SECONDS;
    if (Number.isFinite(next) && next > line.timestamp) end = Math.min(end, next);
    return end;
  });
  return lines.map((line, i) => {
    let start = line.timestamp;
    let end = ends[i];
    const speechSeconds = end - start;
    if (speechSeconds < SHORT_LINE_TARGET_SECONDS) {
      const prevEnd =
        i > 0 ? Math.min(ends[i - 1], start) : start - SHORT_LINE_MAX_EXTENSION_SECONDS;
      const next = lines[i + 1]?.timestamp;
      const nextStart = Number.isFinite(next)
        ? Math.max(next, end)
        : end + SHORT_LINE_MAX_EXTENSION_SECONDS;
      const need = (SHORT_LINE_TARGET_SECONDS - speechSeconds) / 2;
      start -= Math.min(need, SHORT_LINE_MAX_EXTENSION_SECONDS, start - prevEnd);
      end += Math.min(need, SHORT_LINE_MAX_EXTENSION_SECONDS, nextStart - end);
    }
    return { start: Math.max(0, start), end, speechSeconds };
  });
}

/**
 * @param {Array<object>} segments  merged transcript rows (timestamps in seconds
 *   from the start of the diarized audio), as mergeWithTranscript returns them
 * @param {object} options
 * @param {string} options.diarizedSource  "system" or "mic"
 * @param {(start: number, end: number) => Promise<Float32Array|null>} options.embedWindow
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ segments: Array<object>, voices: Map<string, Float32Array>, refined: boolean }>}
 */
async function assignSpeakersBySentence(segments, { diarizedSource, embedWindow, signal = null }) {
  const unchanged = { segments, voices: new Map(), refined: false };
  const indices = segments
    .map((segment, index) => ({ segment, index }))
    .filter(
      ({ segment }) =>
        segment.source === diarizedSource &&
        Number.isFinite(segment.timestamp) &&
        segment.speaker &&
        segment.speaker !== "you"
    )
    .sort((a, b) => a.segment.timestamp - b.segment.timestamp);
  if (indices.length === 0) return unchanged;

  const lines = indices.map(({ segment }) => segment);
  const windows = buildLineWindows(lines);

  const voices = [];
  for (const window of windows) {
    if (signal?.aborted) return unchanged;
    if (window.end - window.start < MIN_EMBED_SECONDS) {
      voices.push(null);
      continue;
    }
    let voice;
    try {
      const raw = await embedWindow(window.start, window.end);
      voice = raw ? normalize(raw) : null;
    } catch {
      // A failed extraction leaves the line to the diarization.
      voice = null;
    }
    voices.push(voice);
  }

  // Seed one voice per diarized speaker from its sure lines, then let the sure
  // lines move to the voice they match best. A speaker whose sure lines all move
  // was a split of another voice and disappears.
  const safe = lines
    .map((_, i) => i)
    .filter((i) => voices[i] && windows[i].speechSeconds >= SAFE_LINE_SECONDS);
  if (safe.length === 0) return unchanged;

  let groups = new Map();
  for (const i of safe) {
    const speaker = lines[i].speaker;
    if (!groups.has(speaker)) groups.set(speaker, []);
    groups.get(speaker).push(i);
  }
  let centroids = new Map(
    [...groups].map(([speaker, members]) => [speaker, meanVoice(members.map((i) => voices[i]))])
  );
  for (let iteration = 0; iteration < REFINE_ITERATIONS; iteration++) {
    const next = new Map();
    for (const i of safe) {
      let best = null;
      let bestSim = -Infinity;
      for (const [speaker, centroid] of centroids) {
        const sim = dot(voices[i], centroid);
        if (sim > bestSim) {
          bestSim = sim;
          best = speaker;
        }
      }
      if (!next.has(best)) next.set(best, []);
      next.get(best).push(i);
    }
    groups = next;
    centroids = new Map(
      [...groups].map(([speaker, members]) => [speaker, meanVoice(members.map((i) => voices[i]))])
    );
  }

  const rank = (voice) =>
    [...centroids]
      .map(([speaker, centroid]) => ({ speaker, sim: dot(voice, centroid) }))
      .sort((a, b) => b.sim - a.sim);

  const decided = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!voices[i]) {
      // Too short to hear who it is: the diarization's guess stays, marked provisional.
      decided.push({ speaker: line.speaker, sure: false });
      continue;
    }
    const ranked = rank(voices[i]);
    const best = ranked[0];
    const lead = best.sim - (ranked[1]?.sim ?? -1);
    const sure = lead >= MIN_LEAD && best.sim >= MIN_MATCH;
    if (sure || ranked.length < 2) {
      decided.push({ speaker: best.speaker, sure });
      continue;
    }
    // A close call: weigh the voice against the diarization turn and the
    // conversation (an answer right after a question is usually someone else's).
    const votes = new Map([[best.speaker, 1]]);
    if (centroids.has(line.speaker)) votes.set(line.speaker, (votes.get(line.speaker) || 0) + 1);
    const prev = lines[i - 1];
    const prevDecision = decided[i - 1];
    if (
      prev &&
      prevDecision &&
      /\?\s*$/.test(prev.text || "") &&
      line.timestamp - (windows[i - 1]?.end ?? prev.timestamp) <= QUESTION_ANSWER_GAP_SECONDS
    ) {
      const other = ranked.slice(0, 2).find((r) => r.speaker !== prevDecision.speaker);
      if (other) votes.set(other.speaker, (votes.get(other.speaker) || 0) + 1.5);
    }
    let guess = best.speaker;
    let guessVotes = votes.get(best.speaker);
    for (const [speaker, count] of votes) {
      if (count > guessVotes) {
        guess = speaker;
        guessVotes = count;
      }
    }
    decided.push({ speaker: guess, sure: false });
  }

  const out = segments.map((segment) => ({ ...segment }));
  indices.forEach(({ index }, i) => {
    const { speaker, sure } = decided[i];
    if (sure) {
      applyConfirmedSpeaker(out[index], { speaker, speakerIsPlaceholder: false });
    } else {
      applyProvisionalSpeaker(out[index], { speaker, speakerIsPlaceholder: true });
    }
  });

  // Each speaker's voice for profiles comes from its sure lines only, so a
  // guessed line never blends into the voice a name is later attached to.
  const sureVoices = new Map();
  decided.forEach(({ speaker, sure }, i) => {
    if (!sure || !voices[i] || windows[i].speechSeconds < SAFE_LINE_SECONDS) return;
    if (!sureVoices.has(speaker)) sureVoices.set(speaker, []);
    sureVoices.get(speaker).push(voices[i]);
  });
  const profileVoices = new Map(
    [...sureVoices].map(([speaker, list]) => [speaker, meanVoice(list)])
  );

  return { segments: out, voices: profileVoices, refined: true };
}

module.exports = {
  assignSpeakersBySentence,
  buildLineWindows,
  SAFE_LINE_SECONDS,
  MIN_LEAD,
  MIN_MATCH,
};
