// Clustering policy for uploaded files and meeting recordings. Kept free of
// electron imports so the rules stay unit-testable (pattern: cloudChunkPolicy).

// sherpa-onnx's cluster threshold is a cosine distance: higher merges more.
// Over a long recording one speaker's embeddings drift wider, so a constant
// tuned for short audio stops merging early (with the previous embedding model a
// 73-minute voice memo produced 46 "speakers"). Ramp the threshold with duration.
// The top stays below 0.72: from there up, a two-person Spanish call merged
// both speakers into one cluster.
// Values measured for the zh-en "advanced" CAM++ on human-labelled meetings:
// 0.6 kept clusters ~100% pure with ~1.3 clusters per person on 35-67 min calls,
// and 0.7 did the same (~1.1 per person) on an 88-minute 12-speaker call.
const DEFAULT_CLUSTER_THRESHOLD = 0.6;
const LONG_AUDIO_CLUSTER_THRESHOLD = 0.7;
const THRESHOLD_RAMP_START_SECONDS = 15 * 60;
const THRESHOLD_RAMP_END_SECONDS = 60 * 60;

// A cluster with under a second of total speech is embedding noise, not a
// person — and the character-proportional merge hands every surviving cluster
// at least one sentence, so each blip becomes a phantom [Speaker N].
const MIN_CLUSTER_TOTAL_SECONDS = 1;

// Longer recordings grow phantoms well past that floor: backchannels and turn
// starts whose 1–3 s embeddings land near neither speaker's centroid (a
// 20-minute two-person call produced four, holding 8 % of the speech). A
// phantom is both a sliver of the speech and made of short segments; a real
// minor speaker holds longer turns. Known cost: a real third participant with
// under 10 % of the speech in turns averaging under 3 s looks the same and is
// dropped too. Only their voice tells them apart, which this rule doesn't use.
const PHANTOM_MAX_SHARE = 0.1;
const PHANTOM_MAX_MEAN_SEGMENT_SECONDS = 3;
// Merging two real speakers is the worse failure, so the two largest clusters
// are never treated as phantoms.
const PROTECTED_CLUSTER_COUNT = 2;

// When clustering merges two real speakers, one cluster ends up with nearly
// all the speech beside phantoms of backchannels and turn starts: on every
// collapsed run of #2021's call the top held 94–96 % and each phantom
// averaged 1.7–2 s segments. Someone who asks questions, however short,
// averages longer segments, so an interview or a lecture with audience
// questions keeps its labels. Known cost: a listener who only backchannels
// beside a speaker holding over 93 % looks the same, and that run loses its
// labels. Clusters under the 1 s floor are noise and don't count, so a
// monologue with a stray blip isn't a collapse.
const COLLAPSED_TOP_SHARE = 0.93;
const COLLAPSED_MAX_MEAN_SEGMENT_SECONDS = 2.2;

// Clustering splits one voice into many clusters on meeting audio, but their
// voice centroids still match. With the zh-en CAM++ embeddings, 98 % of
// same-person centroid pairs scored 0.5 or more on AMI meetings (#2641), and
// 11 % of different-person pairs did too. Merging the closest pair first, by
// speech-weighted voice, still never left fewer speakers than there were, and
// 0.5 gave the right count on 12 of 15 recordings of 1-4 voices (0.55: 10,
// 0.6: 7).
const VOICE_MERGE_SIMILARITY = 0.5;
// Once no more voices are left than the user counted, two of them are merged
// only when they are near certain to be one person: under 1 % of voices had a
// different speaker at 0.7 or more (the live recluster bar).
const CERTAIN_VOICE_MERGE_SIMILARITY = 0.7;

// From this similarity up, a post-call voice (the centroid of a cluster's
// longest segments) is a stored profile's person, provided that profile also
// leads the next closest by PROFILE_MATCH_LEAD. Measured with the zh-en CAM++
// on labelled meetings: 90 % of voices named, none wrongly. Matching a voice to
// a live speaker reuses the similarity; that pairing wasn't measured.
const VOICE_MATCH_SIMILARITY = 0.6;
const PROFILE_MATCH_LEAD = 0.03;
// A closest profile short of a match is only offered for the user to confirm.
// Carried over from the previous embedding model, not measured for this one.
const PROFILE_SUGGESTION_SIMILARITY = 0.5;

function clusterThresholdForDuration(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= THRESHOLD_RAMP_START_SECONDS) {
    return DEFAULT_CLUSTER_THRESHOLD;
  }
  if (durationSeconds >= THRESHOLD_RAMP_END_SECONDS) return LONG_AUDIO_CLUSTER_THRESHOLD;
  const progress =
    (durationSeconds - THRESHOLD_RAMP_START_SECONDS) /
    (THRESHOLD_RAMP_END_SECONDS - THRESHOLD_RAMP_START_SECONDS);
  return (
    DEFAULT_CLUSTER_THRESHOLD +
    (LONG_AUDIO_CLUSTER_THRESHOLD - DEFAULT_CLUSTER_THRESHOLD) * progress
  );
}

function resolveClusterThreshold(durationSeconds, requestedThreshold) {
  const automaticThreshold = clusterThresholdForDuration(durationSeconds);
  if (requestedThreshold == null || requestedThreshold === "") return automaticThreshold;
  const parsedThreshold = Number(requestedThreshold);
  if (!Number.isFinite(parsedThreshold)) return automaticThreshold;
  return Math.min(1, Math.max(0, parsedThreshold));
}

function summarizeClusters(segments) {
  const clusters = new Map();
  let totalSpeech = 0;
  for (const s of segments) {
    const cluster = clusters.get(s.speaker) || { total: 0, count: 0 };
    cluster.total += s.end - s.start;
    cluster.count += 1;
    clusters.set(s.speaker, cluster);
    totalSpeech += s.end - s.start;
  }
  return { clusters, totalSpeech };
}

// `voiced` holds the clusters with a readable voice. Callers that cap the
// result at a known speaker count pass it: a voice of its own is what tells a
// quiet participant from a phantom, and the cap bounds how many are kept.
function dropNegligibleClusters(
  segments,
  { protectedCount = PROTECTED_CLUSTER_COUNT, voiced = null } = {}
) {
  if (!segments?.length) return segments;
  const { clusters, totalSpeech } = summarizeClusters(segments);
  const keep = new Set(
    [...clusters]
      .sort((a, b) => b[1].total - a[1].total)
      .filter(([speaker, { total, count }], rank) => {
        if (total < MIN_CLUSTER_TOTAL_SECONDS) return false;
        return (
          rank < protectedCount ||
          voiced?.has(speaker) ||
          total / totalSpeech >= PHANTOM_MAX_SHARE ||
          total / count >= PHANTOM_MAX_MEAN_SEGMENT_SECONDS
        );
      })
      .map(([speaker]) => speaker)
  );
  if (keep.size === 0 || keep.size === clusters.size) return segments;
  return segments.filter((s) => keep.has(s.speaker));
}

function isCollapsedDiarization(segments) {
  const { clusters } = summarizeClusters(segments);
  const heard = [...clusters.values()].filter(({ total }) => total >= MIN_CLUSTER_TOTAL_SECONDS);
  if (heard.length < 2) return false;
  const [largest, ...rest] = heard.sort((a, b) => b.total - a.total);
  const heardSpeech = heard.reduce((sum, { total }) => sum + total, 0);
  return (
    largest.total / heardSpeech > COLLAPSED_TOP_SHARE &&
    rest.every(({ total, count }) => total / count < COLLAPSED_MAX_MEAN_SEGMENT_SECONDS)
  );
}

// Merges clusters that share a voice, closest pair first, until no two voices
// reach VOICE_MERGE_SIMILARITY. A merged voice is the speech-weighted mean, and
// the larger cluster keeps its label. Clusters without a centroid stay as they
// are. `countedVoices` is how many voices the user said there are: down to that
// many, only pairs at CERTAIN_VOICE_MERGE_SIMILARITY still merge, so two of
// the people counted aren't folded into one for sounding alike.
function mergeClustersByVoice(segments, centroids, similarity, countedVoices = 0) {
  const { clusters } = summarizeClusters(segments);
  const groups = [...clusters]
    .filter(([speaker]) => centroids.has(speaker))
    .map(([speaker, { total }]) => ({
      speaker,
      total,
      voice: centroids.get(speaker),
      members: [speaker],
    }));

  for (;;) {
    const mergeSimilarity =
      groups.length > countedVoices ? VOICE_MERGE_SIMILARITY : CERTAIN_VOICE_MERGE_SIMILARITY;
    let closest = null;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const score = similarity(groups[i].voice, groups[j].voice);
        if (score >= mergeSimilarity && (!closest || score > closest.score)) {
          closest = { i, j, score };
        }
      }
    }
    if (!closest) break;

    const [keep, extra] =
      groups[closest.i].total >= groups[closest.j].total
        ? [groups[closest.i], groups[closest.j]]
        : [groups[closest.j], groups[closest.i]];
    const total = keep.total + extra.total;
    keep.voice = keep.voice.map(
      (value, k) => (value * keep.total + extra.voice[k] * extra.total) / total
    );
    keep.total = total;
    keep.members.push(...extra.members);
    groups.splice(groups.indexOf(extra), 1);
  }

  const relabel = new Map();
  for (const { speaker, members } of groups) {
    for (const member of members) {
      if (member !== speaker) relabel.set(member, speaker);
    }
  }
  if (relabel.size === 0) return segments;
  return segments.map((s) =>
    relabel.has(s.speaker) ? { ...s, speaker: relabel.get(s.speaker) } : s
  );
}

// The stored profile closest to a voice, as { profile, confirmed }: confirmed
// when it is a match, otherwise a suggestion. null when none is close enough.
// `profileVoices` pairs each profile with its voice.
function matchVoiceToProfile(voice, profileVoices, similarity) {
  let best = null;
  let bestScore = 0;
  let runnerUpScore = 0;
  for (const { profile, voice: profileVoice } of profileVoices) {
    const score = similarity(voice, profileVoice);
    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      best = profile;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }
  if (!best || bestScore <= PROFILE_SUGGESTION_SIMILARITY) return null;
  const confirmed =
    bestScore > VOICE_MATCH_SIMILARITY && bestScore - runnerUpScore >= PROFILE_MATCH_LEAD;
  return { profile: best, confirmed };
}

// A cluster without a readable voice can't be told from clustering's split of
// someone else's, so voiced clusters take the `cap` slots first. Voiceless ones
// keep the slots left over, largest first; the rest are dropped, and their
// lines go to the speaker nearest in time. With no voice at all, nothing is
// dropped.
function dropVoicelessClustersOverCap(segments, cap, centroids) {
  const { clusters } = summarizeClusters(segments);
  const voiceless = [...clusters]
    .filter(([speaker]) => !centroids.has(speaker))
    .sort((a, b) => b[1].total - a[1].total)
    .map(([speaker]) => speaker);
  const voicedCount = clusters.size - voiceless.length;
  if (voicedCount === 0) return segments;

  const dropped = new Set(voiceless.slice(Math.max(0, cap - voicedCount)));
  if (dropped.size === 0) return segments;
  return segments.filter((s) => !dropped.has(s.speaker));
}

// Keeps the `cap` largest clusters and relabels each extra one to the kept
// speaker whose voice centroid it is most similar to. Folding extras into the
// largest cluster handed one person's turns to the other whenever clustering
// split a real speaker. Clusters without a centroid still fold into the
// largest.
function capSpeakerClustersByVoice(segments, cap, centroids, similarity) {
  const { clusters } = summarizeClusters(segments);
  if (clusters.size <= cap) return segments;

  const ranked = [...clusters].sort((a, b) => b[1].total - a[1].total).map(([speaker]) => speaker);
  const kept = ranked.slice(0, cap);
  const relabel = new Map();
  for (const extra of ranked.slice(cap)) {
    const voice = centroids.get(extra);
    let target = kept[0];
    let bestSimilarity = -Infinity;
    if (voice) {
      for (const speaker of kept) {
        const keptVoice = centroids.get(speaker);
        if (!keptVoice) continue;
        const score = similarity(voice, keptVoice);
        if (score > bestSimilarity) {
          bestSimilarity = score;
          target = speaker;
        }
      }
    }
    relabel.set(extra, target);
  }
  return segments.map((s) =>
    relabel.has(s.speaker) ? { ...s, speaker: relabel.get(s.speaker) } : s
  );
}

module.exports = {
  DEFAULT_CLUSTER_THRESHOLD,
  LONG_AUDIO_CLUSTER_THRESHOLD,
  THRESHOLD_RAMP_START_SECONDS,
  THRESHOLD_RAMP_END_SECONDS,
  MIN_CLUSTER_TOTAL_SECONDS,
  VOICE_MATCH_SIMILARITY,
  clusterThresholdForDuration,
  resolveClusterThreshold,
  dropNegligibleClusters,
  isCollapsedDiarization,
  mergeClustersByVoice,
  matchVoiceToProfile,
  dropVoicelessClustersOverCap,
  capSpeakerClustersByVoice,
};
